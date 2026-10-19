/** Deye Cloud OpenAPI client: token handling, latest inverter reading, station list. */

import { DEFAULT_DEYE_API, GRID_HZ_MIN, GRID_V_MIN } from './config.js';
import { kvGet, kvSet } from './db.js';
import { hash, now } from './util.js';

/** Deye answers success with several codes, as string or number. */
const OK_CODES = ['0', '1000000', '1106000', 0, 1000000, 1106000];

/** Refresh the token a day before it expires. */
const TOKEN_MARGIN_SEC = 86400;

const baseUrl = (env) => env.DEYE_API || DEFAULT_DEYE_API;

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

/** Cached access token; `force` obtains a new one. */
export async function deyeToken(env, force = false) {
  if (!force) {
    const cached = await kvGet(env, 'deye_token');
    if (cached) {
      const { token, exp } = JSON.parse(cached);
      if (exp > now()) return token;
    }
  }
  const res = await fetch(`${baseUrl(env)}/account/token?appId=${encodeURIComponent(env.DEYE_APP_ID)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      appSecret: env.DEYE_APP_SECRET,
      email: env.DEYE_EMAIL,
      password: (await hash('SHA-256', env.DEYE_PASSWORD)).toLowerCase(),
    }),
  });
  const j = await res.json();
  if (!j.accessToken) throw new Error(`Deye auth: ${j.code} ${j.msg || ''}`);
  const token = j.accessToken.split(' ').pop();
  const ttl = Number(j.expiresIn) || 86400 * 30;
  await kvSet(env, 'deye_token', JSON.stringify({ token, exp: now() + ttl - TOKEN_MARGIN_SEC }));
  return token;
}

/**
 * Latest reading of the configured inverter. Retries once with a fresh token.
 * @returns {Promise<Reading>}
 */
export async function deyeLatest(env) {
  if (!env.DEYE_SN) throw new Error('DEYE_SN не задано: відкрий /discover?key=<ACCESS_KEY>');
  const fetchLatest = async (token) => {
    const res = await fetch(`${baseUrl(env)}/device/latest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ deviceList: [env.DEYE_SN] }),
    });
    return { status: res.status, j: await res.json().catch(() => ({})) };
  };

  let r = await fetchLatest(await deyeToken(env));
  if (r.status === 401 || !OK_CODES.includes(r.j.code)) r = await fetchLatest(await deyeToken(env, true));
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

/** Stations with their devices (for /discover). */
export async function deyeStations(env) {
  const res = await fetch(`${baseUrl(env)}/station/listWithDevice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await deyeToken(env)}` },
    body: '{}',
  });
  const j = await res.json();
  return { stations: j.data?.stationList || j.stationList || [], code: j.code, msg: j.msg };
}
