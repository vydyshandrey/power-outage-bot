import assert from 'node:assert/strict';
import { test } from 'node:test';
import { entitiesToHtml } from '../src/settings.js';
import {
  ADMIN,
  DESS_PASSWORD,
  DESS_USER,
  MEMBER,
  VC_PASSWORD,
  VC_USER,
  createWorld,
  textsTo,
} from './helpers/world.mjs';

const buttons = (msgs) => msgs.flatMap((m) => m.markup?.inline_keyboard?.flat() || []);
const pressFirst = async (w, msgs, prefix) => {
  const b = buttons(msgs).find((x) => x.callback_data.startsWith(prefix));
  assert.ok(b, `button ${prefix} not found in ${JSON.stringify(buttons(msgs).map((x) => x.callback_data))}`);
  return w.press(ADMIN, b.callback_data);
};

/** A deployment with no configuration in wrangler.toml: everything is set up in the bot. */
function blank() {
  const w = createWorld();
  for (const k of ['DEYE_SN', 'MIDEA_DEVICE_ID', 'TZ']) delete w.env[k];
  return w;
}

const inverters = (w) =>
  w.db
    .prepare("SELECT id, site, params FROM devices WHERE type='inverter' ORDER BY sort, rowid")
    .all()
    .map((d) => ({ ...d, params: JSON.parse(d.params) }));

test('upgrade: what was in wrangler.toml becomes settings, inverters become devices', async () => {
  const w = createWorld();
  Object.assign(w.env, {
    SITES: JSON.stringify([
      { id: 'home', name: 'Дім', inverter: 'deye' },
      { id: 'shop', name: 'Майстерня', inverter: 'valueclouds' },
    ]),
    VC_PN: 'I300',
    VC_SN: 'DEV1',
    VC_DEVCODE: '6422',
    VC_DEVADDR: '4',
  });
  await w.tick();
  const sites = w.db.prepare('SELECT id, name, source FROM sites ORDER BY sort').all();
  assert.deepEqual(
    sites.map((s) => [s.id, s.name, s.source]),
    [
      ['home', 'Дім', 'i1'],
      ['shop', 'Майстерня', 'i2'],
    ]
  );
  assert.deepEqual(inverters(w), [
    { id: 'i1', site: 'home', params: { cloud: 'deye', account: 1, sn: 'SN1' } },
    {
      id: 'i2',
      site: 'shop',
      params: { cloud: 'valueclouds', account: 1, pn: 'I300', sn: 'DEV1', devcode: '6422', devaddr: '4' },
    },
  ]);
  assert.equal(w.kv('schema_v'), '6');
  const dev = w.db.prepare("SELECT * FROM devices WHERE type='midea_boiler'").get();
  assert.equal(dev.id, 'boiler');
  assert.equal(JSON.parse(dev.params).device_id, '100000000000001');
  assert.equal(w.kv('cfg.tz'), 'Europe/Kyiv');

  // From now on wrangler.toml no longer matters.
  delete w.env.DEYE_SN;
  delete w.env.MIDEA_DEVICE_ID;
  w.step(120);
  w.grid = false;
  await w.tick();
  assert.deepEqual(w.controls, ['off']);
});

test('settings are for admins only', async () => {
  const w = createWorld();
  const res = await w.press(MEMBER, 's:m');
  assert.ok(textsTo(res, 'answer').includes('Лише для адміна'));
  const kb = await w.say(MEMBER, 'щось');
  assert.ok(!JSON.stringify(kb[0].markup).includes('Налаштування'));
});

test('renaming a site changes the notifications', async () => {
  const w = createWorld();
  await w.tick();
  await w.press(ADMIN, 's:sn:home');
  await w.say(ADMIN, 'Квартира');
  w.db.exec(`INSERT INTO sites (id,name,account,params,sort) VALUES ('s9','Дача',1,'{}',9)`);
  await w.press(ADMIN, 's:sl'); // reload happens per request anyway
  w.step(120);
  w.grid = false;
  const off = await w.tick();
  assert.ok(textsTo(off, ADMIN).some((t) => t.startsWith('🔌 Квартира · Світло зникло')));
});

