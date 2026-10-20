import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN, GUEST, MEMBER, createWorld, textsTo } from './helpers/world.mjs';

test('outage: everyone is told, the boiler goes off; it comes back on after 5 stable minutes', async () => {
  const w = createWorld();
  await w.tick();

  w.step(120);
  w.grid = false;
  const off = await w.tick();
  for (const chat of [ADMIN, MEMBER, GUEST]) {
    const texts = textsTo(off, chat);
    assert.ok(texts.some((t) => t.startsWith('🔌 Світло зникло') && t.includes('Світло було 3 год')));
    assert.ok(texts.includes('⛔ Бойлер вимкнено автоматично.'));
  }
  assert.deepEqual(w.controls, ['off']);
  assert.equal(w.kv('boiler_auto_off'), '1');

  w.step(600);
  w.grid = true;
  const back = await w.tick();
  assert.ok(
    textsTo(back, ADMIN).some((t) => t.startsWith("💡 Світло з'явилось") && t.includes('Світла не було 10 хв'))
  );
  assert.deepEqual(w.controls, ['off'], 'does not switch on immediately');

  w.step(240);
  assert.equal((await w.tick()).length, 0, 'still waiting for 5 minutes of stable grid');

  w.step(120);
  const on = await w.tick();
  assert.ok(textsTo(on, ADMIN).includes('🔥 Бойлер увімкнено автоматично.'));
  assert.deepEqual(w.controls, ['off', 'on']);
  assert.equal(w.kv('boiler_auto_off'), '0');
});

test('a boiler someone switched off by hand is not switched on after the outage', async () => {
  const w = createWorld();
  w.boiler.power = 'off';
  await w.tick();

  w.step(120);
  w.grid = false;
  const off = await w.tick();
  assert.ok(!textsTo(off, ADMIN).some((t) => t.includes('Бойлер вимкнено')));

  w.step(120);
  w.grid = true;
  await w.tick();
  await w.ticksFor(10);
  assert.deepEqual(w.controls, [], 'no commands were sent at all');
});

test('Midea is down while switching off: silent retries, one escalation after 10 min, late success is reported', async () => {
  const w = createWorld();
  await w.tick();

  w.step(120);
  w.grid = false;
  w.mideaFails = Infinity;
  const first = await w.tick();
  assert.ok(!textsTo(first, ADMIN).some((t) => t.includes('Бойлер')), 'no boiler message yet');

  const later = await w.ticksFor(12);
  const escalations = textsTo(later, MEMBER).filter((t) => t.startsWith('⚠️ Бойлер: не вдалося вимкнути'));
  assert.equal(escalations.length, 1, 'exactly one "do it by hand" message');

  w.mideaFails = 0;
  w.step(120);
  const done = await w.tick();
  assert.ok(
    textsTo(done, ADMIN).some((t) =>
      /^⛔ Бойлер вимкнено автоматично\.\n⏱ Через \d+ хв після зникнення світла\.$/.test(t)
    )
  );
  assert.deepEqual(w.controls, ['off']);
});

test('Midea is down while switching back on: one escalation, then a late "on" with the delay', async () => {
  const w = createWorld();
  await w.tick();
  w.step(120);
  w.grid = false;
  await w.tick();

  w.step(120);
  w.grid = true;
  await w.tick();
  w.mideaFails = Infinity;
  const waiting = await w.ticksFor(18);
  assert.equal(textsTo(waiting, ADMIN).filter((t) => t.startsWith('⚠️ Бойлер: не вдалося увімкнути')).length, 1);

  w.mideaFails = 0;
  w.step(120);
  const done = await w.tick();
  assert.ok(textsTo(done, ADMIN).some((t) => /^🔥 Бойлер увімкнено автоматично\.\n⏱ Із запізненням \d+ хв\.$/.test(t)));
});

test('without a configured boiler the bot only reports the grid', async () => {
  const w = createWorld();
  delete w.env.MIDEA_DEVICE_ID;
  await w.tick();
  w.step(120);
  w.grid = false;
  const off = await w.tick();
  assert.ok(textsTo(off, ADMIN).some((t) => t.startsWith('🔌 Світло зникло')));
  assert.deepEqual(w.controls, []);
});

test('a release without user-facing notes is announced to admins only, once', async () => {
  const w = createWorld();
  w.db.exec("UPDATE kv SET v='1.1.0' WHERE k='announced'");
  const sent = await w.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat, ADMIN);
  assert.match(sent[0].text, /^🔧 Бот оновлено до v\d+\.\d+\.\d+\./);
  w.step(120);
  assert.equal((await w.tick()).length, 0);
});
