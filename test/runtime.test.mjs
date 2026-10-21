import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fmtRuntime, parseCapacity } from '../src/runtime.js';
import { ADMIN, MEMBER, createWorld } from './helpers/world.mjs';

const status = async (w) => (await w.say(MEMBER, '📊 Статус')).map((m) => m.text).join('\n');

/** Ticks every 2 min for `min` minutes; `each(i)` may change the world before each tick. */
async function run(w, min, each = () => {}) {
  for (let i = 0; i < min / 2; i++) {
    each(i);
    w.step(120);
    w.deyeTs = w.clock;
    await w.tick();
  }
}

async function capacity(w, kwh) {
  await w.press(ADMIN, 's:bc:home');
  await w.say(ADMIN, kwh);
}

test('typed capacity is read with a comma or a unit; nonsense is refused', () => {
  assert.equal(parseCapacity('10,24'), 10.24);
  assert.equal(parseCapacity('15 кВт·год'), 15);
  assert.equal(parseCapacity('0'), 0);
  assert.equal(parseCapacity('багато'), null);
});

test('the estimate is rounded as approximately as it is, a range only when it is one', () => {
  assert.equal(fmtRuntime(21.9 * 3600), '~22 год');
  assert.equal(fmtRuntime(8.4 * 3600), '~8,5 год');
  assert.equal(fmtRuntime(6 * 3600, 9.1 * 3600), '~6–9 год');
  assert.equal(fmtRuntime(40 * 60), '~40 хв');
  assert.equal(fmtRuntime(6 * 3600, 6.1 * 3600), '~6 год');
});

test('with the capacity set, the status gives the estimate from what the battery gives without grid', async () => {
  const w = createWorld();
  await capacity(w, '10,24');
  assert.match(JSON.stringify(await w.press(ADMIN, 's:so:home')), /🔋 Ємність батареї: 10.24 кВт·год/);
  await w.tick();
  w.grid = false;
  await run(w, 2);
  // 10.24 kWh × 90% ÷ 420 W ≈ 21.9 h
  assert.match(await status(w), /⏳ Вистачить на ~22 год/);
});

test('with an ATS the house load seen with grid does not count: only discharge without grid does', async () => {
  const w = createWorld();
  await capacity(w, '10');
  w.load = 3000; // with grid the inverter sees a heavy house load (or, with an ATS, almost none)
  await run(w, 60);
  w.grid = false;
  w.draw = 450;
  await run(w, 2);
  // 10 kWh × 90% ÷ 450 W = 20 h, whatever the load with grid was
  assert.match(await status(w), /⏳ Вистачить на ~20 год/);
});

test('an average, not one reading: the discharge of the last 30 min of the outage', async () => {
  const w = createWorld();
  await capacity(w, '10');
  await w.tick();
  w.grid = false;
  await run(w, 30, (i) => {
    w.draw = i % 2 ? 600 : 300;
  });
  w.draw = 600; // the latest reading alone would give 15 h
  await run(w, 2);
  // average ≈ 460 W → 9000 Wh ÷ 460 ≈ 19.6 h
  assert.match(await status(w), /⏳ Вистачить на ~20 год/);
});

test('past outages give the estimate from the first minute, as a range down to the quiet minimum', async () => {
  const w = createWorld();
  await capacity(w, '10');
  await w.tick();
  w.grid = false;
  await run(w, 40, (i) => {
    w.draw = i < 2 ? 200 : 500; // the inverter and the always-on load alone: 200 W
  });
  w.grid = true;
  await run(w, 20);
  w.grid = false;
  w.draw = 900; // a kettle right now; one reading must not decide
  await run(w, 2);
  // past average 470 W → ~19 h; at the quiet 200 W → ~45 h
  assert.match(await status(w), /⏳ Вистачить на ~19–45 год/);
});

test('without the capacity: nothing at first, then from how fast the charge falls', async () => {
  const w = createWorld();
  await w.tick();
  w.grid = false;
  await run(w, 2);
  assert.doesNotMatch(await status(w), /⏳/, 'too early to tell');
  await run(w, 30, (i) => {
    w.soc -= i % 3 === 0 ? 1 : 0; // 5% in 30 min
  });
  // 85% left at ~10% an hour → ~8,5 h
  assert.match(await status(w), /⏳ Вистачить на ~8,5 год/);
});
