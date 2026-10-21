import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCapacity } from '../src/runtime.js';
import { ADMIN, MEMBER, createWorld } from './helpers/world.mjs';

const status = async (w) => (await w.say(MEMBER, '📊 Статус')).map((m) => m.text).join('\n');

/** Grid lost now; the fake Deye then reports 420 W from the battery. */
async function outage(w) {
  await w.tick();
  w.grid = false;
  w.step(120);
  w.deyeTs = w.clock;
  await w.tick();
}

test('typed capacity is read with a comma or a unit; nonsense is refused', () => {
  assert.equal(parseCapacity('10,24'), 10.24);
  assert.equal(parseCapacity('15 кВт·год'), 15);
  assert.equal(parseCapacity('0'), 0);
  assert.equal(parseCapacity('багато'), null);
});

test('with the capacity set, the status says how long the battery lasts at the present discharge', async () => {
  const w = createWorld();
  await w.press(ADMIN, 's:bc:home');
  await w.say(ADMIN, '10,24');
  assert.match(JSON.stringify(await w.press(ADMIN, 's:so:home')), /🔋 Ємність батареї: 10.24 кВт·год/);
  await outage(w);
  // 10.24 kWh × 90% ÷ 420 W = 21.9 h
  assert.match(await status(w), /⏳ Вистачить приблизно на 21 год 57 хв/);
});

test('without the capacity: nothing until the outage shows how fast the charge falls, then an estimate', async () => {
  const w = createWorld();
  await outage(w);
  assert.doesNotMatch(await status(w), /⏳/, 'too early to tell');
  for (let i = 0; i < 15; i++) {
    w.step(120);
    w.deyeTs = w.clock;
    w.soc -= i % 3 === 0 ? 1 : 0; // 5% in 30 min
    await w.tick();
  }
  // 85% left at 5% per 30 min → 8 h 30 min
  assert.match(await status(w), /⏳ Вистачить приблизно на 8 год 30 хв/);
});
