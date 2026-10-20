import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN, GUEST, MEMBER, createWorld, textsTo } from './helpers/world.mjs';

// The test clock starts at 10:00 Kyiv time.

test('without grid the battery warning comes once at the threshold, and again only after recovery', async () => {
  const w = createWorld();
  await w.tick();
  w.step(120);
  w.grid = false;
  await w.tick();
  w.soc = 31;
  w.step(120);
  assert.equal(textsTo(await w.tick(), MEMBER).filter((t) => t.startsWith('🪫')).length, 0, 'above 30%');
  w.soc = 30;
  w.step(120);
  const low = await w.tick();
  assert.ok(
    textsTo(low, GUEST).some((t) => /^🪫 Батарея 30%, світла немає 4 хв\./.test(t)),
    'viewers are warned'
  );
  w.soc = 28;
  w.step(120);
  assert.equal(textsTo(await w.tick(), MEMBER).filter((t) => t.startsWith('🪫')).length, 0, 'not repeated');
  w.soc = 36;
  w.step(120);
  await w.tick();
  w.soc = 29;
  w.step(120);
  assert.equal(textsTo(await w.tick(), MEMBER).filter((t) => t.startsWith('🪫')).length, 1, 'again after recovery');
});

test('the threshold is set per site; "Ні" turns the warning off', async () => {
  const w = createWorld();
  await w.press(ADMIN, 's:bT:home:0');
  await w.tick();
  w.step(120);
  w.grid = false;
  w.soc = 5;
  await w.tick();
  w.step(120);
  assert.equal(textsTo(await w.tick(), MEMBER).filter((t) => t.startsWith('🪫')).length, 0);
});

test('every morning: yesterday’s summary with a chart; a person can turn it off', async () => {
  const w = createWorld();
  await w.tick(); // 10:00, nothing from yesterday yet
  for (let i = 0; i < 30; i++) {
    w.step(600);
    w.grid = !(i >= 10 && i < 16); // one hour without grid
    await w.tick();
  }
  w.step(16 * 3600); // next day, ~07:00
  w.step(3600); // ~08:00
  const morning = await w.tick();
  const photo = morning.find((m) => m.chat === MEMBER && m.photo);
  assert.ok(photo, 'the summary is a photo');
  assert.match(photo.text, /^📊 <b>Підсумки дня · \d\d\.\d\d<\/b>/);
  assert.match(photo.text, /🔌 Без світла: 1 год 0 хв \(1 раз\)/);
  assert.match(photo.text, /🏠 Спожито: \d+\.\d кВт·год/);
  assert.equal(w.charts.at(-1).chart.data.datasets.length, 3);

  w.step(600);
  assert.equal((await w.tick()).filter((m) => m.photo).length, 0, 'once a day');

  await w.press(GUEST, 'ns');
  w.step(86400);
  const next = await w.tick();
  assert.ok(!next.some((m) => m.chat === GUEST && m.photo), 'turned off');
  assert.ok(next.some((m) => m.chat === MEMBER && m.photo));
});

test('a chart on demand; without the renderer the numbers come as text', async () => {
  const w = createWorld();
  await w.tick();
  for (let i = 0; i < 6; i++) {
    w.step(600);
    await w.tick();
  }
  const menu = await w.press(MEMBER, 'cg');
  assert.ok(menu[0].markup.inline_keyboard.flat().some((b) => b.callback_data === 'ch:home:w'));
  const today = await w.press(MEMBER, 'ch:home:d');
  assert.ok(today.some((m) => m.chat === MEMBER && m.photo && m.text.startsWith('📈 <b>сьогодні</b>')));

  w.chartFails = true;
  const plain = await w.press(MEMBER, 'ch:home:w');
  assert.ok(textsTo(plain, MEMBER).some((t) => t.startsWith('📈 <b>7 днів</b>')));
});
