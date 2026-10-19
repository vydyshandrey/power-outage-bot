import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN, MEMBER, createWorld, textsTo } from './helpers/world.mjs';

test('a one-off Deye failure is silent', async () => {
  const w = createWorld();
  await w.tick();
  w.step(120);
  w.deyeFails = 2; // one tick = request + retry with a fresh token
  assert.equal((await w.tick()).length, 0);
  w.step(120);
  assert.equal((await w.tick()).length, 0);
});

test('Deye down for 10+ min: one alert to admins, one "back" message', async () => {
  const w = createWorld();
  await w.tick();
  w.deyeFails = Infinity;
  const down = await w.ticksFor(14);
  const alerts = down.filter((m) => m.text.startsWith('⚠️ Deye не відповідає'));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].chat, ADMIN);
  assert.equal(textsTo(down, MEMBER).length, 0, 'non-admins are not bothered');

  w.deyeFails = 0;
  w.step(120);
  const up = await w.tick();
  assert.ok(textsTo(up, ADMIN).some((t) => t.startsWith('✅ Deye знову відповідає')));
});

test('stale inverter data pauses automation and is reported once', async () => {
  const w = createWorld();
  await w.tick();
  w.clock += 900; // the logger stops sending; deyeTs stays behind
  w.grid = false;
  const stale = await w.tick();
  assert.ok(textsTo(stale, ADMIN).some((t) => t.startsWith('⚠️ Дані Deye не оновлювались')));
  assert.deepEqual(w.controls, [], 'no action on stale data');
  w.clock += 120;
  assert.equal((await w.tick()).length, 0);
});

test('Midea 3102 on the first attempt is retried with a fresh login', async () => {
  const w = createWorld();
  await w.tick();
  w.step(120);
  w.grid = false;
  w.mideaFails = 2;
  const off = await w.tick();
  assert.ok(textsTo(off, ADMIN).includes('⛔ Бойлер вимкнено автоматично.'));
  assert.ok(w.events('midea_err').length >= 1, 'failures are logged for diagnostics');
});

test('if the regional route lookup fails, the last known endpoint is used', async () => {
  const w = createWorld();
  await w.tick();
  w.step(120);
  w.grid = false;
  await w.tick(); // logs in and remembers the regional endpoint
  assert.equal(w.kv('midea_mas'), 'https://mas-eu.example/proxy?alias=');

  w.routeFails = true;
  w.db.exec("DELETE FROM kv WHERE k='midea_session'");
  w.step(120);
  w.grid = true;
  await w.tick();
  await w.ticksFor(6);
  assert.deepEqual(w.controls, ['off', 'on']);
});