test('adding a SmartESS site in the bot: name → app → account → pick the inverter', async () => {
  const w = blank();
  const asked = await w.press(ADMIN, 's:sa');
  assert.match(asked[0].text, /Як назвати об'єкт/);
  const apps = await w.say(ADMIN, 'Квартира мами');
  assert.match(apps[0].text, /додано/);
  assert.ok(buttons(apps).some((b) => b.callback_data === 's:sc:dess'));
  await w.press(ADMIN, 's:sc:dess');

  // No password yet: the bot says exactly which secrets to add.
  const need = await w.press(ADMIN, 's:sk:1');
  assert.match(need[0].text, /DESS_USER[\s\S]*DESS_PASSWORD/);
  Object.assign(w.env, { DESS_USER, DESS_PASSWORD });

  const list = await w.press(ADMIN, 's:sk:1');
  assert.match(buttons(list)[0].text, /PV18 · 96342210100001/);
  const saved = await w.press(ADMIN, 's:sp:0');
  assert.ok(textsTo(saved, ADMIN).some((t) => t.startsWith('✅ Збережено') && t.includes('Квартира мами')));

  const [inv] = inverters(w);
  assert.equal(inv.params.cloud, 'dess');
  assert.equal(inv.params.sn, '96342210100001');
  assert.equal(w.db.prepare('SELECT source FROM sites').get().source, inv.id);

  // The same inverter is not offered twice.
  await w.press(ADMIN, `s:ia:${inv.site}`);
  await w.press(ADMIN, 's:sc:dess');
  const again = await w.press(ADMIN, 's:sk:1');
  assert.match(again[0].text, /Нових інверторів/);

  await w.tick();
  w.step(120);
  w.grid = false;
  const off = await w.tick();
  assert.ok(
    textsTo(off, ADMIN).some((t) => t.startsWith('🔌 Світло зникло')),
    'one site: no name prefix'
  );
});

test('adding a SmartValue site: numbers from the app, protocol found by the bot', async () => {
  const w = blank();
  Object.assign(w.env, { VC_USER, VC_PASSWORD });
  await w.press(ADMIN, 's:sa');
  await w.say(ADMIN, 'Майстерня');
  await w.press(ADMIN, 's:sc:valueclouds');
  const login = await w.press(ADMIN, 's:sk:1');
  assert.ok(textsTo(login, ADMIN).some((t) => t.includes('Надішли <b>PN</b>')));
  await w.say(ADMIN, 'I30000230600000000');
  await w.say(ADMIN, '0000000001');
  await w.say(ADMIN, '-');
  const done = await w.say(ADMIN, '-');
  assert.ok(textsTo(done, ADMIN).some((t) => t.startsWith('✅ Інвертор відповідає: мережа є, батарея 77%')));
  assert.deepEqual(inverters(w)[0].params, {
    cloud: 'valueclouds',
    account: 1,
    pn: 'I30000230600000000',
    sn: '0000000001',
    devcode: '6409',
    devaddr: '255',
  });
});

test('adding a boiler in the bot, then automation switches it off', async () => {
  const w = blank();
  w.db.exec(`INSERT INTO sites (id,name,cloud,account,params,sort) VALUES ('home','Дім','deye',1,'{"sn":"SN1"}',0)`);
  const types = await w.press(ADMIN, 's:da');
  const list = await pressFirst(w, types, 's:dt:');
  assert.equal(buttons(list)[0].text, 'Бойлер');
  const where = await w.press(ADMIN, 's:dp:0');
  await pressFirst(w, where, 's:dP:');
  const dev = w.db.prepare("SELECT * FROM devices WHERE type='midea_boiler'").get();
  assert.equal(dev.id, 'boiler');
  assert.equal(dev.site, 'home');

  await w.tick();
  w.step(120);
  w.grid = false;
  await w.tick();
  assert.deepEqual(w.controls, ['off']);
});

test('a device with automation off is left alone', async () => {
  const w = createWorld();
  await w.tick();
  await w.press(ADMIN, 's:dA:boiler');
  w.step(120);
  w.grid = false;
  await w.tick();
  assert.deepEqual(w.controls, []);
});

test('editing a message text: formatting kept, preview, unknown variables refused, reset', async () => {
  const w = createWorld();
  await w.press(ADMIN, 's:te:grid_off');
  const bad = await w.say(ADMIN, 'Світла нема з {tim}');
  assert.match(bad[0].text, /Невідомі змінні: <code>\{tim\}<\/code>/);

  const text = 'Світла нема з {time}, батарея {soc}%';
  const preview = await w.say(ADMIN, text, 'Admin', [{ type: 'bold', offset: 0, length: 11 }]);
  assert.match(preview[0].text, /<b>Світла нема<\/b> з 14:05, батарея 90%/);
  await w.press(ADMIN, 's:ts');

  await w.tick();
  w.step(120);
  w.grid = false;
  const off = await w.tick();
  assert.ok(textsTo(off, MEMBER).some((t) => /^<b>Світла нема<\/b> з \d\d:\d\d, батарея 90%$/.test(t)));

  await w.press(ADMIN, 's:tr:grid_off');
  assert.equal(w.db.prepare('SELECT count(*) n FROM templates').get().n, 0);
});

test('a broken text still reaches people, as plain text', async () => {
  const w = createWorld();
  w.db.exec("INSERT INTO templates VALUES ('grid_off', 'Світла нема <bad> {time}')");
  await w.tick();
  w.step(120);
  w.grid = false;
  const off = await w.tick();
  assert.ok(textsTo(off, MEMBER).some((t) => /^Світла нема +\d\d:\d\d$/.test(t)));
});

test('a person can get a name for messages', async () => {
  const w = createWorld();
  await w.press(ADMIN, `s:uo:${MEMBER}`);
  await w.say(ADMIN, 'Тато');
  const on = await w.press(MEMBER, 'dc:boiler:on');
  assert.ok(textsTo(on, ADMIN).includes('🔥 Бойлер увімкнено: Тато.'));
});

test('time zone is set in the bot', async () => {
  const w = createWorld();
  await w.press(ADMIN, 's:tZ:Europe/London');
  assert.equal(w.kv('cfg.tz'), 'Europe/London');
  await w.press(ADMIN, 's:tY');
  const bad = await w.say(ADMIN, 'Mars/Olympus');
  assert.match(bad[0].text, /Не знаю такого часового поясу/);
});

test('entities typed in Telegram become HTML', () => {
  assert.equal(
    entitiesToHtml('Світло <є> {time}', [
      { type: 'bold', offset: 0, length: 6 },
      { type: 'code', offset: 11, length: 6 },
    ]),
    '<b>Світло</b> &lt;є&gt; <code>{time}</code>'
  );
});

test('a second inverter on a site: the admin picks which one shows the grid; removing it falls back', async () => {
  const w = createWorld();
  Object.assign(w.env, { DESS_USER, DESS_PASSWORD });
  await w.tick();
  const types = await w.press(ADMIN, 's:da');
  assert.ok(buttons(types).some((b) => b.callback_data === 's:dI'));
  const where = await w.press(ADMIN, 's:dI');
  await pressFirst(w, where, 's:ia:home');
  await w.press(ADMIN, 's:sc:dess');
  await w.press(ADMIN, 's:sk:1');
  await w.press(ADMIN, 's:sp:0');
  const [first, second] = inverters(w);
  assert.equal(w.db.prepare("SELECT source FROM sites WHERE id='home'").get().source, first.id, 'source kept');

  const card = await w.press(ADMIN, 's:so:home');
  assert.ok(buttons(card).some((b) => b.callback_data === 's:si:home'));
  await w.press(ADMIN, `s:sS:home:${second.id}`);
  assert.equal(w.db.prepare("SELECT source FROM sites WHERE id='home'").get().source, second.id);

  await w.press(ADMIN, `s:dD:${second.id}`);
  assert.equal(w.db.prepare("SELECT source FROM sites WHERE id='home'").get().source, first.id);
});

test('an inverter is not a switch: no automation, no control buttons, not in the access screen', async () => {
  const w = createWorld();
  await w.tick();
  const [inv] = inverters(w);
  const card = await w.press(ADMIN, `s:do:${inv.id}`);
  assert.ok(!buttons(card).some((b) => b.callback_data.startsWith('s:dA')));
  const res = await w.press(ADMIN, `dc:${inv.id}:off`);
  assert.ok(textsTo(res, 'answer').includes('Лише перегляд'));
  const menu = await w.say(MEMBER, '🏠 Пристрої');
  assert.ok(
    buttons(menu).some((b) => b.callback_data === `d:${inv.id}`),
    'shown to those who see the site'
  );
  const view = await w.press(MEMBER, `d:${inv.id}`);
  assert.match(view[0].text, /Батарея/);
  assert.ok(!buttons(view).some((b) => b.callback_data.startsWith('dc:')));
  const access = await w.press(ADMIN, `u:e:${MEMBER}`);
  assert.ok(
    buttons(access).some((b) => b.callback_data.includes('boiler')),
    'screen shown'
  );
  assert.ok(!buttons(access).some((b) => b.callback_data.includes(inv.id)));
});
