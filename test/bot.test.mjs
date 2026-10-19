import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCESS_KEY, ADMIN, GUEST, MEMBER, createWorld, textsTo } from './helpers/world.mjs';

test('the first /start with the access key creates the admin; a wrong key does not', async () => {
  const w = createWorld({ users: false });
  const wrong = await w.say(10, '/start nope');
  assert.ok(textsTo(wrong, 10).includes('Запит на доступ надіслано адміністратору.'));

  const right = await w.say(11, `/start ${ACCESS_KEY}`);
  assert.ok(textsTo(right, 11)[0].startsWith('✅ Ти адмін'));
});

test('access request → admin approves with a role → user gets role defaults', async () => {
  const w = createWorld();
  const req = await w.say(42, '/start', 'Olha');
  const toAdmin = req.find((m) => m.chat === ADMIN);
  assert.match(toAdmin.text, /^🙋 Запит на доступ: Olha/);
  assert.ok(toAdmin.markup.inline_keyboard.flat().some((b) => b.callback_data === 'a:42:control'));

  const approved = await w.press(ADMIN, 'a:42:control');
  assert.ok(textsTo(approved, 42).includes('✅ Доступ надано: Керування.'));
  assert.equal(
    w.db.prepare("SELECT perm FROM user_devices WHERE chat_id=42 AND device='boiler'").get().perm,
    'control'
  );
});

test('view-only users cannot control; control users can, and that cancels pending automation', async () => {
  const w = createWorld();
  const denied = await w.press(GUEST, 'dc:boiler:off');
  assert.ok(textsTo(denied, 'answer').includes('Лише перегляд'));
  assert.deepEqual(w.controls, []);

  w.db.exec("INSERT INTO kv VALUES ('boiler_auto_off','1')");
  const ok = await w.press(MEMBER, 'dc:boiler:on');
  assert.deepEqual(w.controls, ['on']);
  assert.ok(textsTo(ok, GUEST).includes('🔥 Бойлер увімкнено: Member.'), 'viewers are notified');
  assert.equal(w.kv('boiler_auto_off'), '0');
  assert.equal(w.events('power_on')[0].actor, 'Member');
});

test('status shows grid, battery and the boiler', async () => {
  const w = createWorld();
  await w.tick();
  const [msg] = await w.say(MEMBER, '📊 Статус');
  assert.match(msg.text, /💡 Світло є/);
  assert.match(msg.text, /🔋 Батарея: 90%/);
  assert.match(msg.text, /🚿 Бойлер: увімкнений, 57° \/ 60°/);
});

test('outage report pairs off/on events and sums the time', async () => {
  const w = createWorld();
  await w.tick();
  w.step(120);
  w.grid = false;
  await w.tick();
  w.step(1800);
  w.grid = true;
  await w.tick();
  const [report] = await w.press(MEMBER, 'g:7');
  assert.match(report.text, /Відключення за 7 днів/);
  assert.match(report.text, /Разом без світла: 30 хв/);
});

test('users not approved are ignored', async () => {
  const w = createWorld();
  assert.equal((await w.say(99, '📊 Статус')).length, 0);
  const res = await w.press(99, 'g:7');
  assert.ok(textsTo(res, 'answer').includes('Немає доступу'));
});
