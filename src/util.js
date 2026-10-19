/** Small helpers shared by all modules. */

import { DEFAULT_TZ } from './config.js';

export const NL = '\n';

const encoder = new TextEncoder();

/** @param {string} s */
export const encode = (s) => encoder.encode(s);

/** @param {ArrayBuffer | Uint8Array} buf */
export const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Hex digest of a UTF-8 string. MD5 is needed only for the Midea login scheme.
 * @param {'SHA-256' | 'MD5'} alg
 * @param {string} s
 */
export const hash = async (alg, s) => hex(await crypto.subtle.digest(alg, encode(s)));

/** @param {number} bytes */
export const randHex = (bytes) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

/** Current Unix time in seconds. */
export const now = () => Math.floor(Date.now() / 1000);

/** @param {number} ms */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Escapes text for Telegram HTML parse mode. */
export const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/* Time zone is a deployment-wide setting, applied once per invocation. */
let timeZone = DEFAULT_TZ;

/** @param {string | undefined} tz */
export function setTimeZone(tz) {
  timeZone = tz || DEFAULT_TZ;
}

/** "16.10, 23:01" @param {number} ts Unix seconds */
export const fmtTime = (ts) =>
  new Date(ts * 1000).toLocaleString('uk-UA', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

/** "23:01" @param {number} ts Unix seconds */
export const fmtHM = (ts) =>
  new Date(ts * 1000).toLocaleString('uk-UA', { timeZone, hour: '2-digit', minute: '2-digit' });

/** Human duration: "5 хв", "2 год 17 хв", "1 д 3 год 0 хв". @param {number} sec */
export function fmtDur(sec) {
  const m = Math.max(0, Math.round(sec / 60));
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d} д ${h % 24} год ${m % 60} хв`;
  if (h > 0) return `${h} год ${m % 60} хв`;
  return `${m} хв`;
}
