/**
 * Configuration the owner edits in the bot: sites, devices, settings, message texts, user aliases.
 * Loaded once per request into env.CFG, so the rest of the code reads it synchronously.
 */

import { DEFAULT_TZ } from './config.js';
import { db } from './db.js';
import { setTimeZone } from './util.js';

const parse = (s) => {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
};

/**
 * Reads the configuration into env.CFG and applies the time zone.
 * Call again after changing it within the same request.
 * @param {import('./config.js').Env} env
 */
export async function loadConfig(env) {
  const D = await db(env);
  const devices = (await D.prepare('SELECT * FROM devices ORDER BY sort, rowid').all()).results.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    icon: r.icon,
    site: r.site,
    params: parse(r.params),
    auto: r.auto !== 0,
  }));
  // A site reads the grid through its source inverter; the inverter's cloud details are
  // copied onto the site so the automation does not need to look them up.
  const sites = (await D.prepare('SELECT * FROM sites ORDER BY sort, rowid').all()).results.map((r, i) => {
    const src = devices.find((d) => d.id === r.source && d.type === 'inverter');
    return {
      id: r.id,
      name: r.name,
      source: src?.id || null,
      inverter: src?.params.cloud || null,
      account: Number(src?.params.account) || 1,
      params: src ? src.params : {},
      primary: i === 0,
    };
  });
  const settings = Object.fromEntries(
    (await D.prepare("SELECT k, v FROM kv WHERE k LIKE 'cfg.%'").all()).results.map((r) => [r.k.slice(4), r.v])
  );
  const templates = Object.fromEntries(
    (await D.prepare('SELECT k, text FROM templates').all()).results.map((r) => [r.k, r.text])
  );
  env.CFG = { sites, devices, settings, templates };
  setTimeZone(settings.tz || env.TZ || DEFAULT_TZ);
  return env.CFG;
}

/** Short technical id: "s1", "s2" … / "d1" … — never shown, never changed. */
async function nextId(env, table, prefix) {
  const { results } = await (await db(env)).prepare(`SELECT id FROM ${table}`).all();
  const taken = new Set(results.map((r) => r.id));
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

async function nextSort(env) {
  const D = await db(env);
  const a = await D.prepare('SELECT max(sort) m FROM sites').first();
  const b = await D.prepare('SELECT max(sort) m FROM devices').first();
  return Math.max(Number(a?.m) || 0, Number(b?.m) || 0) + 1;
}

/* ---------- sites ---------- */

/** @returns {Promise<string>} id of the new site */
export async function addSite(env, { name }) {
  const id = await nextId(env, 'sites', 's');
  await (
    await db(env)
  )
    .prepare("INSERT INTO sites (id,name,account,params,sort) VALUES (?,?,1,'{}',?)")
    .bind(id, name, await nextSort(env))
    .run();
  await loadConfig(env);
  return id;
}

/** @param {{name?: string, source?: string | null}} fields */
export async function updateSite(env, id, fields) {
  const D = await db(env);
  if (fields.name !== undefined) await D.prepare('UPDATE sites SET name=? WHERE id=?').bind(fields.name, id).run();
  if (fields.source !== undefined)
    await D.prepare('UPDATE sites SET source=? WHERE id=?').bind(fields.source, id).run();
  await loadConfig(env);
}

/** Removes a site, its devices and everyone's access to them. History stays in the log. */
export async function deleteSite(env, id) {
  const D = await db(env);
  const devs = (await D.prepare('SELECT id FROM devices WHERE site=?').bind(id).all()).results.map((r) => r.id);
  for (const d of devs) await deleteDevice(env, d, false);
  await D.prepare('DELETE FROM sites WHERE id=?').bind(id).run();
  await D.prepare('DELETE FROM user_devices WHERE device=?').bind(`site.${id}`).run();
  await loadConfig(env);
}

/* ---------- devices ---------- */

/** @returns {Promise<string>} id of the new device */
export async function addDevice(env, { type, name, icon, site, params = {}, auto = true }) {
  const D = await db(env);
  // The first boiler takes the historical id, so its state keys and history stay where they were.
  const free = !(await D.prepare("SELECT 1 FROM devices WHERE id='boiler'").first());
  const id = type === 'midea_boiler' && free ? 'boiler' : await nextId(env, 'devices', 'd');
  await D.prepare('INSERT INTO devices (id,type,name,icon,site,params,auto,sort) VALUES (?,?,?,?,?,?,?,?)')
    .bind(id, type, name, icon, site, JSON.stringify(params), auto ? 1 : 0, await nextSort(env))
    .run();
  await loadConfig(env);
  return id;
}

/**
 * Every site reads its grid from one of its own inverters: after an inverter is moved or
 * removed, a site left without one takes its first remaining inverter.
 */
async function fixSources(D) {
  await D.prepare(
    `UPDATE sites SET source = (SELECT d.id FROM devices d WHERE d.type='inverter' AND d.site=sites.id ORDER BY d.sort, d.rowid LIMIT 1)
     WHERE source IS NULL OR source NOT IN (SELECT d.id FROM devices d WHERE d.type='inverter' AND d.site=sites.id)`
  ).run();
}

export async function updateDevice(env, id, fields) {
  const D = await db(env);
  for (const [k, v] of Object.entries(fields)) {
    if (!['name', 'icon', 'site', 'auto'].includes(k)) continue;
    await D.prepare(`UPDATE devices SET ${k}=? WHERE id=?`)
      .bind(k === 'auto' ? (v ? 1 : 0) : v, id)
      .run();
  }
  if (fields.site !== undefined) await fixSources(D);
  await loadConfig(env);
}

export async function deleteDevice(env, id, reload = true) {
  const D = await db(env);
  await D.prepare('DELETE FROM devices WHERE id=?').bind(id).run();
  await fixSources(D);
  await D.prepare('DELETE FROM user_devices WHERE device=?').bind(id).run();
  if (reload) await loadConfig(env);
}

/* ---------- settings, message texts, aliases ---------- */

export async function setSetting(env, key, value) {
  await (
    await db(env)
  )
    .prepare('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
    .bind(`cfg.${key}`, String(value))
    .run();
  await loadConfig(env);
}

/** @param {string | null} text null restores the standard text */
export async function setTemplate(env, key, text) {
  const D = await db(env);
  if (text === null) await D.prepare('DELETE FROM templates WHERE k=?').bind(key).run();
  else {
    await D.prepare('INSERT INTO templates (k,text) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET text=excluded.text')
      .bind(key, text)
      .run();
  }
  await loadConfig(env);
}

/** @param {string | null} alias null returns to the Telegram name */
export async function setAlias(env, chatId, alias) {
  await (await db(env)).prepare('UPDATE users SET alias=? WHERE chat_id=?').bind(alias, chatId).run();
}

/** Name used in messages: the alias the admin set, otherwise the Telegram name. */
export const displayName = (u) => u?.alias || u?.name || u?.username || String(u?.chat_id ?? '');
