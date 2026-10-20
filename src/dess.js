/**
 * DESS Monitor / ShineMonitor cloud client (Eybond Wi-Fi dongles).
 *
 * The same account works in SmartESS, WatchPower, Energy-Mate and other rebranded
 * apps, so one client covers many inverter brands (MUST, Anenji, PowMr, Voltronic/Axpert…).
 * The API is not officially documented; the request signing follows the open-source
 * ha-dessmonitor integration (MIT).
 *
 * Every request is a GET to `<base>?sign=…&salt=…[&token=…]&action=…&param=…`, where
 *   sign = sha1(salt + sha1(password) + actionString)   for the login itself,
 *   sign = sha1(salt + secret + token + actionString)   for everything else.
 */

import { GRID_HZ_MIN, GRID_V_MIN, VERSION } from './config.js';
import { kvGet, kvSet } from './db.js';
import { hash, now } from './util.js';

/** Platform profiles: SmartESS-family apps use DessMonitor, SmartClient uses ShineMonitor. */
export const DESS_PLATFORMS = {
  dessmonitor: { base: 'https://api.dessmonitor.com/public/', auth: 'authSource', source: '1' },
  shinemonitor: { base: 'https://ios.shinemonitor.com/public/', auth: 'auth', source: '0' },
};

/** Public company key used by the SmartESS web client. */
const DEFAULT_COMPANY_KEY = 'bnrl_frRFjEz8Mkn';

/** Refresh the token this long before it expires. */
const TOKEN_MARGIN_SEC = 600;

export class DessError extends Error {
  /** @param {string} message @param {number|null} [code] platform `err` value */
  constructor(message, code = null) {
    super(message);
    this.name = 'DessError';
    this.code = code;
  }
}

const sha1 = (s) => hash('SHA-1', s);

/** The platform reports success as `err: 0`; a missing field also means success. */
const failed = (j) => Number(j.err ?? 0) !== 0;

/** Python's urllib.parse.quote_plus: the server checks the signature against this exact form. */
export const quotePlus = (v) =>
  encodeURIComponent(String(v))
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');

/** `&action=…&k=v…` — signed and sent byte for byte. */
export const actionString = (action, params = {}) =>
  `&action=${action}` +
  Object.entries(params)
    .map(([k, v]) => `&${k}=${quotePlus(v)}`)
    .join('');

const platformOf = (env) => {
  const p = DESS_PLATFORMS[env.DESS_PLATFORM || 'dessmonitor'];
  if (!p) throw new DessError(`DESS_PLATFORM має бути dessmonitor або shinemonitor, а не «${env.DESS_PLATFORM}»`);
  return p;
};

