import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseValueClouds } from '../src/valueclouds.js';
import { ACCESS_KEY, ADMIN, createWorld, textsTo } from './helpers/world.mjs';

test('SmartValue reading: a few volts on the grid sensor still means no grid', () => {
  const r = parseValueClouds({
    gts: 1_700_000_000_000,
    pars: {
      gd_: [
        { id: 'gd_eybond_read_21', par: 'LineVolt_L1', val: '7.8', unit: 'V' },
        { id: 'gd_eybond_read_23', par: 'LineFreq', val: '0', unit: 'Hz' },
      ],
      bt_: [{ id: 'bt_battery_capacity', par: 'BattSoc', val: '99', unit: '%' }],
      bc_: [{ id: 'load_active_power', par: 'OutSumW', val: '537', unit: 'W' }],
    },
  });
  assert.equal(r.grid, false);
  assert.equal(r.ts, 1_700_000_000);
  assert.equal(r.soc, 99);
  assert.equal(r.load, 537);
});

test('SmartValue inverter: grid lost → boiler off, back → on', async () => {
  const w = createWorld().useValueClouds();
  await w.tick();
  w.step(120);
  w.grid = false;
  const off = await w.tick();
  assert.ok(textsTo(off, ADMIN).some((t) => t.includes('батарея 77%')));
  assert.deepEqual(w.controls, ['off']);
  w.step(120);
  w.grid = true;
  await w.tick();
  await w.ticksFor(6);
  assert.deepEqual(w.controls, ['off', 'on']);
  assert.equal(w.vcLogins, 1, 'the token is reused between ticks');
});

test('SmartValue: an expired token is renewed silently', async () => {
  const w = createWorld().useValueClouds();
  await w.tick();
  w.vcToken = 'expired';
  w.step(120);
  assert.equal((await w.tick()).length, 0);
  assert.equal(w.vcLogins, 2);
});

test('SmartValue down for 10+ min: alert names the platform', async () => {
  const w = createWorld().useValueClouds();
  await w.tick();
  w.vcFails = Infinity;
  const down = await w.ticksFor(14);
  assert.equal(down.filter((m) => m.text.startsWith('⚠️ SmartValue не відповідає')).length, 1);
});

test('/discover with SmartValue checks the login and reads the inverter', async () => {
  const w = createWorld().useValueClouds();
  const body = await (await w.http(`/discover?key=${ACCESS_KEY}`)).json();
  assert.equal(body.sites.home.found, null, 'the platform has no device list');
  assert.equal(body.sites.home.reading.soc, 77);
});

test('/discover with a wrong SmartValue password shows the platform message', async () => {
  const w = createWorld().useValueClouds();
  w.env.VC_PASSWORD = 'wrong';
  const body = await (await w.http(`/discover?key=${ACCESS_KEY}`)).json();
  assert.match(body.sites.home.error, /account or password error/);
});
