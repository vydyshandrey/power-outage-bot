import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrate } from '../src/db.js';
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

test('upgrade: users who got grid notifications keep them for the first site', async () => {
  const w = createWorld();
  w.db.exec("DELETE FROM user_devices WHERE device LIKE 'site.%'; UPDATE kv SET v='2' WHERE k='schema_v'");
  await migrate(w.env);
  assert.equal(
    w.db.prepare("SELECT perm FROM user_devices WHERE chat_id=? AND device='site.home'").get(GUEST).perm,
    'view'
  );
  assert.equal(w.kv('schema_v'), '3');
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
  assert.match(admin.text, /⚡ Дім[\s\S]*⚡ Майстерня/);
  assert.match(admin.text, /🔋 Батарея: 77%/);
  const [guest] = await w.say(GUEST, '📊 Статус');
  assert.doesNotMatch(guest.text, /Майстерня/);
});

test('admin opens a site to a user in the permissions screen', async () => {
  const w = twoSites();
  const [view] = await w.press(ADMIN, `pd:${GUEST}`);
  assert.ok(view.markup.inline_keyboard.some(([b]) => b.text === '⚡ Майстерня: 🚫 не бачить'));
  await w.press(ADMIN, `pc:${GUEST}:site.shop`);
  const perm = w.db.prepare("SELECT perm FROM user_devices WHERE chat_id=? AND device='site.shop'").get(GUEST).perm;
  assert.equal(perm, 'view');
  await w.press(ADMIN, `pc:${GUEST}:site.shop`);
  assert.equal(
    w.db.prepare("SELECT perm FROM user_devices WHERE chat_id=? AND device='site.shop'").get(GUEST).perm,
    'none',
    'a site toggles between seen and not seen'
  );
});

test('new users see the first site by default, other sites only when an admin opens them', async () => {
  const w = twoSites();
  await w.say(77, '/start');
  await w.press(ADMIN, 'a:77:notify');
  const rows = Object.fromEntries(
    w.db
      .prepare('SELECT device, perm FROM user_devices WHERE chat_id=77')
      .all()
      .map((r) => [r.device, r.perm])
  );
  assert.equal(rows['site.home'], 'view');
  assert.equal(rows['site.shop'], 'none');
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
