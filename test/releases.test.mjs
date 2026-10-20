import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { VERSION } from '../src/config.js';
import { RELEASES } from '../src/releases.js';
import { ADMIN, MEMBER, createWorld, textsTo } from './helpers/world.mjs';

test('every version in CHANGELOG.md is in the bot’s release history, newest first', () => {
  const inChangelog = [
    ...readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8').matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm),
  ].map((m) => m[1]);
  assert.deepEqual(
    RELEASES.map((r) => r.v),
    inChangelog
  );
  assert.equal(RELEASES[0].v, VERSION);
});

test('"🚀 Що нового": admins always, others when the admin turns it on', async () => {
  const w = createWorld();
  const [admin] = await w.say(ADMIN, '🚀 Що нового');
  assert.match(admin.text, new RegExp(`Зараз <b>v${VERSION.replace(/\./g, '\\.')}</b>`));
  const older = await w.press(ADMIN, 'rl:1');
  assert.doesNotMatch(older[0].text, new RegExp(`<b>v${VERSION.replace(/\./g, '\\.')}</b> ✨`));

  assert.equal((await w.say(MEMBER, '🚀 Що нового'))[0].text.startsWith('🚀'), false, 'hidden from members');
  const on = await w.press(ADMIN, 's:rv');
  const told = textsTo(on, MEMBER).find((t) => t.includes('Що нового'));
  assert.ok(told, 'members are told about the new button');
  assert.ok(JSON.stringify(on.find((m) => m.chat === MEMBER).markup).includes('🚀 Що нового'));
  assert.match((await w.say(MEMBER, '🚀 Що нового'))[0].text, /^🚀 <b>Що нового<\/b>/);
});
