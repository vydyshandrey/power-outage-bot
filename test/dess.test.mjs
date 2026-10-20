import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionString, parseDessPoints, quotePlus } from '../src/dess.js';
import { hash } from '../src/util.js';
import { ACCESS_KEY, ADMIN, createWorld, textsTo } from './helpers/world.mjs';

// Reference values computed with Python's urllib.parse.quote_plus and hashlib,
// i.e. the way the open-source ha-dessmonitor client signs requests.
test('URL encoding matches Python quote_plus', () => {
  assert.equal(quotePlus('owner smartess@example.com'), 'owner+smartess%40example.com');
  assert.equal(quotePlus('a+b/c?d=e&f'), 'a%2Bb%2Fc%3Fd%3De%26f');
  assert.equal(quotePlus("Тест!*'()~"), '%D0%A2%D0%B5%D1%81%D1%82%21%2A%27%28%29~');
});

test('request signatures match the reference implementation', async () => {
  const sha1 = (s) => hash('SHA-1', s);
  const salt = '1700000000000';

  const login = actionString('authSource', {
    usr: 'owner smartess@example.com',
    'company-key': 'bnrl_frRFjEz8Mkn',
    source: '1',
  });
  assert.equal(login, '&action=authSource&usr=owner+smartess%40example.com&company-key=bnrl_frRFjEz8Mkn&source=1');
  assert.equal(await sha1(salt + (await sha1('pa ss+word')) + login), '78612201ad23c7957050c1f323609eca8050eb9d');

  const data = actionString('queryDeviceLastData', { pn: 'W001', devcode: 2451, devaddr: 1, sn: '963', i18n: 'en' });
  assert.equal(await sha1(salt + 'sec' + 'tok' + data), 'da2a4605392e1c18b243d9e1d39f9b973d2e7caf');
});

// Payload shapes from ha-dessmonitor test fixtures (MIT), trimmed.
test('grid presence comes from input voltage, not from the working mode', () => {
  const sbu = parseDessPoints([
    { title: 'Working State', val: 'Invert Mode', unit: '' }, // SBU priority runs from battery with grid present
    { title: 'AC Input Voltage', val: '237.1', unit: 'V' },
    { title: 'AC Input Frequency', val: '49.9', unit: 'Hz' },
    { title: 'Battery Voltage', val: '53.4', unit: 'V' },
    { title: 'Battery Capacity', val: '72', unit: '%' },
    { title: 'Battery Charging Current', val: '0', unit: 'A' },
    { title: 'Battery Discharge Current', val: '1', unit: 'A' },
    { title: 'Output Active Power', val: '781', unit: 'W' },
  ]);
  assert.deepEqual(sbu, { grid: true, volt: 237.1, hz: 49.9, soc: 72, batt: 53, load: 781, stamp: null });

  const off = parseDessPoints([
    { title: 'Grid voltage', val: '0.0', unit: 'V' },
    { title: 'Battery capacity', val: '64', unit: '%' },
    { title: 'Battery power', val: '-0.42', unit: 'kW' },
    { title: 'Load active power', val: '0.38', unit: 'kW' },
  ]);
  assert.equal(off.grid, false);
  assert.equal(off.batt, -420);
  assert.equal(off.load, 380);
});

test('DESS inverter: grid lost → boiler off, back for 5 min → on', async () => {
  const w = createWorld().useDess();
  await w.tick();
  w.step(120);
  w.grid = false;
  const off = await w.tick();
  assert.ok(textsTo(off, ADMIN).some((t) => t.startsWith('🔌 Світло зникло')));
  assert.ok(textsTo(off, ADMIN).some((t) => t.includes('батарея 88%')));
  assert.deepEqual(w.controls, ['off']);

  w.step(120);
  w.grid = true;
  await w.tick();
  await w.ticksFor(6);
  assert.deepEqual(w.controls, ['off', 'on']);
  assert.equal(w.dessLogins, 1, 'the token is reused between ticks');
});

test('DESS: a rejected token is renewed silently', async () => {
  const w = createWorld().useDess();
  await w.tick();
  w.dessToken = 'revoked-on-server';
  w.step(120);
  assert.equal((await w.tick()).length, 0);
  assert.equal(w.dessLogins, 2);
});

test('DESS down for 10+ min: alert names the platform', async () => {
  const w = createWorld().useDess();
  await w.tick();
  w.dessFails = Infinity;
  const down = await w.ticksFor(14);
  assert.equal(down.filter((m) => m.text.startsWith('⚠️ SmartESS не відповідає')).length, 1);
});

test('DESS data that stops changing is reported as stale', async () => {
  const w = createWorld().useDess();
  await w.tick();
  w.clock += 900; // the dongle stops uploading; the platform keeps returning the old snapshot
  const stale = await w.tick();
  assert.ok(textsTo(stale, ADMIN).some((t) => t.startsWith('⚠️ Дані SmartESS не оновлювались')));
});

test('/discover with DESS lists the inverters the account sees', async () => {
  const w = createWorld().useDess();
  const body = await (await w.http(`/discover?key=${ACCESS_KEY}`)).json();
  assert.deepEqual(body.sites.home.found[0], {
    label: 'Майстерня · PV18 · 96342210100001',
    params: { pn: 'W0012345678901', sn: '96342210100001', devcode: '2451', devaddr: '1' },
  });
  assert.equal(body.sites.home.reading.soc, 88);
});

test('DESS with a wrong password reports the platform error', async () => {
  const w = createWorld().useDess();
  w.env.DESS_PASSWORD = 'wrong';
  const body = await (await w.http(`/discover?key=${ACCESS_KEY}`)).json();
  assert.match(body.sites.home.error, /ERR_PASSWORD_VERIF_FAIL/);
});
