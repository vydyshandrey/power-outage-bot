import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ADMIN, DESS_PASSWORD, DESS_USER, GUEST, MEMBER, createWorld, textsTo } from './helpers/world.mjs';

const STRANGER = 500;
const buttons = (msgs) => msgs.flatMap((m) => m.markup?.inline_keyboard?.flat() || []);

/** A stranger creates a cabinet and adds a SmartESS inverter, entering the passwords in the bot. */
async function strangerWithCabinet(w) {
  await w.say(STRANGER, '/start', 'Olena');
  await w.press(STRANGER, 'cb:new');
  await w.press(STRANGER, 's:sa');
  await w.say(STRANGER, 'Дача');
  await w.press(STRANGER, 's:sc:dess');
  await w.press(STRANGER, 's:sk:1');
  await w.say(STRANGER, DESS_USER);
  await w.say(STRANGER, DESS_PASSWORD);
  return w.press(STRANGER, 's:sp:0');
}

test('sign-up is by request until the operator opens it', async () => {
  const w = createWorld();
  const asked = await w.say(STRANGER, '/start', 'Olena');
  assert.ok(textsTo(asked, STRANGER).includes('Запит на доступ надіслано адміністратору.'));
  assert.ok(textsTo(await w.press(ADMIN, 's:su'), 'edit').some((t) => t.length));
  assert.equal(w.kv('cfg.signup'), 'open');
  assert.ok(textsTo(await w.press(MEMBER, 's:su'), 'answer').some((t) => t.startsWith('Лише')));
});

test('a stranger creates a cabinet of their own; the owner’s cabinet stays invisible to them', async () => {
  const w = createWorld().openSignup();
  const hello = await w.say(STRANGER, '/start', 'Olena');
  assert.ok(buttons(hello).some((b) => b.callback_data === 'cb:new'));
  const made = await w.press(STRANGER, 'cb:new');
  assert.ok(textsTo(made, STRANGER).some((t) => t.startsWith('✅ Кабінет «Кабінет Olena» створено')));
  assert.ok(JSON.stringify(made.find((m) => m.chat === STRANGER && m.markup?.keyboard)).includes('Налаштування'));

  const sites = await w.press(STRANGER, 's:sl');
  assert.doesNotMatch(sites[0].text + JSON.stringify(sites[0].markup), /Дім|Майстерня/);
  assert.ok(textsTo(await w.press(STRANGER, 's:so:home'), 'answer').includes("Об'єкт не знайдено"));
  assert.ok(textsTo(await w.press(STRANGER, 'u:k:site.home'), 'answer').includes('Не знайдено'));
  assert.ok(textsTo(await w.press(STRANGER, 'dc:boiler:off'), 'answer').includes('Немає доступу до пристрою'));
  assert.ok(textsTo(await w.press(STRANGER, 's:tl'), 'answer').includes('Лише для власника бота'));
  const [status] = await w.say(STRANGER, '📊 Статус');
  assert.doesNotMatch(status.text, /Бойлер|Батарея/);

  const [people] = await w.say(STRANGER, '👥 Користувачі');
  assert.doesNotMatch(people.text, /Member|Guest|Admin/);
  const [mine] = await w.say(ADMIN, '👥 Користувачі');
  assert.doesNotMatch(mine.text, /Olena/);
});

test('the cabinet’s own passwords: never the owner’s Cloudflare secrets, stored encrypted, used by the automation', async () => {
  const w = createWorld().openSignup();
  Object.assign(w.env, { DESS_USER, DESS_PASSWORD }); // the owner's secrets must not leak into other cabinets
  const saved = await strangerWithCabinet(w);
  assert.ok(textsTo(saved, STRANGER).some((t) => t.startsWith('✅ Збережено') && t.includes('Дача')));
  assert.equal(w.deleted.length, 2);
  const rows = w.db.prepare("SELECT name, value FROM secrets WHERE cabinet='c2' ORDER BY name").all();
  assert.deepEqual(
    rows.map((r) => r.name),
    ['DESS_PASSWORD', 'DESS_USER']
  );

  // The automation reads the new site with these passwords and tells only its people.
  await w.tick();
  w.step(120);
  w.grid = false;
  const off = await w.tick();
  assert.ok(
    textsTo(off, STRANGER).some((t) => t.startsWith('🔌 Дача · Світло зникло') || t.startsWith('🔌 Світло зникло'))
  );
  assert.ok(!textsTo(off, MEMBER).some((t) => t.includes('Дача')), 'the owner’s people do not hear about it');
});