/** @param {import('./config.js').Env} env */
async function login(env) {
  const p = platformOf(env);
  const salt = String(Date.now());
  const act = actionString(p.auth, {
    usr: env.DESS_USER,
    'company-key': env.DESS_COMPANY_KEY || DEFAULT_COMPANY_KEY,
    source: p.source,
    _app_client_: 'web',
    _app_id_: 'power-outage-bot',
    _app_version_: VERSION,
  });
  const sign = await sha1(salt + (await sha1(env.DESS_PASSWORD)) + act);
  const j = await getJson(`${p.base}?sign=${sign}&salt=${salt}${act}`);
  if (failed(j)) throw new DessError(`DESS вхід: ${j.desc || j.err}`, j.err);
  const { token, secret, expire } = j.dat || {};
  if (!token || !secret || !(expire > 0)) throw new DessError('DESS вхід: сервер не повернув токен');
  const session = { token, secret, exp: now() + expire - TOKEN_MARGIN_SEC };
  await kvSet(env, 'dess_token', JSON.stringify(session));
  return session;
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new DessError(`DESS: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new DessError('DESS: відповідь не JSON');
  }
}

async function session(env, force) {
  if (!force) {
    const cached = JSON.parse((await kvGet(env, 'dess_token')) || 'null');
    if (cached && cached.exp > now()) return cached;
  }
  return login(env);
}

/**
 * Signed API call. A rejected call is retried once with a fresh login,
 * because an expired or revoked token looks like any other error.
 * @returns {Promise<any>} the `dat` field
 */
export async function dessCall(env, action, params = {}) {
  const p = platformOf(env);
  for (const force of [false, true]) {
    const s = await session(env, force);
    const salt = String(Date.now());
    const act = actionString(action, params);
    const sign = await sha1(salt + s.secret + s.token + act);
    const j = await getJson(`${p.base}?sign=${sign}&salt=${salt}&token=${s.token}${act}`);
    if (!failed(j)) return j.dat;
    if (force) throw new DessError(`DESS ${action}: ${j.desc || j.err}`, j.err);
  }
}

/* ---------- reading ---------- */

/** Titles differ between inverter families; these patterns cover the known variants. */
const FIELDS = {
  volt: /^(grid|ac input|mains|utility)( input)? voltage$/i,
  hz: /^(grid|ac input|mains|utility)( input)? frequency$/i,
  soc: /^battery (capacity|soc|level soc|level)$/i,
  load: /^((ac )?output active power|total output active power|load (active )?power|active power of load)$/i,
  battPower: /^battery power$/i,
  battV: /^battery voltage$/i,
  battChg: /^battery charging current$/i,
  battDis: /^battery discharge current$/i,
  stamp: /^timestamp$/i,
};

/** Value of the first data point whose title matches, converted to base units. */
function pick(points, re) {
  const pt = points.find((x) => re.test(String(x.title).trim()));
  if (!pt) return null;
  const n = Number(pt.val);
  if (Number.isNaN(n)) return pt.val;
  return /^k(w|va)$/i.test(pt.unit || '') ? n * 1000 : n;
}

/**
 * Converts `queryDeviceLastData` points into the common reading shape.
 * @param {Array<{title: string, val: string, unit?: string}>} points
 */
export function parseDessPoints(points) {
  const volt = pick(points, FIELDS.volt) ?? 0;
  const hz = pick(points, FIELDS.hz) ?? 0;
  let batt = pick(points, FIELDS.battPower);
  if (batt === null) {
    const v = pick(points, FIELDS.battV) ?? 0;
    batt = v * ((pick(points, FIELDS.battDis) ?? 0) - (pick(points, FIELDS.battChg) ?? 0));
  }
  return {
    // Some firmwares report no grid frequency; then voltage alone decides.
    grid: volt > GRID_V_MIN && (hz === 0 || hz > GRID_HZ_MIN),
    volt,
    hz,
    soc: pick(points, FIELDS.soc) ?? NaN,
    batt: Math.round(batt), // W, negative = charging
    load: Math.round(pick(points, FIELDS.load) ?? NaN),
    stamp: pick(points, FIELDS.stamp),
  };
}

const deviceParams = (env) => {
  for (const k of ['DESS_PN', 'DESS_SN', 'DESS_DEVCODE', 'DESS_DEVADDR']) {
    if (!env[k]) throw new DessError(`${k} не задано: відкрий /discover?key=<ACCESS_KEY>`);
  }
  return { pn: env.DESS_PN, devcode: env.DESS_DEVCODE, devaddr: env.DESS_DEVADDR, sn: env.DESS_SN };
};

/**
 * Latest reading of the configured inverter.
 *
 * The platform's "Timestamp" is in an unspecified time zone, so it is used only to
 * notice that the data changed: `ts` is when this bot first saw the current snapshot.
 * @returns {Promise<import('./deye.js').Reading>}
 */
export async function dessLatest(env) {
  const points = await dessCall(env, 'queryDeviceLastData', { ...deviceParams(env), i18n: 'en' });
  if (!Array.isArray(points) || !points.length) throw new DessError('DESS: інвертор не повернув даних');
  const { stamp, ...reading } = parseDessPoints(points);

  let ts = now();
  if (stamp !== null) {
    const seen = JSON.parse((await kvGet(env, 'dess_stamp')) || '{}');
    if (seen.v === String(stamp)) ts = seen.ts;
    else await kvSet(env, 'dess_stamp', JSON.stringify({ v: String(stamp), ts }));
  }
  return { ts, ...reading };
}

/** Plants → collectors (dongles) → devices, with the values /discover should suggest. */
export async function dessDevices(env) {
  const plants = (await dessCall(env, 'queryPlants', { pagesize: 50 }))?.plant || [];
  const out = [];
  for (const plant of plants) {
    const collectors = (await dessCall(env, 'webQueryCollectorsEs', { pid: plant.pid, page: 0, pagesize: 50 }))
      ?.collector;
    for (const c of collectors || []) {
      const devs = (await dessCall(env, 'queryCollectorDevices', { pn: c.pn }))?.dev || [];
      out.push({
        plant: plant.pname,
        devices: devs.map((d) => ({
          DESS_PN: c.pn,
          DESS_SN: d.sn,
          DESS_DEVCODE: String(d.devcode),
          DESS_DEVADDR: String(d.devaddr),
          alias: d.devalias || '',
        })),
      });
    }
  }
  return out;
}
