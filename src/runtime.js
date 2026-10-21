/**
 * "How long will the battery last?" — worked out by code, never by the model.
 *
 * Two ways, either works for any inverter cloud:
 *   capacity — the site's battery capacity (kWh, ⚙️ → object) × charge ÷ current discharge;
 *   rate     — how fast the charge has been falling during the current outage, from the
 *              stored readings; needs no capacity, but at least RATE_MIN_SEC and RATE_MIN_DROP %.
 * With neither, the answer says what is missing, so a person (or the assistant) can tell why.
 * The estimate runs to an empty battery at the present use: it is approximate by nature.
 */

import { db } from './db.js';

/** Readings of the current outage needed before the falling rate is trusted. */
export const RATE_MIN_SEC = 20 * 60;
export const RATE_MIN_DROP = 2; // %

/** The site's battery capacity, kWh; 0 — not set. */
export const batteryCapacity = (env, site) => Number(env.CFG?.settings?.[`cap@${site.id}`]) || 0;

/** Parses a typed capacity: "10,24", "10.24 кВт·год", "0" (clears). @returns {number|null} */
export function parseCapacity(text) {
  const m = String(text)
    .replace(',', '.')
    .match(/\d+(\.\d+)?/);
  if (!m) return null;
  const v = Number(m[0]);
  return v >= 0 && v <= 1000 ? Math.round(v * 100) / 100 : null;
}

/**
 * @param {{grid: boolean, soc: number, load: number, batt: number, ts: number}} d latest reading
 * @param {number|null} gridSince start of the current grid state
 * @returns {Promise<{sec: number, how: string} | {sec: null, why: string}>}
 */
export async function batteryRuntime(env, site, d, gridSince) {
  if (!Number.isFinite(d?.soc)) return { sec: null, why: 'немає даних про заряд батареї' };
  const draw = !d.grid && Math.abs(d.batt) > 0 ? Math.abs(d.batt) : d.load;
  const cap = batteryCapacity(env, site);
  if (cap && draw > 0) {
    const sec = ((cap * 1000 * d.soc) / 100 / draw) * 3600;
    return { sec, how: `ємність ${cap} кВт·год, заряд ${d.soc}%, розряд ${draw} Вт` };
  }
  if (d.grid) {
    return {
      sec: null,
      why: cap ? 'немає даних про споживання' : 'не вказано ємність батареї (⚙️ Налаштування → 🏠 Об’єкти)',
    };
  }
  const from = gridSince || d.ts;
  const first = await (
    await db(env)
  )
    .prepare('SELECT ts, soc FROM readings WHERE site=? AND ts>=? AND soc IS NOT NULL ORDER BY ts LIMIT 1')
    .bind(site.id, from)
    .first();
  const span = first ? d.ts - first.ts : 0;
  const drop = first ? first.soc - d.soc : 0;
  if (span >= RATE_MIN_SEC && drop >= RATE_MIN_DROP) {
    const sec = (d.soc / drop) * span;
    return { sec, how: `заряд упав на ${drop}% за ${Math.round(span / 60)} хв цього відключення` };
  }
  return {
    sec: null,
    why: 'не вказано ємність батареї (⚙️ Налаштування → 🏠 Об’єкти), а світла немає ще замало часу, щоб порахувати за швидкістю розряду',
  };
}