test('a wrong password can be entered again from «🔑 Паролі хмар»', async () => {
  const w = createWorld().openSignup();
  await w.say(STRANGER, '/start', 'Olena');
  await w.press(STRANGER, 'cb:new');
  await w.press(STRANGER, 's:sa');
  await w.say(STRANGER, 'Дача');
  await w.press(STRANGER, 's:sc:dess');
  await w.press(STRANGER, 's:sk:1');
  await w.say(STRANGER, DESS_USER);
  const bad = await w.say(STRANGER, 'wrong');
  assert.ok(textsTo(bad, STRANGER).some((t) => t.startsWith('Не вдалося увійти в хмару')));
  assert.ok(buttons(bad).some((b) => b.callback_data === 's:kr:DESS:1'));
  await w.press(STRANGER, 's:kr:DESS:1');
  await w.say(STRANGER, DESS_USER);
  const ok = await w.say(STRANGER, DESS_PASSWORD);
  assert.ok(
    buttons(ok).some((b) => b.callback_data === 's:sp:0'),
    'adding the inverter goes on'
  );
  const list = await w.press(STRANGER, 's:kl');
  assert.ok(buttons(list).some((b) => b.callback_data === 's:kr:DESS:1'));
});

test('an invitation link brings a person straight into the cabinet, once', async () => {
  const w = createWorld().openSignup();
  const inv = await w.press(ADMIN, 'u:i');
  const link = textsTo(inv, ADMIN).find((t) => t.includes('?start=inv_'));
  const code = link.match(/start=(inv_[0-9a-f]+)/)[1];

  const joined = await w.say(77, `/start ${code}`, 'Taras');
  assert.ok(textsTo(joined, 77).some((t) => t.startsWith('✅ Ти в кабінеті «Мій кабінет»')));
  assert.ok(textsTo(joined, ADMIN).some((t) => t.includes('Taras') && t.includes('за запрошенням')));
  const perm = w.db.prepare("SELECT perm FROM user_devices WHERE chat_id=77 AND device='site.home'").get();
  assert.equal(perm.perm, 'view');
  const [status] = await w.say(77, '📊 Статус');
  assert.match(status.text, /Світло є/);

  const again = await w.say(78, `/start ${code}`);
  assert.ok(textsTo(again, 78).some((t) => t.includes('вже використане')));
});

test('a person can be in two cabinets; each admin manages only their own people', async () => {
  const w = createWorld().openSignup();
  await strangerWithCabinet(w);
  const inv = await w.press(STRANGER, 'u:i');
  const code = textsTo(inv, STRANGER)
    .find((t) => t.includes('?start=inv_'))
    .match(/start=(inv_[0-9a-f]+)/)[1];
  await w.say(GUEST, `/start ${code}`);

  const [status] = await w.say(GUEST, '📊 Статус');
  assert.match(status.text, /Дім[\s\S]*Дача|Дача[\s\S]*Дім/, 'sees both cabinets');
  // The stranger cannot touch the guest's access to the owner's home.
  await w.press(STRANGER, `u:e:${GUEST}`);
  assert.ok(textsTo(await w.press(STRANGER, 'u:c:site.home'), 'answer').includes('Не можна'));
  // Removing from one cabinet leaves the other.
  await w.press(STRANGER, `r:${GUEST}`);
  const [after] = await w.say(GUEST, '📊 Статус');
  assert.match(after.text, /Світло є/);
  assert.doesNotMatch(after.text, /Дача/);
});
