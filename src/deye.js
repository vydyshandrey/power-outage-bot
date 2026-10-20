/** Deye Cloud OpenAPI client: token handling, latest inverter reading, station list. */

import { DEFAULT_DEYE_API, GRID_HZ_MIN, GRID_V_MIN } from './config.js';
import { kvGet, kvSet } from './db.js';
import { hash, now } from './util.js';

/** Deye answers success with several codes, as string or number. */
const OK_CODES = ['0', '1000000', '1106000', 0, 1000000, 1106000];

/** Refresh the token a day before it expires. */
const TOKEN_MARGIN_SEC = 86400;

/**
 * @typedef {object} DeyeConn one DeyeCloud account
 * @property {import('./config.js').Env} env
 * @property {string} appId
 * @property {string} appSecret
 * @property {string} email
 * @property {string} password
 * @property {string} [api] regional OpenAPI address
 * @property {string} cacheKey storage key of the cached token
 */

const baseUrl = (c) => c.api || DEFAULT_DEYE_API;

/**
 * @typedef {object} Reading
 * @property {number} ts logger timestamp, Unix seconds
 * @property {boolean} grid grid present
 * @property {number} volt grid voltage, V
 * @property {number} hz grid frequency, Hz
 * @property {number} soc battery state of charge, %
 * @property {number} batt battery power, W (negative = charging)
 * @property {number} load house consumption, W
 */

/** Cached access token; `force` obtains a new one. @param {DeyeConn} c */
export async function deyeToken(c, force = false) {
  const { env } = c;
  if (!force) {
    const cached = await kvGet(env, c.cacheKey);
    if (cached) {
      const { token, exp } = JSON.parse(cached);
      if (exp > now()) return token;
    }
  }
  const res = await fetch(`${baseUrl(c)}/account/token?appId=${encodeURIComponent(c.appId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      appSecret: c.appSecret,
      email: c.email,
      password: (await hash('SHA-256', c.password)).toLowerCase(),
    }),
  });
  const j = await res.json();
  if (!j.accessToken) throw new Error(`Deye auth: ${j.code} ${j.msg || ''}`);
  const token = j.accessToken.split(' ').pop();
  const ttl = Number(j.expiresIn) || 86400 * 30;
  await kvSet(env, c.cacheKey, JSON.stringify({ token, exp: now() + ttl - TOKEN_MARGIN_SEC }));
  return token;
}

/**
 * Latest reading of an inverter. Retries once with a fresh token.
 * @param {DeyeConn} c
 * @param {string} sn inverter serial number
 * @returns {Promise<Reading>}
 */
export async function deyeLatest(c, sn) {
  if (!sn) throw new Error('Не вказано серійний номер інвертора Deye');
  const fetchLatest = async (token) => {
    const res = await fetch(`${baseUrl(c)}/device/latest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ deviceList: [sn] }),
    });
    return { status: res.status, j: await res.json().catch(() => ({})) };
  };

  let r = await fetchLatest(await deyeToken(c));
  if (r.status === 401 || !OK_CODES.includes(r.j.code)) r = await fetchLatest(await deyeToken(c, true));
  if (!OK_CODES.includes(r.j.code)) throw new Error(`Deye latest: ${r.status} ${r.j.code} ${r.j.msg || ''}`);

  const dev = (r.j.deviceDataList || [])[0];
  if (!dev) throw new Error('Deye: інвертор не знайдено');
  const v = Object.fromEntries((dev.dataList || []).map((it) => [it.key, it.value]));
  const volt = Number(v.GridVoltageL1L2) || 0;
  const hz = Number(v.GridFrequency) || 0;
  return {
    ts: Number(dev.collectionTime) || 0,
    grid: volt > GRID_V_MIN && hz > GRID_HZ_MIN,
    volt,
    hz,
    soc: Number(v.SOC),
    batt: Number(v.BatteryPower),
    load: Number(v.TotalConsumptionPower),
  };
}

/** Stations with their devices (for discovery). @param {DeyeConn} c */
export async function deyeStations(c) {
  const res = await fetch(`${baseUrl(c)}/station/listWithDevice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await deyeToken(c)}` },
    body: '{}',
  });
  const j = await res.json();
  return { stations: j.data?.stationList || j.stationList || [], code: j.code, msg: j.msg };
}
