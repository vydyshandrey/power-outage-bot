/**
 * Storage on Cloudflare D1: key-value state, users, per-device permissions, event log.
 * The schema is created lazily on first use, so a fresh database needs no setup.
 */

import { RANK, permTargets, siteKey, sitesOf } from './config.js';
import { now } from './util.js';

/** Exported for tests, which start from an empty in-memory database. */
export const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)',
  'CREATE TABLE IF NOT EXISTS users (chat_id INTEGER PRIMARY KEY, name TEXT, username TEXT, role TEXT, status TEXT, created INTEGER)',
  'CREATE TABLE IF NOT EXISTS user_devices (chat_id INTEGER, device TEXT, perm TEXT, PRIMARY KEY (chat_id, device))',
  'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, device TEXT, actor TEXT, data TEXT)',
  'CREATE INDEX IF NOT EXISTS events_dev_ts ON events (device, ts)',
  'CREATE TABLE IF NOT EXISTS energy (ts INTEGER PRIMARY KEY, grid INTEGER, volt REAL, load INTEGER, batt INTEGER, soc INTEGER)',
];

let schemaReady = false;

/**
 * Returns the D1 binding, creating the schema on first call in this isolate.
 * @param {import('./config.js').Env} env
 */
export async function db(env) {
  if (!schemaReady) {
    await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
    schemaReady = true;
    await migrate(env);
  }
  return env.DB;
}

/**
 * v2 (1.1.0): per-device permissions — existing users get their role defaults.
 * v3 (1.4.0): sites — everyone who got grid notifications keeps getting them for the first site.
 */
export async function migrate(env) {
  const D = env.DB;
  const row = await D.prepare("SELECT v FROM kv WHERE k='schema_v'").first();
  const v = Number(row?.v) || 0;
  if (v >= 3) return;
  const { results } = await D.prepare("SELECT * FROM users WHERE status='approved' AND role != 'admin'").all();
  for (const u of results) {
    if (v < 2) await setDefaultPerms(env, u.chat_id, u.role, false);
    await D.prepare('INSERT OR IGNORE INTO user_devices (chat_id,device,perm) VALUES (?,?,?)')
      .bind(u.chat_id, siteKey(sitesOf(env)[0]), 'view')
      .run();
  }
  await D.prepare("INSERT INTO kv (k,v) VALUES ('schema_v','3') ON CONFLICT(k) DO UPDATE SET v=excluded.v").run();
}

/* ---------- key-value state ---------- */

/** @returns {Promise<string | null>} */
export async function kvGet(env, k) {
  const r = await (await db(env)).prepare('SELECT v FROM kv WHERE k=?').bind(k).first();
  return r ? r.v : null;
}

export async function kvSet(env, k, v) {
  await (
    await db(env)
  )
    .prepare('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
    .bind(k, String(v))
    .run();
}

/* ---------- users ---------- */

export async function getUser(env, chatId) {
  return (await db(env)).prepare('SELECT * FROM users WHERE chat_id=?').bind(chatId).first();
}

/** Approved users with at least the given role. */
export async function usersBy(env, minRole) {
  const { results } = await (await db(env)).prepare("SELECT * FROM users WHERE status='approved'").all();
  return results.filter((u) => RANK[u.role] >= RANK[minRole]);
}

/* ---------- per-device permissions ---------- */

/** @returns {Promise<'none' | 'view' | 'control'>} */
export async function getPerm(env, user, dev) {
  if (!user || user.status !== 'approved') return 'none';
  if (user.role === 'admin') return 'control';
  const r = await (
    await db(env)
  )
    .prepare('SELECT perm FROM user_devices WHERE chat_id=? AND device=?')
    .bind(user.chat_id, dev)
    .first();
  return r ? r.perm : 'none';
}

export async function setPerm(env, chatId, dev, perm) {
  await (
    await db(env)
  )
    .prepare(
      'INSERT INTO user_devices (chat_id,device,perm) VALUES (?,?,?) ON CONFLICT(chat_id,device) DO UPDATE SET perm=excluded.perm'
    )
    .bind(chatId, dev, perm)
    .run();
}

/**
 * Role defaults: "control" may operate devices, others may view them. Of the sites only the
 * first is visible by default; an admin opens the others to the people who need them.
 * @param {boolean} overwrite false keeps permissions that were set explicitly
 */
export async function setDefaultPerms(env, chatId, role, overwrite = true) {
  for (const [dev, t] of Object.entries(permTargets(env))) {
    const perm = t.kind === 'site' ? (t.site.primary ? 'view' : 'none') : role === 'control' ? 'control' : 'view';
    if (!overwrite) {
      const r = await env.DB.prepare('SELECT perm FROM user_devices WHERE chat_id=? AND device=?')
        .bind(chatId, dev)
        .first();
      if (r) continue;
    }
    await setPerm(env, chatId, dev, perm);
  }
}

/** Configured devices (not sites) the user may at least view. */
export async function viewableDevices(env, user) {
  const out = [];
  for (const [dev, t] of Object.entries(permTargets(env))) {
    if (t.kind === 'device' && (await getPerm(env, user, dev)) !== 'none') out.push(dev);
  }
  return out;
}

/** Sites whose status and notifications the user may see. */
export async function viewableSites(env, user) {
  const out = [];
  for (const site of sitesOf(env)) if ((await getPerm(env, user, siteKey(site))) !== 'none') out.push(site);
  return out;
}

/* ---------- event log ---------- */

export async function logEvent(env, type, device, actor, data = null) {
  await (
    await db(env)
  )
    .prepare('INSERT INTO events (ts,type,device,actor,data) VALUES (?,?,?,?,?)')
    .bind(now(), type, device, actor, data ? JSON.stringify(data) : null)
    .run();
}

/** Stores an inverter reading once per logger timestamp. */
export async function logEnergy(env, d) {
  await (
    await db(env)
  )
    .prepare('INSERT OR IGNORE INTO energy (ts,grid,volt,load,batt,soc) VALUES (?,?,?,?,?,?)')
    .bind(d.ts, d.grid ? 1 : 0, d.volt, d.load, d.batt, d.soc)
    .run();
}
