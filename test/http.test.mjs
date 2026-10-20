import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCESS_KEY, ADMIN, MEMBER, NOTIFY_KEY, TICK_KEY, createWorld, textsTo } from './helpers/world.mjs';

test('service endpoints require their keys', async () => {
  const w = createWorld();
  for (const path of ['/discover', '/setup', '/tick', '/discover?key=wrong', '/tick?t=wrong']) {
    assert.equal((await w.http(path)).status, 403, path);
  }
  const forged = await w.http('/tg', { method: 'POST', body: '{}' });
  assert.equal(forged.status, 403, 'webhook without the secret header');
});

test('/discover lists Midea appliances and the inverter', async () => {
  const w = createWorld();
  const res = await w.http(`/discover?key=${ACCESS_KEY}`);
  const body = await res.json();
  assert.equal(body.midea[0].params.device_id, '100000000000001');
  assert.deepEqual(body.sites.home.found[0], { label: 'Дім · SN1', params: { sn: 'SN1' } });
});

test('/tick with TICK_KEY runs the check', async () => {
  const w = createWorld();
  const res = await w.http(`/tick?t=${TICK_KEY}`);
  assert.deepEqual(await res.json(), { ok: true });
  assert.ok(w.kv('last_deye_ts'));
});

test('/notify delivers to admins only', async () => {
  const w = createWorld();
  const res = await w.http(`/notify?k=${NOTIFY_KEY}`, {
    method: 'POST',
    body: JSON.stringify({ text: 'Готово <ok>' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(textsTo(w.sent, ADMIN), ['🤖 <b>Test</b>\nГотово &lt;ok&gt;']);
  assert.equal(textsTo(w.sent, MEMBER).length, 0);
});
