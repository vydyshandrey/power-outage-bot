/**
 * ValueClouds cloud client: the SmartValue app (Eybond), e.g. MUST PV18 with the
 * WFBLE.DTU.PlugPro Wi-Fi module. A separate platform from DESS Monitor: other
 * dongle numbers (18 characters), other accounts, other API.
 *
 * Not officially documented. The request shapes follow what the open-source
 * ha-mutatrack integration observed in the SmartValue web app:
 *   POST /ppr/web/login/login {account, password: sha1(password), project: "IOT"} → token
 *   GET  /ppe/api/auth/web/querySPDeviceLastData?pn&sn&devcode&devaddr  (header Token)
 * The platform answers HTTP 200 even on errors; `success: false` is the signal.
 */

import { GRID_HZ_MIN, GRID_V_MIN } from './config.js';
import { kvGet, kvSet } from './db.js';
import { hash, now } from './util.js';

const BASE = 'https://api.valueclouds.com';
const PROJECT = 'IOT';

/** devcode/devaddr pairs seen on real devices; /discover tries them for the given PN and SN. */
export const KNOWN_DEVICE_CODES = [
  { devcode: '6409', devaddr: '255' }, // MUST PV18-3224 PRO with WFBLE.DTU.PlugProA
  { devcode: '6422', devaddr: '4' },
  { devcode: '6422', devaddr: '1' },
];

export class ValueCloudsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueCloudsError';
  }
}

async function readJson(res) {
  if (!res.ok) throw new ValueCloudsError(`SmartValue: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new ValueCloudsError('SmartValue: відповідь не JSON');
  }
}

const reason = (j) => j.message || j.errorMessage || `код ${j.code}`;

/** @param {import('./config.js').Env} env */
async function login(env) {
  const res = await fetch(`${BASE}/ppr/web/login/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      account: env.VC_USER,
      password: await hash('SHA-1', env.VC_PASSWORD),
      project: PROJECT,
    }),
  });
  const j = await readJson(res);
  if (!j.success || !j.data?.token) throw new ValueCloudsError(`SmartValue вхід: ${reason(j)}`);
  await kvSet(env, 'vc_token', j.data.token);
  return j.data.token;
}

/**
 * Authenticated GET. The token lifetime is unknown, so a rejected call is retried once
 * with a fresh login, whatever the error was.
 */
async function vcGet(env, path, params) {
  for (const fresh of [false, true]) {
    const token = (!fresh && (await kvGet(env, 'vc_token'))) || (await login(env));
    const res = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, {
      headers: { Token: token, project: PROJECT, i18n: 'en_US' },
    });
    const j = res.status === 401 || res.status === 403 ? { success: false, code: res.status } : await readJson(res);
    if (j.success !== false && Number(j.code ?? 0) === 0) return j.data;
    if (fresh) throw new ValueCloudsError(`SmartValue ${path.split('/').pop()}: ${reason(j)}`);
  }
}

/* ---------- reading ---------- */

/** Ids are stable across languages; names (`par`) are a fallback for other firmwares. */
const FIELDS = {
  volt: { id: 'gd_eybond_read_21', par: /^(LineVolt(_L1)?|Grid ?Volt(age)?)$/i },
  hz: { id: 'gd_eybond_read_23', par: /^(LineFreq|Grid ?Freq(uency)?)$/i },
  soc: { id: 'bt_battery_capacity', par: /^(BattSoc|Battery ?SOC)$/i },
  batt: { id: 'battery_active_discharging_power', par: /^Total battery power$/i },
  load: { id: 'load_active_power', par: /^(OutSumW|Load ?Power)$/i },
};

function pick(items, { id, par }) {
  const it = items.find((x) => x.id === id) || items.find((x) => par.test(String(x.par || x.title || '').trim()));
  if (!it) return null;
  const n = Number(it.val);
  return Number.isNaN(n) ? null : /^kw$/i.test(it.unit || '') ? n * 1000 : n;
}

/**
 * Converts a `querySPDeviceLastData` answer into the common reading shape.
 * @param {{gts?: number, pars?: Record<string, Array<{id: string, par?: string, val: string, unit?: string}>>}} data
 * @returns {import('./deye.js').Reading}
 */
export function parseValueClouds(data) {
  const items = Object.values(data?.pars || {}).flat();
  if (!items.length) throw new ValueCloudsError('SmartValue: інвертор не повернув даних');
  const volt = pick(items, FIELDS.volt) ?? 0; // without grid the sensor still shows a few volts
  const hz = pick(items, FIELDS.hz) ?? 0;
  // `gts` is the snapshot time in milliseconds; a clock ahead of ours is capped.
  const ts = data.gts ? Math.min(Math.floor(Number(data.gts) / 1000), now()) : now();
  return {
    ts,
    grid: volt > GRID_V_MIN && (hz === 0 || hz > GRID_HZ_MIN),
    volt,
    hz,
    soc: pick(items, FIELDS.soc) ?? NaN,
    batt: Math.round(pick(items, FIELDS.batt) ?? NaN),
    load: Math.round(pick(items, FIELDS.load) ?? NaN),
  };
}

const deviceParams = (env, overrides = {}) => {
  for (const k of ['VC_PN', 'VC_SN']) {
    if (!env[k]) throw new ValueCloudsError(`${k} не задано: див. AGENTS.md, гілка SmartValue`);
  }
  return {
    pn: env.VC_PN,
    sn: env.VC_SN,
    devcode: env.VC_DEVCODE || KNOWN_DEVICE_CODES[0].devcode,
    devaddr: env.VC_DEVADDR || KNOWN_DEVICE_CODES[0].devaddr,
    i18n: 'en_US',
    ...overrides,
  };
};

/** @returns {Promise<import('./deye.js').Reading>} */
export async function valueCloudsLatest(env) {
  return parseValueClouds(await vcGet(env, '/ppe/api/auth/web/querySPDeviceLastData', deviceParams(env)));
}

/**
 * The platform has no known device-list call, so /discover checks the login and
 * tries the known devcode/devaddr pairs for the PN and SN from wrangler.toml.
 */
export async function valueCloudsDiscover(env) {
  await login(env);
  if (!env.VC_PN || !env.VC_SN) {
    return {
      login: 'ok',
      next: 'Впиши VC_PN (номер на Wi-Fi-модулі) і VC_SN (серійний номер інвертора) у wrangler.toml',
    };
  }
  const tried = [];
  for (const code of KNOWN_DEVICE_CODES) {
    try {
      const r = parseValueClouds(await vcGet(env, '/ppe/api/auth/web/querySPDeviceLastData', deviceParams(env, code)));
      return { login: 'ok', VC_DEVCODE: code.devcode, VC_DEVADDR: code.devaddr, sample: r };
    } catch (e) {
      tried.push({ ...code, error: e.message });
    }
  }
  return { login: 'ok', error: 'жодна відома пара devcode/devaddr не підійшла', tried };
}
