import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getUser, migrate } from '../src/db.js';
import { ADMIN, GUEST, MEMBER, VC_PASSWORD, VC_USER, createWorld, textsTo } from './helpers/world.mjs';

/** Home on Deye (with the boiler) plus a workshop on SmartValue. */
function twoSites() {
  const w = createWorld();
  Object.assign(w.env, {
    SITES: JSON.stringify([
      { id: 'home', name: 'Дім', inverter: 'deye' },
      { id: 'shop', name: 'Майстерня', inverter: 'valueclouds' },
    ]),
    VC_USER,
    VC_PASSWORD,
    VC_PN: 'I30000230600000000',
    VC_SN: '0000000001',
    VC_DEVCODE: '6409',
    VC_DEVADDR: '255',
  });
  return w;
}

test('upgrade to v4: old roles become levels on the first site, nobody loses access', async () => {
  const w = createWorld();
  await getUser(w.env, ADMIN); // opens the database first, as a running worker would have
  w.db.exec(`DELETE FROM user_devices; UPDATE kv SET v='2' WHERE k='schema_v';
    UPDATE users SET role='control' WHERE chat_id=${MEMBER}; UPDATE users SET role='notify' WHERE chat_id=${GUEST};
    INSERT INTO users (chat_id,name,username,role,status,created) VALUES (50,'Kid','kid','control','approved',4), (51,'Odd','odd','notify','approved',5);
    INSERT INTO user_devices VALUES (${MEMBER},'boiler','control'),(${GUEST},'boiler','view'),
      (50,'boiler','view'),(51,'boiler','control')`);
  await migrate(w.env);
  const perms = (chat) =>
    Object.fromEntries(
      w.db
        .prepare('SELECT device, perm FROM user_devices WHERE chat_id=?')
        .all(chat)
        .map((r) => [r.device, r.perm])
    );
  assert.deepEqual(perms(MEMBER), { 'site.home': 'control' });
  assert.deepEqual(perms(GUEST), { 'site.home': 'view' });
  assert.deepEqual(perms(50), { 'site.home': 'control', boiler: 'view' }, 'a lower boiler right becomes a limit');
  assert.deepEqual(perms(51), { 'site.home': 'control' }, 'a higher boiler right lifts the site, not lost');
  assert.equal(w.db.prepare("SELECT count(*) n FROM users WHERE role IN ('control','notify')").get().n, 0);
  assert.equal(w.kv('schema_v'), '6');
});

test('two sites: notifications carry the site name and go only to people who see the site', async () => {
  const w = twoSites();
  w.db.exec(`INSERT INTO user_devices VALUES (${MEMBER},'site.shop','view')`);
  await w.tick();
  w.step(120);
  w.grid = false; // both fake inverters follow the same switch
  const off = await w.tick();

  assert.ok(textsTo(off, ADMIN).some((t) => t.startsWith('🔌 Дім · Світло зникло')));
  assert.ok(textsTo(off, ADMIN).some((t) => t.startsWith('🔌 Майстерня · Світло зникло')));
  assert.ok(textsTo(off, MEMBER).some((t) => t.startsWith('🔌 Майстерня')));
  assert.ok(!textsTo(off, GUEST).some((t) => t.includes('Майстерня')), 'guest does not see the workshop');
  assert.ok(textsTo(off, GUEST).some((t) => t.startsWith('🔌 Дім')));
  assert.deepEqual(w.controls, ['off'], 'the boiler follows the first site only');
});

test('two sites: status lists the sites the user sees', async () => {
  const w = twoSites();
  await w.tick();
  const [admin] = await w.say(ADMIN, '📊 Статус');
  assert.match(admin.text, /⚡ Дім[\s\S]*🚿 Бойлер[\s\S]*⚡ Майстерня/, 'the boiler is listed under the home site');
  assert.match(admin.text, /🔋 Батарея: 77%/);
  const [guest] = await w.say(GUEST, '📊 Статус');
  assert.doesNotMatch(guest.text, /Майстерня/);
});

test('admin opens a site to a user in the permissions screen', async () => {
  const w = twoSites();
  const [view] = await w.press(ADMIN, `u:e:${GUEST}`);
  assert.deepEqual(
    view.markup.inline_keyboard.map(([b]) => b.text),
    ['⚡ Дім: 👁 бачить', '      🚿 Бойлер: як Дім', '⚡ Майстерня: 🚫 немає', '✅ Зберегти'],
    'devices are listed under the site they belong to'
  );
  const shop = () =>
    w.db.prepare("SELECT perm FROM user_devices WHERE chat_id=? AND device='site.shop'").get(GUEST).perm;
  for (const want of ['view', 'control', 'none']) {
    await w.press(ADMIN, `u:e:${GUEST}`);
    await w.press(ADMIN, 'u:c:site.shop');
    await w.press(ADMIN, 'u:s');
    assert.equal(shop(), want);
  }
});

test('new users see the first site by default, other sites only when an admin opens them', async () => {
  const w = twoSites();
  await w.say(77, '/start');
  await w.press(ADMIN, 'a:77:user');
  const rows = Object.fromEntries(
    w.db
      .prepare('SELECT device, perm FROM user_devices WHERE chat_id=77')
      .all()
      .map((r) => [r.device, r.perm])
  );
  assert.equal(rows['site.home'], 'view');
  assert.equal(rows['site.shop'], undefined, 'no row means no access');
});

test('a broken second site does not stop the first', async () => {
  const w = twoSites();
  w.env.VC_PASSWORD = 'wrong';
  await w.tick();
  w.step(120);
  w.grid = false;
  await w.tick();
  assert.deepEqual(w.controls, ['off']);
});
