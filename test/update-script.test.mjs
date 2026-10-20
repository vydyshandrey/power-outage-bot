import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const script = new URL('../scripts/apply-update.mjs', import.meta.url).pathname;

function tree(root, files) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

test('an update replaces the code and keeps what belongs to the owner', () => {
  const base = mkdtempSync(join(tmpdir(), 'upd-'));
  const from = join(base, 'new');
  const to = join(base, 'mine');
  tree(from, {
    'package.json': '{"version":"9.0.0"}',
    'src/index.js': 'new code',
    'test/a.test.mjs': 'new test',
    'README.md': 'new readme',
    '.github/workflows/update.yml': 'new workflow',
    'wrangler.toml': [
      'name = "home-bot"',
      'compatibility_date = "2027-01-01"',
      '[[d1_databases]]',
      'binding = "DB"',
      'database_name = "home-bot"',
      '[triggers]',
      'crons = ["*/2 * * * *"]',
      '[vars]',
      'TZ = "Europe/Kyiv"',
      '',
    ].join('\n'),
  });
  tree(to, {
    'package.json': '{"version":"1.0.0"}',
    'src/index.js': 'old code',
    'src/removed.js': 'gone upstream',
    'notes.txt': 'mine',
    '.github/workflows/update.yml': 'old workflow',
    'wrangler.toml': [
      'name = "my-bot"',
      'compatibility_date = "2026-01-01"',
      '[[d1_databases]]',
      'binding = "DB"',
      'database_name = "my-db"',
      'database_id = "abc-123"',
      '[triggers]',
      'crons = []',
      '[vars]',
      'NOTIFY_NAME = "Помічник"',
      '',
    ].join('\n'),
  });

  const out = execFileSync('node', [script, from, to], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: '' },
  });
  assert.match(out, /Оновлено до v9\.0\.0/);
  assert.match(out, /update\.yml/, 'reports workflows to update by hand');

  assert.equal(readFileSync(join(to, 'src/index.js'), 'utf8'), 'new code');
  assert.ok(!existsSync(join(to, 'src/removed.js')), 'code removed upstream does not linger');
  assert.equal(readFileSync(join(to, 'notes.txt'), 'utf8'), 'mine');
  assert.equal(readFileSync(join(to, '.github/workflows/update.yml'), 'utf8'), 'old workflow');

  const w = readFileSync(join(to, 'wrangler.toml'), 'utf8');
  assert.match(w, /^name = "my-bot"$/m);
  assert.match(w, /^compatibility_date = "2027-01-01"$/m, 'technical settings come from the new version');
  assert.match(w, /^database_name = "my-db"\ndatabase_id = "abc-123"$/m);
  assert.match(w, /^crons = \[\]$/m);
  assert.match(w, /\[vars\]\nNOTIFY_NAME = "Помічник"/);
  assert.doesNotMatch(w, /TZ = /);
});
