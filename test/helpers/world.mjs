/**
 * Test world: an in-memory D1, fake Deye/DESS/Midea/Telegram clouds and a controllable clock.
 * Each test creates its own world; nothing touches the network.
 */

import nodeCrypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import worker from '../../src/index.js';
import { SCHEMA } from '../../src/db.js';
import { VERSION } from '../../src/config.js';

// Workers support MD5 in crypto.subtle (needed by the Midea login); Node does not.
const digest = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = async (alg, data) =>
  alg === 'MD5' ? nodeCrypto.createHash('md5').update(Buffer.from(data)).digest().buffer : digest(alg, data);

// Retry pauses are irrelevant in tests.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => realSetTimeout(fn, 0);

const sha1 = (s) => nodeCrypto.createHash('sha1').update(s).digest('hex');

export const DESS_USER = 'owner smartess@example.com';
export const DESS_PASSWORD = 'pa ss+word';

/**
 * Fake DESS Monitor. Checks signatures the way the platform does: over the raw
 * "&action=…" tail of the URL, exactly as transmitted.
 */
function fakeDess(w, url) {
  const q = new URL(url).searchParams;
  const tail = url.slice(url.indexOf('&action='));
  const action = q.get('action');
  if (action === 'authSource') {
    if (q.get('usr') !== DESS_USER) return { err: 1, desc: 'ERR_USER_NOT_FOUND' };
    if (q.get('sign') !== sha1(q.get('salt') + sha1(DESS_PASSWORD) + tail))
      return { err: 2, desc: 'ERR_PASSWORD_VERIF_FAIL' };
    w.dessLogins++;
    w.dessToken = `tok${w.dessLogins}`;
    return { err: 0, dat: { token: w.dessToken, secret: 'sec', expire: 7 * 86400 } };
  }
  if (q.get('token') !== w.dessToken || q.get('sign') !== sha1(q.get('salt') + 'sec' + w.dessToken + tail)) {
    return { err: 260, desc: 'ERR_TOKEN_INVALID' };
  }
  if (action === 'queryDeviceLastData') {
    if (w.dessFails > 0) {
      w.dessFails--;
      return { err: 12, desc: 'ERR_SYSTEM_EXCEPTION' };
    }
    const on = w.grid;
    return {
      err: 0,
      dat: [
        { title: 'Timestamp', val: `stamp-${w.deyeTs}`, unit: '' },
        { title: 'Working State', val: on ? 'Line Mode' : 'Battery Mode', unit: '' },
        { title: 'AC Input Voltage', val: on ? '231.5' : '0.0', unit: 'V' },
        { title: 'AC Input Frequency', val: on ? '50.0' : '0.0', unit: 'Hz' },
        { title: 'Battery Voltage', val: '26.4', unit: 'V' },
        { title: 'Battery Capacity', val: '88', unit: '%' },
        { title: 'Battery Charging Current', val: on ? '2' : '0', unit: 'A' },
        { title: 'Battery Discharge Current', val: on ? '0' : '15', unit: 'A' },
        { title: 'Output Active Power', val: '396', unit: 'W' },
      ],
    };
  }
  if (action === 'queryPlants') return { err: 0, dat: { plant: [{ pid: 7, pname: 'Майстерня' }] } };
  if (action === 'webQueryCollectorsEs') return { err: 0, dat: { total: 1, collector: [{ pn: 'W0012345678901' }] } };
  if (action === 'queryCollectorDevices') {
    return { err: 0, dat: { dev: [{ sn: '96342210100001', devcode: 2451, devaddr: 1, devalias: 'PV18' }] } };
  }
  return { err: 404, desc: `unknown action ${action}` };
}

export const VC_USER = 'owner@example.com';
export const VC_PASSWORD = 'secret';

