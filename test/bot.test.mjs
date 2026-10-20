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
  assert.match(toAdmin.text, /^🙋 Запит на доступ: \u2068Olha\u2069/);
  assert.ok(toAdmin.markup.inline_keyboard.flat().some((b) => b.callback_data === 'a:42:user'));

  const approved = await w.press(ADMIN, 'a:42:user');
  assert.ok(textsTo(approved, 42).includes('✅ Доступ надано: Користувач.'));
  const screen = approved.find((m) => m.chat === 'edit');
  assert.match(screen.text, /🔐 Доступ: \u2068Olha\u2069/);
  assert.deepEqual(
    screen.markup.inline_keyboard.map(([b]) => b.text),
    ['⚡ Дім: 👁 бачить', '      🚿 Бойлер: як Дім', '✅ Зберегти']
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
  const edit = async (uid, ...keys) => {
    await w.press(ADMIN, `u:e:${uid}`);
    let last;
    for (const k of keys) last = await w.press(ADMIN, `u:c:${k}`);
    return last;
  };

  // Member controls the home; the boiler follows → limit to "sees" → "none" → follows again.
  await edit(MEMBER, 'boiler');
  assert.equal(perm(MEMBER, 'boiler'), undefined, 'nothing changes before saving');
  await w.press(ADMIN, 'u:s');
  assert.equal(perm(MEMBER, 'boiler').perm, 'view');
  assert.ok(textsTo(await w.press(MEMBER, 'dc:boiler:on'), 'answer').includes('Лише перегляд'));
  await edit(MEMBER, 'boiler');
  await w.press(ADMIN, 'u:s');
  assert.equal(perm(MEMBER, 'boiler').perm, 'none');
  await edit(MEMBER, 'boiler');
  await w.press(ADMIN, 'u:s');
  assert.equal(perm(MEMBER, 'boiler'), undefined, 'back to following the site');

  // Guest only sees the home: the boiler can only be hidden, not given control.
  await edit(GUEST, 'boiler', 'boiler');
  await w.press(ADMIN, 'u:s');
  assert.equal(perm(GUEST, 'boiler'), undefined);

  // No access to the home (in the same draft): nothing to limit.
  const res = await edit(GUEST, 'site.home', 'site.home', 'boiler');
  assert.ok(textsTo(res, 'answer').includes("Спершу відкрий доступ до об'єкта"));
  await w.press(ADMIN, 'u:x');
  assert.equal(perm(GUEST, 'site.home').perm, 'view', 'cancel keeps what was saved');
});

test('the users list is compact; actions are in a person’s card', async () => {
  const w = createWorld();
  const [list] = await w.say(ADMIN, '👥 Користувачі');
  assert.match(list.text, /👤 \u2068Member\u2069: Дім 🎛/);
  assert.match(list.text, /👤 \u2068Guest\u2069: Дім 👁/);
  const buttons = list.markup.inline_keyboard.flat();
  assert.ok(buttons.length >= 3 && list.markup.inline_keyboard.every((row) => row.length <= 2));

  const [card] = await w.press(ADMIN, `u:o:${GUEST}`);
  const actions = card.markup.inline_keyboard.flat().map((b) => b.callback_data);
  assert.ok(
    actions.includes(`u:e:${GUEST}`) && actions.includes(`a:${GUEST}:admin`) && actions.includes(`u:r:${GUEST}`)
  );
  await w.press(ADMIN, `u:r:${GUEST}`);
  assert.equal(w.db.prepare('SELECT status FROM users WHERE chat_id=?').get(GUEST).status, 'approved', 'asks first');
  await w.press(ADMIN, `r:${GUEST}`);
  assert.equal(w.db.prepare('SELECT status FROM users WHERE chat_id=?').get(GUEST).status, 'rejected');
});

test('access from a device: pick people from the list or by search, then save', async () => {
  const w = createWorld();
  const [view] = await w.press(ADMIN, 'u:k:boiler');
  assert.match(view.text, /Доступ: 🚿 Бойлер/);
  assert.ok(view.markup.inline_keyboard.flat().some((b) => b.text === 'Guest: як Дім (👁)'));

  await w.press(ADMIN, 'u:q');
  const [found] = await w.say(ADMIN, 'gue');
  const names = found.markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(names.includes('Guest: як Дім (👁)') && !names.some((n) => n.startsWith('Member')));
  await w.press(ADMIN, `u:c:${GUEST}`);
  await w.press(ADMIN, 'u:s');
  assert.equal(
    w.db.prepare("SELECT perm FROM user_devices WHERE chat_id=? AND device='boiler'").get(GUEST).perm,
    'none'
  );
});
