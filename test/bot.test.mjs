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

test('access request → admin approves as a user → sees the home, access screen opens', async () => {
  const w = createWorld();
  const req = await w.say(42, '/start', 'Olha');
  const toAdmin = req.find((m) => m.chat === ADMIN);
  assert.match(toAdmin.text, /^🙋 Запит на доступ: Olha/);
  assert.ok(toAdmin.markup.inline_keyboard.flat().some((b) => b.callback_data === 'a:42:user'));

  const approved = await w.press(ADMIN, 'a:42:user');
  assert.ok(textsTo(approved, 42).includes('✅ Доступ надано: Користувач.'));
  const screen = approved.find((m) => m.chat === 'edit');
  assert.match(screen.text, /🔐 Доступ: Olha/);
  assert.deepEqual(
    screen.markup.inline_keyboard.map(([b]) => b.text),
    ['⚡ Дім: 👁 бачить', '      🚿 Бойлер: як Дім']
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

test('a device can be limited below its site, never raised above it', async () => {
  const w = createWorld();
  const perm = (chat, dev) => w.db.prepare('SELECT perm FROM user_devices WHERE chat_id=? AND device=?').get(chat, dev);

  // Member controls the home; the boiler follows → limit to "sees" → "none" → follows again.
  await w.press(ADMIN, `pc:${MEMBER}:boiler`);
  assert.equal(perm(MEMBER, 'boiler').perm, 'view');
  assert.ok(textsTo(await w.press(MEMBER, 'dc:boiler:on'), 'answer').includes('Лише перегляд'));
  await w.press(ADMIN, `pc:${MEMBER}:boiler`);
  assert.equal(perm(MEMBER, 'boiler').perm, 'none');
  await w.press(ADMIN, `pc:${MEMBER}:boiler`);
  assert.equal(perm(MEMBER, 'boiler'), undefined, 'back to following the site');

  // Guest only sees the home: the boiler can only be hidden, not given control.
  await w.press(ADMIN, `pc:${GUEST}:boiler`);
  assert.equal(perm(GUEST, 'boiler').perm, 'none');
  await w.press(ADMIN, `pc:${GUEST}:boiler`);
  assert.equal(perm(GUEST, 'boiler'), undefined);

  // No access to the home: nothing to limit.
  await w.press(ADMIN, `pc:${GUEST}:site.home`); // view → control
  await w.press(ADMIN, `pc:${GUEST}:site.home`); // control → none
  const res = await w.press(ADMIN, `pc:${GUEST}:boiler`);
  assert.ok(textsTo(res, 'answer').includes("Спершу відкрий доступ до об'єкта"));
});

test('the users list shows each person’s access per site', async () => {
  const w = createWorld();
  const list = await w.say(ADMIN, '👥 Користувачі');
  assert.ok(textsTo(list, ADMIN).some((t) => t.includes('Member') && t.includes('Дім: 🎛 керує')));
  assert.ok(textsTo(list, ADMIN).some((t) => t.includes('Guest') && t.includes('Дім: 👁 бачить')));
});
