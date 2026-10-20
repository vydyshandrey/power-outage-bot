import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VERSION } from '../src/config.js';
import { changesSince, compareVersions } from '../src/updates.js';
import { ADMIN, MEMBER, createWorld, textsTo } from './helpers/world.mjs';

const [maj, min] = VERSION.split('.').map(Number);
const NEXT = `${maj}.${min + 1}.0`;
const CHANGELOG = `# Журнал змін\n\n## [${NEXT}] — 2026-11-01\n\n### Додано\n\n- Розетки \`Tuya\`.\n\n## [${VERSION}] — 2026-10-20\n\n- Поточна.\n`;

test('versions compare as numbers', () => {
  assert.equal(compareVersions('1.10.0', '1.9.3'), 1);
  assert.equal(compareVersions('1.6.0', '1.6.0'), 0);
  assert.equal(compareVersions('1.5.9', '1.6.0'), -1);
});

test('only the changes newer than the running version are shown', () => {
  const text = changesSince(CHANGELOG, VERSION);
  assert.match(text, new RegExp(`<b>v${NEXT.replace(/\./g, '\\.')}</b>`));
  assert.match(text, /Розетки Tuya/);
  assert.doesNotMatch(text, /Поточна/);
});

test('admins hear about a new version once, with an update button', async () => {
  const w = createWorld();
  w.upstream = { version: NEXT, changelog: CHANGELOG };
  const first = await w.tick();
  const offer = first.find((m) => m.chat === ADMIN && m.text.startsWith('🆕 Вийшла'));
  assert.ok(offer, 'offer sent');
  assert.equal(offer.markup.inline_keyboard[0][0].callback_data, 'up:go');
  assert.equal(textsTo(first, MEMBER).filter((t) => t.startsWith('🆕')).length, 0, 'only admins');

  w.db.exec("UPDATE kv SET v='0' WHERE k='upd.checked'");
  const again = await w.tick();
  assert.equal(again.filter((m) => m.text.startsWith('🆕 Вийшла')).length, 0, 'not repeated');
});

test('the update button: asks for the repository, gives the link, or starts the workflow', async () => {
  const w = createWorld();
  const noRepo = await w.press(ADMIN, 'up:go');
  assert.match(textsTo(noRepo, ADMIN)[0], /🔗 Репозиторій/);

  await w.press(ADMIN, 's:rE');
  await w.say(ADMIN, 'https://github.com/someone/my-bot');
  const link = await w.press(ADMIN, 'up:go');
  assert.match(textsTo(link, ADMIN)[0], /github\.com\/someone\/my-bot\/actions\/workflows\/update\.yml/);
  assert.equal(w.dispatched.length, 0);

  w.env.GH_TOKEN = 'ghp_test';
  const started = await w.press(ADMIN, 'up:go');
  assert.match(textsTo(started, ADMIN)[0], /^⏳ Оновлення запущено/);
  assert.equal(
    w.dispatched[0].url,
    'https://api.github.com/repos/someone/my-bot/actions/workflows/update.yml/dispatches'
  );
  assert.equal(w.dispatched[0].auth, 'Bearer ghp_test');
});

test('members cannot start an update', async () => {
  const w = createWorld();
  const res = await w.press(MEMBER, 'up:go');
  assert.ok(textsTo(res, 'answer').includes('Лише для адміна'));
});
