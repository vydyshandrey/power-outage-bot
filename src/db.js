/**
 * Storage on Cloudflare D1: key-value state, users, permissions, event log, and the
 * configuration the owner sets in the bot (sites, devices, message texts, settings).
 * The schema is created lazily on first use, so a fresh database needs no setup.
 */

import { LEVELS, RANK, deviceSite, legacyDevices, legacySites, siteKey, siteTree, sitesOf } from './config.js';
import { now } from './util.js';

/** Exported for tests, which start from an empty in-memory database. */
export const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)',
  'CREATE TABLE IF NOT EXISTS users (chat_id INTEGER PRIMARY KEY, name TEXT, username TEXT, role TEXT, status TEXT, created INTEGER)',
  'CREATE TABLE IF NOT EXISTS user_devices (chat_id INTEGER, device TEXT, perm TEXT, PRIMARY KEY (chat_id, device))',
  'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, device TEXT, actor TEXT, data TEXT)',
  'CREATE INDEX IF NOT EXISTS events_dev_ts ON events (device, ts)',
  'CREATE TABLE IF NOT EXISTS energy (ts INTEGER PRIMARY KEY, grid INTEGER, volt REAL, load INTEGER, batt INTEGER, soc INTEGER)',
  'CREATE TABLE IF NOT EXISTS sites (id TEXT PRIMARY KEY, name TEXT, cloud TEXT, account INTEGER, params TEXT, sort INTEGER)',
  'CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, type TEXT, name TEXT, icon TEXT, site TEXT, params TEXT, auto INTEGER, sort INTEGER)',
  'CREATE TABLE IF NOT EXISTS templates (k TEXT PRIMARY KEY, text TEXT)',
];

/** Databases already prepared in this isolate. */
const ready = new WeakSet();

/**
 * Returns the D1 binding, creating the schema and migrating on first use in this isolate.
 * @param {import('./config.js').Env} env
 */
export async function db(env) {
  if (!ready.has(env.DB)) {
    ready.add(env.DB);
    await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
    await migrate(env);
  }
  return env.DB;
}

/**
 * Data history:
 *   v2 (1.1.0) per-device permissions;
 *   v3 (1.4.0) sites — everyone who got grid notifications keeps them for the first site;
 *   v4 (1.5.0) two roles and per-site levels — "control" users control the first site,
 *              "notify" users see it; a device row becomes a limit below the site level;
 *   v5 (1.6.0) configuration moves from wrangler.toml into the database, where the owner
 *              edits it in the bot; users get an alias column;
 *   v6 (1.7.0) inverters become devices of their sites; a site points at its grid source.
 */
export async function migrate(env) {
  const D = env.DB;
  const row = await D.prepare("SELECT v FROM kv WHERE k='schema_v'").first();
  const v = Number(row?.v) || 0;
  if (v >= 6) return;
  if (v < 4) await migrateRoles(env);
  if (v < 5) await migrateConfig(env);
  await migrateInverters(env);
  await D.prepare("INSERT INTO kv (k,v) VALUES ('schema_v','6') ON CONFLICT(k) DO UPDATE SET v=excluded.v").run();
}

/** v6: an inverter is a device of its site; the site names which inverter tells it about the grid. */
async function migrateInverters(env) {
  const D = env.DB;
  const cols = (await D.prepare('PRAGMA table_info(sites)').all()).results.map((c) => c.name);
  if (!cols.includes('source')) await D.prepare('ALTER TABLE sites ADD COLUMN source TEXT').run();
  const { results } = await D.prepare("SELECT * FROM sites WHERE cloud IS NOT NULL AND cloud != ''").all();
  let n = 0;
  for (const s of results) {
    const params = { cloud: s.cloud, account: Number(s.account) || 1, ...JSON.parse(s.params || '{}') };
    let id;
    do id = `i${++n}`;
    while (await D.prepare('SELECT 1 FROM devices WHERE id=?').bind(id).first());
    await D.prepare('INSERT INTO devices (id,type,name,icon,site,params,auto,sort) VALUES (?,?,?,?,?,?,?,?)')
      .bind(id, 'inverter', 'Інвертор', '⚡', s.id, JSON.stringify(params), 0, s.sort)
      .run();
    await D.prepare("UPDATE sites SET source=?, cloud=NULL, params='{}' WHERE id=?").bind(id, s.id).run();
  }
}

/** v4: old roles become levels on the first site, nobody loses access. */
async function migrateRoles(env) {
  const D = env.DB;
  const first = sitesOf(env)[0];
  if (!first) return;
  const home = siteKey(first);
  const { results } = await D.prepare("SELECT * FROM users WHERE status='approved' AND role != 'admin'").all();
  for (const u of results) {
    const perms = Object.fromEntries(
      (await D.prepare('SELECT device, perm FROM user_devices WHERE chat_id=?').bind(u.chat_id).all()).results.map(
        (r) => [r.device, r.perm]
      )
    );
    // The first site gets the highest of: what the role allowed, what the boiler allowed.
    const fromRole = u.role === 'control' ? 'control' : 'view';
    const level = LEVELS.indexOf(perms.boiler || 'none') > LEVELS.indexOf(fromRole) ? perms.boiler : fromRole;
    await setPerm(env, u.chat_id, home, level);
    // The boiler keeps a row only if it was below that level; otherwise it simply follows the site.
    if (perms.boiler && LEVELS.indexOf(perms.boiler) < LEVELS.indexOf(level)) {
      await setPerm(env, u.chat_id, 'boiler', perms.boiler);
    } else await clearPerm(env, u.chat_id, 'boiler');
    await D.prepare("UPDATE users SET role='user' WHERE chat_id=?").bind(u.chat_id).run();
  }
}

/** v5: sites, devices and the time zone from wrangler.toml become rows the owner edits in the bot. */
async function migrateConfig(env) {
  const D = env.DB;
  const cols = (await D.prepare('PRAGMA table_info(users)').all()).results.map((c) => c.name);
  if (!cols.includes('alias')) await D.prepare('ALTER TABLE users ADD COLUMN alias TEXT').run();

  if (!(await D.prepare('SELECT 1 FROM sites LIMIT 1').first())) {
    let sort = 0;
    for (const s of legacySites(env)) {
      await D.prepare('INSERT INTO sites (id,name,cloud,account,params,sort) VALUES (?,?,?,?,?,?)')
        .bind(s.id, s.name, s.inverter, s.account, JSON.stringify(s.params), sort++)
        .run();
    }
    for (const d of legacyDevices(env)) {
      await D.prepare('INSERT INTO devices (id,type,name,icon,site,params,auto,sort) VALUES (?,?,?,?,?,?,?,?)')
        .bind(d.id, d.type, d.name, d.icon, d.site, JSON.stringify(d.params), d.auto ? 1 : 0, sort++)
        .run();
    }
  }
  if (env.TZ) await D.prepare("INSERT OR IGNORE INTO kv (k,v) VALUES ('cfg.tz',?)").bind(env.TZ).run();
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
  const site = deviceSite(env, key);
  if (!site) return 'none';
  const siteLevel = (await row(env, user.chat_id, siteKey(site))) || 'none';
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
  const first = sitesOf(env)[0];
  if (first) await setPerm(env, chatId, siteKey(first), 'view');
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
