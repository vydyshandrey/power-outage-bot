/**
 * Storage on Cloudflare D1: key-value state, users, per-device permissions, event log.
 * The schema is created lazily on first use, so a fresh database needs no setup.
 */

import { DEVICES, LEVELS, RANK, deviceSite, siteKey, siteTree, sitesOf } from './config.js';
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
 * Permission history:
 *   v2 (1.1.0) per-device permissions;
 *   v3 (1.4.0) sites — everyone who got grid notifications keeps them for the first site;
 *   v4 (1.5.0) two roles and per-site levels — "control" users control the first site,
 *              "notify" users see it; a device row becomes a limit below the site level.
 */
export async function migrate(env) {
  const D = env.DB;
  const row = await D.prepare("SELECT v FROM kv WHERE k='schema_v'").first();
  if ((Number(row?.v) || 0) >= 4) return;
  const home = siteKey(sitesOf(env)[0]);
  const { results } = await D.prepare("SELECT * FROM users WHERE status='approved' AND role != 'admin'").all();
  for (const u of results) {
    const perms = Object.fromEntries(
      (await D.prepare('SELECT device, perm FROM user_devices WHERE chat_id=?').bind(u.chat_id).all()).results.map(
        (r) => [r.device, r.perm]
      )
    );
    // The first site gets the highest of: what the role allowed, what any of its devices allowed.
    const fromRole = u.role === 'control' ? 'control' : 'view';
    const fromDevices = Object.keys(DEVICES).map((d) => perms[d] || 'none');
    const level = [fromRole, ...fromDevices].reduce((a, b) => (LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a));
    await setPerm(env, u.chat_id, home, level);
    // A device keeps a row only if it was below that level; otherwise it simply follows the site.
    for (const d of Object.keys(DEVICES)) {
      if (perms[d] && LEVELS.indexOf(perms[d]) < LEVELS.indexOf(level)) await setPerm(env, u.chat_id, d, perms[d]);
      else await clearPerm(env, u.chat_id, d);
    }
    await D.prepare("UPDATE users SET role='user' WHERE chat_id=?").bind(u.chat_id).run();
  }
  await D.prepare("INSERT INTO kv (k,v) VALUES ('schema_v','4') ON CONFLICT(k) DO UPDATE SET v=excluded.v").run();
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

/** Approved users with at least the given role ("user" or "admin"). */
export async function usersBy(env, minRole) {
  const { results } = await (await db(env)).prepare("SELECT * FROM users WHERE status='approved'").all();
  return results.filter((u) => RANK[u.role] >= RANK[minRole]);
}

/* ---------- permissions: a level per site, optional limits per device ---------- */

const minLevel = (a, b) => (LEVELS.indexOf(a) <= LEVELS.indexOf(b) ? a : b);

async function row(env, chatId, key) {
  const r = await (
    await db(env)
  )
    .prepare('SELECT perm FROM user_devices WHERE chat_id=? AND device=?')
    .bind(chatId, key)
    .first();
  return r ? r.perm : null;
}

/**
 * Effective access to a site ("site.<id>") or a device. A device gets its site's level,
 * lowered by the device's own limit if there is one.
 * @returns {Promise<'none' | 'view' | 'control'>}
 */
export async function getPerm(env, user, key) {
  if (!user || user.status !== 'approved') return 'none';
  if (user.role === 'admin') return 'control';
  if (key.startsWith('site.')) return (await row(env, user.chat_id, key)) || 'none';
  const siteLevel = (await row(env, user.chat_id, siteKey(deviceSite(env, key)))) || 'none';
  const limit = await row(env, user.chat_id, key);
  return limit ? minLevel(siteLevel, limit) : siteLevel;
}

/** A device's own limit, or null when it follows its site. */
export const deviceLimit = (env, user, dev) => row(env, user.chat_id, dev);

export async function setPerm(env, chatId, key, perm) {
  await (
    await db(env)
  )
    .prepare(
      'INSERT INTO user_devices (chat_id,device,perm) VALUES (?,?,?) ON CONFLICT(chat_id,device) DO UPDATE SET perm=excluded.perm'
    )
    .bind(chatId, key, perm)
    .run();
}

/** Removes a device limit (the device follows its site again). */
export async function clearPerm(env, chatId, key) {
  await (await db(env)).prepare('DELETE FROM user_devices WHERE chat_id=? AND device=?').bind(chatId, key).run();
}

/** A newly approved user sees the first site; everything else the admin opens explicitly. */
export async function resetPerms(env, chatId) {
  await (await db(env)).prepare('DELETE FROM user_devices WHERE chat_id=?').bind(chatId).run();
  await setPerm(env, chatId, siteKey(sitesOf(env)[0]), 'view');
}

/** Configured devices the user may at least view. */
export async function viewableDevices(env, user) {
  const out = [];
  for (const { devices } of siteTree(env)) {
    for (const dev of devices) if ((await getPerm(env, user, dev)) !== 'none') out.push(dev);
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
