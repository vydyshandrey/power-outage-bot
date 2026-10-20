/**
 * Midea SmartHome (MSmartHome) cloud client.
 *
 * The protocol is not officially documented; it mirrors the open-source
 * Home Assistant integrations. The cloud occasionally answers "account does not
 * exist" (3102) or "route does not exist" (10004) for a valid account, so every
 * call retries with a fresh login, and the last known regional endpoint is kept
 * as a fallback.
 */

import { kvGet, kvSet, logEvent } from './db.js';
import { encode, hash, hex, now, randHex, sleep } from './util.js';

// Public identifiers of the MSmartHome mobile app (the same values are published in
// open-source Midea integrations). They are not account credentials: the account's
// email and password come only from Worker secrets.
const GLOBAL_URL = 'https://mp-prod.appsmb.com/mas/v5/app/proxy?alias=';
const APP_ID = '1010';
const APP_KEY = 'ac21b9f9cbfe4ca5a88562ef25e2b768';
const IOT_KEY = 'meicloud';
const HMAC_KEY = 'PROD_VnoClJI9aikS8dyy';

const ATTEMPTS = 3;
const RETRY_PAUSE_MS = 3000;

/** Status fields that must not be echoed back in a control command. */
const READ_ONLY_FIELDS = ['sn8', 'version', 'query_type'];

/** UTC timestamp in the yyyyMMddHHmmss form the API expects. */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

export class MideaError extends Error {
  /** @param {number} code API error code */
  constructor(code, message) {
    super(`Midea ${code}: ${message || ''}`);
    this.code = code;
  }
}

export class Midea {
  /** @param {import('./config.js').Env} env */
  constructor(env) {
    this.env = env;
    /** @type {{apiUrl: string, uid: string|null, token: string|null, deviceId: string} | null} */
    this.session = null;
  }

  /** Common request envelope. */
  envelope() {
    return {
      src: APP_ID,
      format: '2',
      stamp: stamp(),
      platformId: '1',
      deviceId: this.session.deviceId,
      reqId: randHex(16),
      uid: this.session.uid,
      clientType: '1',
      appId: APP_ID,
      language: 'en_US',
    };
  }

  /** Signed POST without retries. Errors with an API code are logged for diagnostics. */
  async request(endpoint, data) {
    const body = JSON.stringify(data);
    const random = String(now());
    const key = await crypto.subtle.importKey('raw', encode(HMAC_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]);
    const sign = hex(await crypto.subtle.sign('HMAC', key, encode(IOT_KEY + body + random)));
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      secretVersion: '1',
      sign,
      random,
      'x-recipe-app': APP_ID,
      authorization: `Basic ${btoa(`${APP_KEY}:${IOT_KEY}`)}`,
    };
    if (this.session.uid) headers.uid = this.session.uid;
    if (this.session.token) headers.accesstoken = this.session.token;

    const res = await fetch(this.session.apiUrl + endpoint, { method: 'POST', headers, body });
    const text = await res.text();
    if (!res.ok) throw new Error(`Midea HTTP ${res.status}`);
    const j = JSON.parse(text);
    const code = j.code !== undefined ? parseInt(j.code, 10) : 0;
    if (code !== 0) {
      await logEvent(this.env, 'midea_err', 'midea', endpoint, { y: code, m: j.msg, colo: this.env.COLO || '' });
      throw new MideaError(code, j.msg);
    }
    return j.data ?? null;
  }

  /** Full login: regional route → login id → token. The session is cached in D1. */
  async login() {
    const email = this.env.MIDEA_EMAIL;
    const pass = this.env.MIDEA_PASSWORD;
    this.session = {
      apiUrl: GLOBAL_URL,
      uid: null,
      token: null,
      deviceId: (await hash('SHA-256', `Hello, ${email}!`)).slice(0, 16),
    };

    try {
      const route = await this.request('/v1/multicloud/platform/user/route', {
        ...this.envelope(),
        userType: '0',
        userName: email,
      });
      if (route?.masUrl) {
        this.session.apiUrl = route.masUrl;
        if ((await kvGet(this.env, 'midea_mas')) !== route.masUrl) {
          await kvSet(this.env, 'midea_mas', route.masUrl);
          await logEvent(this.env, 'midea_route', 'midea', 'route', { mas: route.masUrl });
        }
      }
    } catch {
      // Route lookup sometimes fails (10004): fall back to the last known regional endpoint.
      const mas = await kvGet(this.env, 'midea_mas');
      if (mas) this.session.apiUrl = mas;
    }

    const loginId = (await this.request('/v1/user/login/id/get', { ...this.envelope(), loginAccount: email }))?.loginId;
    if (!loginId) throw new Error('Midea: no loginId');

    const password = await hash('SHA-256', loginId + (await hash('SHA-256', pass)) + APP_KEY);
    const iampwd = await hash('SHA-256', loginId + (await hash('MD5', await hash('MD5', pass))) + APP_KEY);
    const st = stamp();
    const iotData = { ...this.envelope(), iampwd, loginAccount: email, password, stamp: st };
    delete iotData.uid;

    const r = await this.request('/mj/user/login', {
      iotData,
      data: { appKey: APP_KEY, deviceId: this.session.deviceId, platform: '2' },
      stamp: st,
    });
    this.session.uid = r.uid;
    this.session.token = r.mdata.accessToken;
    await kvSet(this.env, 'midea_session', JSON.stringify(this.session));
  }

  /** API call with up to 3 attempts; each retry waits and logs in again. */
  async call(endpoint, params) {
    if (!this.session) {
      const saved = await kvGet(this.env, 'midea_session');
      if (saved) this.session = JSON.parse(saved);
    }
    let lastError;
    for (let i = 0; i < ATTEMPTS; i++) {
      try {
        if (!this.session) await this.login();
        return await this.request(endpoint, { ...this.envelope(), ...params });
      } catch (e) {
        lastError = e;
        if (!(e instanceof MideaError)) throw e;
        this.session = null;
        if (i < ATTEMPTS - 1) await sleep(RETRY_PAUSE_MS);
      }
    }
    throw lastError;
  }

  /** Appliances visible to the account (for adding a device). */
  listAppliances() {
    return this.call('/v1/appliance/user/list/get', {});
  }

  /**
   * Current boiler state: power, cur_temperature, temperature (setpoint), …
   * @param {string} applianceCode device id in the Midea cloud
   */
  status(applianceCode) {
    return this.call('/v1/device/status/lua/get', { applianceCode, command: { query: {} } });
  }

  /**
   * Switches the boiler. The API expects the full current status alongside the change.
   * @returns {Promise<object>} status before the change
   */
  async setPower(applianceCode, on) {
    const current = (await this.status(applianceCode)) || {};
    const status = Object.fromEntries(Object.entries(current).filter(([k]) => !READ_ONLY_FIELDS.includes(k)));
    await this.call('/v1/device/lua/control', {
      applianceCode,
      command: { control: { power: on ? 'on' : 'off' }, status },
    });
    return current;
  }
}
