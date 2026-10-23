import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fmtRuntime, parseCapacity, batteryRuntime, batteryCutoff, parseCutoff } from '../src/runtime.js';
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

test('the estimate is a single rounded value', () => {
  assert.equal(fmtRuntime(21.9 * 3600), '~22 год');
  assert.equal(fmtRuntime(8.4 * 3600), '~8,5 год');
  assert.equal(fmtRuntime(40 * 60), '~40 хв');
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

test('past outages give one average estimate from the first minute', async () => {
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
  // past average 470 W → ~19 h; the quiet minimum must not extend the estimate
  assert.match(await status(w), /⏳ Вистачить на ~19 год/);
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

// A tiny historical reading used to inflate the upper bound to thousands of hours.
for (const withCapacity of [true, false]) {
  test(`tiny past discharge cannot inflate runtime (capacity: ${withCapacity})`, async () => {
    const w = createWorld();
    if (withCapacity) await capacity(w, '10');
    await w.tick();
    w.grid = false;
    await run(w, 40, (i) => {
      w.draw = i < 3 ? 1 : 500;
      w.soc -= 0.5;
    });
    w.grid = true;
    await run(w, 20);
    w.grid = false;
    w.draw = 750;
    await run(w, 32, () => {
      w.soc -= 0.5;
    });
    const text = await status(w);
    assert.match(text, /⏳ Вистачить на ~[\d,]+ год/);
    assert.doesNotMatch(text, /⏳[^\n]*[–—]/);
    if (withCapacity) assert.match(text, /⏳ Вистачить на ~9,5 год/);
  });
}

test('shutdown threshold input is strict and distinct from warning threshold', () => {
  assert.equal(parseCutoff('20,5 %'), 20.5);
  for (const bad of ['-5', '101', '20 volts', 'NaN', '']) assert.equal(parseCutoff(bad), null);
  assert.equal(parseCutoff('0'), 0);
  assert.equal(parseCutoff('100'), 100);
  assert.equal(batteryCutoff({ CFG: { settings: { 'batt@home': '30' } } }, { id: 'home' }), null);
  assert.equal(fmtRuntime(0), '0 хв');
});

for (const mode of ['capacity', 'current-rate', 'past-rate']) {
  test(`shutdown reserve reduces runtime for ${mode}, including exhausted reserve`, async () => {
    const w = createWorld();
    await w.tick();
    const site = { id: 'home' };
    w.env.CFG = { settings: {} };
    w.env.CFG.settings['cap@home'] = mode === 'capacity' ? '10' : '0';
    w.db.exec('DELETE FROM readings');
    const end = w.clock - 3600;
    for (let i = 0; i <= 10; i++) {
      w.db
        .prepare('INSERT INTO readings(site,ts,grid,load,batt,soc) VALUES(?,?,?,?,?,?)')
        .run('home', end - 1200 + i * 120, 0, 500, 500, 90 - i);
    }
    const d = { grid: false, soc: 80, load: 500, batt: 500, ts: end };
    const since = mode === 'past-rate' ? end + 1 : end - 1200;
    const original = await batteryRuntime(w.env, site, d, since);
    assert.ok(original.sec > 0);
    w.env.CFG.settings['cutoff@home'] = '20';
    const limited = await batteryRuntime(w.env, site, d, since);
    assert.equal(limited.sec, original.sec * 0.75);
    assert.match(limited.how, /до порогу 20%/);
    assert.equal(batteryCutoff(w.env, { id: 'other' }), null);
    for (const soc of [20, 15]) assert.equal((await batteryRuntime(w.env, site, { ...d, soc }, since)).sec, 0);
  });
}

test('administrator sets shutdown SOC and status names the forecast boundary', async () => {
  const w = createWorld();
  await capacity(w, '10');
  await w.press(ADMIN, 's:bl:home');
  await w.say(ADMIN, '20%');
  assert.equal(w.db.prepare('SELECT v FROM kv WHERE k=?').get('cfg.cutoff@home')?.v, '20');
  await w.tick();
  w.grid = false;
  w.draw = 500;
  await run(w, 2);
  assert.match(await status(w), /~14 год \(до порогу 20%\)/);
  w.soc = 20;
  await run(w, 2);
  assert.match(await status(w), /Доступний заряд вичерпано/);
});
