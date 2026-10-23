/**
 * "How long will the battery last?" — worked out by code, never by the model. A base requirement.
 *
 * Only readings WITHOUT grid are used. With an automatic transfer switch (ATS) the house runs past
 * the inverter while the grid is there, so the consumption seen then says nothing about an outage.
 * Without grid, everything the battery feeds goes through the inverter.
 *
 * Discharge (W) is an average, never a single reading:
 *   - the current outage, over its last CUR_WINDOW_SEC, once it has lasted CUR_MIN_SEC;
 *   - otherwise the outages of the last HISTORY_DAYS (and, with nothing else, whatever the
 *     current outage has so far).
 * A single estimate uses the average discharge; historical minimums do not predict runtime.
 *
 * Two ways to turn discharge into time:
 *   capacity — the site's battery capacity (kWh, ⚙️ → object) × charge ÷ discharge;
 *   rate     — without capacity: how fast the charge falls, %/h, in the current outage
 *              (RATE_MIN_SEC and RATE_MIN_DROP), else in past outages.
 * With neither, the answer says what is missing. Estimates use only charge above the configured shutdown threshold.
 */

import { db } from './db.js';
import { now } from './util.js';

export const CUR_WINDOW_SEC = 30 * 60;
export const CUR_MIN_SEC = 15 * 60;
export const HISTORY_DAYS = 14;
/** Past outage readings needed before they are trusted (ticks are 2 min apart: ~20 min). */
export const HISTORY_MIN_READINGS = 10;
export const RATE_MIN_SEC = 20 * 60;
export const RATE_MIN_DROP = 2; // %

/** The site's battery capacity, kWh; 0 — not set. */
export const batteryCapacity = (env, site) => Number(env.CFG?.settings?.[`cap@${site.id}`]) || 0;

/** User-confirmed inverter shutdown SOC; null means unknown, not a guessed reserve. */
export function batteryCutoff(env, site) {
  const raw = env.CFG?.settings?.[`cutoff@${site.id}`];
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

export function parseCutoff(text) {
  const value = String(text).trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?\s*%?$/.test(value)) return null;
  const n = Number(value.replace('%', '').trim());
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/** Parses a typed capacity: "10,24", "10.24 кВт·год", "0" (clears). @returns {number|null} */
export function parseCapacity(text) {
  const m = String(text)
    .replace(',', '.')
    .match(/\d+(\.\d+)?/);
  if (!m) return null;
  const v = Number(m[0]);
  return v >= 0 && v <= 1000 ? Math.round(v * 100) / 100 : null;
}

/** Power a reading without grid takes from the battery, W. */
const drawOf = (r) => (Math.abs(r.batt) > 0 ? Math.abs(r.batt) : Number(r.load) || 0);

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Charge falling, % per hour, over runs of consecutive readings without grid. */
function fallRate(rows) {
  let drop = 0;
  let span = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (b.ts - a.ts > 15 * 60 || !Number.isFinite(a.soc) || !Number.isFinite(b.soc)) continue; // a gap: another outage
    drop += a.soc - b.soc;
    span += b.ts - a.ts;
  }
  return { drop, span, perHour: span > 0 && drop > 0 ? (drop / span) * 3600 : null };
}

/** Readings without grid of the current outage and of past ones. */
async function outageReadings(env, site, d, gridSince) {
  const D = await db(env);
  const rows = (
    await D.prepare('SELECT ts, load, batt, soc FROM readings WHERE site=? AND grid=0 AND ts>=? ORDER BY ts')
      .bind(site.id, now() - HISTORY_DAYS * 86400)
      .all()
  ).results;
  const from = d.grid ? Infinity : gridSince || d.ts;
  return { cur: rows.filter((r) => r.ts >= from), past: rows.filter((r) => r.ts < from) };
}

/**
 * @param {{grid: boolean, soc: number, load: number, batt: number, ts: number}} d latest reading
 * @param {number|null} gridSince start of the current grid state
 * @returns {Promise<{sec: number, how: string} | {sec: null, why: string}>}
 *   sec — at the average discharge
 */
export async function batteryRuntime(env, site, d, gridSince) {
  if (!Number.isFinite(d?.soc)) return { sec: null, why: 'немає даних про заряд батареї' };
  const cutoff = batteryCutoff(env, site);
  const usableSoc = Math.max(0, d.soc - (cutoff ?? 0));
  const limit = cutoff === null ? 'до 0%; поріг відключення не вказано' : `до порогу ${cutoff}%`;
  if (usableSoc === 0) return { sec: 0, how: limit, limit };
  const { cur, past } = await outageReadings(env, site, d, gridSince);
  const curSpan = cur.length ? cur.at(-1).ts - cur[0].ts : 0;
  const recent = cur.filter((r) => r.ts >= d.ts - CUR_WINDOW_SEC);
  const pastDraws = past.map(drawOf).filter((x) => x > 0);
  const havePast = pastDraws.length >= HISTORY_MIN_READINGS;

  let draw = null;
  let from = '';
  if (curSpan >= CUR_MIN_SEC && recent.length) {
    draw = avg(recent.map(drawOf));
    from = `середній розряд за останні ${Math.round(Math.min(curSpan, CUR_WINDOW_SEC) / 60)} хв`;
  } else if (havePast) {
    draw = avg(pastDraws);
    from = `середній розряд у відключеннях за ${HISTORY_DAYS} днів`;
  } else if (cur.length) {
    draw = avg(cur.map(drawOf));
    from = `середній розряд за ${Math.max(1, Math.round(curSpan / 60))} хв цього відключення`;
  }

  const cap = batteryCapacity(env, site);
  if (cap && draw > 0) {
    const sec = ((cap * 1000 * usableSoc) / 100 / draw) * 3600;
    return {
      sec,
      limit,
      how: `ємність ${cap} кВт·год, заряд ${d.soc}%, ${from} ${Math.round(draw)} Вт; ${limit}`,
    };
  }

  const curRate = fallRate(cur);
  if (curRate.span >= RATE_MIN_SEC && curRate.drop >= RATE_MIN_DROP && curRate.perHour) {
    const sec = (usableSoc / curRate.perHour) * 3600;
    return {
      sec,
      limit,
      how: `заряд падає на ${curRate.perHour.toFixed(1)}% за годину в цьому відключенні; ${limit}`,
    };
  }
  const pastRate = fallRate(past);
  if (havePast && pastRate.drop >= RATE_MIN_DROP && pastRate.perHour) {
    const sec = (usableSoc / pastRate.perHour) * 3600;
    return {
      sec,
      limit,
      how: `у відключеннях за ${HISTORY_DAYS} днів заряд падав у середньому на ${pastRate.perHour.toFixed(1)}% за годину; ${limit}`,
    };
  }
  return {
    sec: null,
    why: cap
      ? 'ще немає відключень, щоб знати навантаження без світла'
      : 'не вказано ємність батареї (⚙️ Налаштування → 🏠 Об’єкти), а відключень у історії ще замало, щоб порахувати за швидкістю розряду',
  };
}

/** "~7 год", "~40 хв": one rounded estimate at the average discharge. */
export function fmtRuntime(sec) {
  if (sec <= 0) return '0 хв';
  const one = (s) =>
    s < 3600 ? Math.max(1, Math.round(s / 600) * 10) : s < 36000 ? Math.round(s / 1800) / 2 : Math.round(s / 3600);
  const unit = (s) => (s < 3600 ? 'хв' : 'год');
  const num = (s) => String(one(s)).replace('.', ',');
  return `~${num(sec)} ${unit(sec)}`;
}