/** Fake ValueClouds (SmartValue): HTTP 200 for everything, errors only in the body. */
function fakeValueClouds(w, url, init) {
  if (url.endsWith('/ppr/web/login/login')) {
    const b = JSON.parse(init.body);
    if (b.project !== 'IOT') return { success: false, code: 24, message: 'corresponding project not found' };
    if (b.account !== VC_USER || b.password !== sha1(VC_PASSWORD)) {
      return { success: false, code: 115140, message: 'account or password error' };
    }
    w.vcLogins++;
    w.vcToken = `vc${w.vcLogins}`;
    return { success: true, code: 0, data: { token: w.vcToken, secret: 's' } };
  }
  if (init.headers?.Token !== w.vcToken) return { success: false, code: 401, message: 'token invalid' };
  const q = new URL(url).searchParams;
  if (q.get('devcode') !== '6409' || q.get('devaddr') !== '255') {
    return { success: false, code: 12, message: 'device does not exist' };
  }
  if (w.vcFails > 0) {
    w.vcFails--;
    return { success: false, code: 500, message: 'system busy' };
  }
  const on = w.grid;
  return {
    code: 0,
    data: {
      gts: w.deyeTs * 1000,
      pars: {
        gd_: [
          { id: 'gd_eybond_read_21', par: 'LineVolt_L1', val: on ? '229.4' : '7.8', unit: 'V' },
          { id: 'gd_eybond_read_23', par: 'LineFreq', val: on ? '50.0' : '0', unit: 'Hz' },
        ],
        bt_: [
          { id: 'bt_battery_capacity', par: 'BattSoc', val: '77', unit: '%' },
          { id: 'battery_active_discharging_power', par: 'Total battery power', val: on ? '-40' : '512', unit: 'W' },
        ],
        bc_: [{ id: 'load_active_power', par: 'OutSumW', val: '537', unit: 'W' }],
      },
    },
  };
}

/** Minimal D1 API over node:sqlite. */
function createD1() {
  const sql = new DatabaseSync(':memory:');
  for (const stmt of SCHEMA) sql.exec(stmt);
  const prepare = (query) => {
    let args = [];
    const st = {
      bind: (...a) => ((args = a), st),
      first: async () => sql.prepare(query).get(...args) ?? null,
      all: async () => ({ results: sql.prepare(query).all(...args) }),
      run: async () => (sql.prepare(query).run(...args), {}),
    };
    return st;
  };
  return { prepare, batch: async (list) => Promise.all(list.map((s) => s.run())), sql };
}

export const ACCESS_KEY = 'access-key';
export const TICK_KEY = 'tick-key';
export const NOTIFY_KEY = 'notify-key';
export const ADMIN = 1;
export const MEMBER = 2;
export const GUEST = 3;

/**
 * @param {object} [opts]
 * @param {boolean} [opts.users] seed an admin (1), a member who controls the home (2) and a guest who sees it (3)
 */
export function createWorld({ users = true } = {}) {
  const D1 = createD1();
  const w = {
    clock: 1_800_000_000,
    grid: true,
    deyeTs: 0,
    boiler: { power: 'on', cur_temperature: 57, temperature: 60 },
    mideaFails: 0, // next N Midea calls answer 3102
    routeFails: false, // regional route lookup answers 10004
    deyeFails: 0, // next N Deye /device/latest calls answer 500
    dessFails: 0, // next N DESS data calls answer a platform error
    dessLogins: 0,
    vcFails: 0,
    upstream: null, // { version, changelog } of the public project
    dispatched: [], // GitHub workflow starts
    vcLogins: 0,
    sent: [], // Telegram messages: { chat, text, markup }
    controls: [], // Midea power commands: 'on' | 'off'
    pending: [],
    db: D1.sql,
  };
  w.deyeTs = w.clock;
  Date.now = () => w.clock * 1000;

  const json = (o, status = 200) => ({
    ok: status < 400,
    status,
    json: async () => o,
    text: async () => JSON.stringify(o),
  });

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://api.dessmonitor.com/public/')) return json(fakeDess(w, url));
    if (url.startsWith('https://api.valueclouds.com/')) return json(fakeValueClouds(w, url, init));
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.includes('/account/token')) return json({ accessToken: 'bearer T', expiresIn: 5_184_000 });
    if (url.includes('/device/latest')) {
      if (w.deyeFails > 0) {
        w.deyeFails--;
        return json({ code: '3201001', msg: 'Service Currently Unavailable' }, 500);
      }
      const on = w.grid;
      return json({
        code: '1000000',
        deviceDataList: [
          {
            collectionTime: w.deyeTs,
            dataList: [
              { key: 'GridVoltageL1L2', value: on ? '230' : '0' },
              { key: 'GridFrequency', value: on ? '50' : '0' },
              { key: 'SOC', value: '90' },
              { key: 'BatteryPower', value: on ? '-50' : '420' },
              { key: 'TotalConsumptionPower', value: '410' },
            ],
          },
        ],
      });
    }
    if (url.includes('/station/listWithDevice')) {
      return json({
        code: '1000000',
        stationList: [{ name: 'Дім', deviceListItems: [{ deviceSn: 'SN1', deviceType: 'INVERTER' }] }],
      });
    }
    if (url.includes('api.telegram.org')) {
      const method = url.split('/').pop();
      if (method === 'sendMessage' && body.parse_mode === 'HTML' && /<(?!\/?(b|i|u|s|code)>)/.test(body.text)) {
        return json({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" });
      }
      if (method === 'sendMessage' || method === 'editMessageText') {
        w.sent.push({
          chat: method === 'editMessageText' ? 'edit' : body.chat_id,
          text: body.text,
          markup: body.reply_markup,
        });
      }
      if (method === 'answerCallbackQuery') w.sent.push({ chat: 'answer', text: body.text });
      return json({ ok: true, result: { username: 'test_bot' } });
    }
    // Midea
    const mideaCall = ['status/lua', 'login/id/get', 'lua/control'].some((p) => url.includes(p));
    if (mideaCall && w.mideaFails > 0) {
      w.mideaFails--;
      return json({ code: '3102', msg: 'this account does not exist' });
    }
    if (url.includes('user/route')) {
      return w.routeFails
        ? json({ code: '10004', msg: 'user route does not exist' })
        : json({ code: 0, data: { masUrl: 'https://mas-eu.example/proxy?alias=' } });
    }
    if (url.includes('login/id/get')) return json({ code: 0, data: { loginId: 'L' } });
    if (url.includes('/mj/user/login')) return json({ code: 0, data: { uid: 'U', mdata: { accessToken: 'A' } } });
    if (url.includes('appliance/user/list/get')) {
      return json({
        code: 0,
        data: { list: [{ id: 100000000000001, name: 'Бойлер', type: '0xE2', productModel: 'X', onlineStatus: '1' }] },
      });
    }
    if (url.includes('status/lua/get')) return json({ code: 0, data: { ...w.boiler } });
    if (url.includes('lua/control')) {
      w.boiler.power = body.command.control.power;
      w.controls.push(w.boiler.power);
      return json({ code: 0, data: {} });
    }
    // The public project, for the update check
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      if (!w.upstream) return json({}, 404);
      if (url.endsWith('/package.json')) return json({ version: w.upstream.version });
      if (url.endsWith('/CHANGELOG.md')) return { ok: true, status: 200, text: async () => w.upstream.changelog };
    }
    if (url.startsWith('https://api.github.com/repos/')) {
      w.dispatched.push({ url, auth: init.headers?.authorization });
      return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  w.env = {
    DB: { prepare: D1.prepare, batch: D1.batch },
    ACCESS_KEY,
    TICK_KEY,
    NOTIFY_KEY,
    NOTIFY_NAME: 'Test',
    TG_BOT_TOKEN: 'T',
    MIDEA_EMAIL: 'bot@example.com',
    MIDEA_PASSWORD: 'p',
    MIDEA_DEVICE_ID: '100000000000001',
    DEYE_APP_ID: 'i',
    DEYE_APP_SECRET: 's',
    DEYE_EMAIL: 'e',
    DEYE_PASSWORD: 'p',
    DEYE_SN: 'SN1',
    TZ: 'Europe/Kyiv',
  };

  const ctx = { waitUntil: (p) => w.pending.push(p) };
  const settle = async () => {
    while (w.pending.length) await Promise.all(w.pending.splice(0));
  };

  if (users) {
    D1.sql.exec(`INSERT INTO users VALUES
      (${ADMIN},'Admin','admin','admin','approved',1),
      (${MEMBER},'Member','member','user','approved',2),
      (${GUEST},'Guest','guest','user','approved',3);
      INSERT INTO user_devices VALUES (${MEMBER},'site.home','control'),(${GUEST},'site.home','view');
      INSERT INTO kv VALUES ('schema_v','4'),('grid','on'),('grid_since','${w.clock - 3 * 3600}'),('announced','${VERSION}');`);
  }

  /** Switches the deployment to an inverter on DESS Monitor. */
  w.useDess = () => {
    for (const k of ['DEYE_APP_ID', 'DEYE_APP_SECRET', 'DEYE_EMAIL', 'DEYE_PASSWORD', 'DEYE_SN']) delete w.env[k];
    Object.assign(w.env, {
      INVERTER: 'dess',
      DESS_USER,
      DESS_PASSWORD,
      DESS_PN: 'W0012345678901',
      DESS_SN: '96342210100001',
      DESS_DEVCODE: '2451',
      DESS_DEVADDR: '1',
    });
    return w;
  };

  /** Switches the deployment to an inverter on ValueClouds (SmartValue app). */
  w.useValueClouds = ({ devcode = true } = {}) => {
    for (const k of ['DEYE_APP_ID', 'DEYE_APP_SECRET', 'DEYE_EMAIL', 'DEYE_PASSWORD', 'DEYE_SN']) delete w.env[k];
    Object.assign(w.env, {
      INVERTER: 'valueclouds',
      VC_USER,
      VC_PASSWORD,
      VC_PN: 'I30000230600000000',
      VC_SN: '0000000001',
    });
    if (devcode) Object.assign(w.env, { VC_DEVCODE: '6409', VC_DEVADDR: '255' });
    return w;
  };

  /** Advances time; the inverter reports a fresh reading at the same moment. */
  w.step = (sec) => {
    w.clock += sec;
    w.deyeTs += sec;
  };

  /** Runs the scheduled check and returns messages sent during it. */
  w.tick = async () => {
    await worker.scheduled({}, w.env, ctx);
    await settle();
    return w.sent.splice(0);
  };

  /** Runs one tick per interval for `minutes`. */
  w.ticksFor = async (minutes, every = 2) => {
    const out = [];
    for (let m = 0; m < minutes; m += every) {
      w.step(every * 60);
      out.push(...(await w.tick()));
    }
    return out;
  };

  const secret = nodeCrypto.createHash('sha256').update(`tg:${ACCESS_KEY}`).digest('hex').slice(0, 48);
  const post = async (update) => {
    await worker.fetch(
      new Request('https://bot.example/tg', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': secret },
        body: JSON.stringify(update),
      }),
      w.env,
      ctx
    );
    await settle();
    return w.sent.splice(0);
  };

  /** Simulates a text message from a private chat. */
  w.say = (chat, text, name = `User${chat}`, entities) =>
    post({ message: { chat: { id: chat, type: 'private' }, from: { first_name: name }, text, entities } });

  /** Simulates an inline-button press. */
  w.press = (chat, data) =>
    post({ callback_query: { id: 'q', from: { id: chat }, data, message: { chat: { id: chat }, message_id: 1 } } });

  /** Plain HTTP request to the worker. */
  w.http = async (path, init) => {
    const res = await worker.fetch(new Request(`https://bot.example${path}`, init), w.env, ctx);
    await settle();
    return res;
  };

  w.kv = (k) => D1.sql.prepare('SELECT v FROM kv WHERE k=?').get(k)?.v ?? null;
  w.events = (type) => D1.sql.prepare('SELECT * FROM events WHERE type=? ORDER BY id').all(type);

  return w;
}

/** Texts of messages sent to a given chat. */
export const textsTo = (messages, chat) => messages.filter((m) => m.chat === chat).map((m) => m.text);
