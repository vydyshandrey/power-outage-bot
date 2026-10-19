import assert from 'node:assert/strict';
import { test } from 'node:test';
import { esc, fmtDur } from '../src/util.js';

test('fmtDur', () => {
  assert.equal(fmtDur(0), '0 хв');
  assert.equal(fmtDur(299), '5 хв');
  assert.equal(fmtDur(2 * 3600 + 17 * 60), '2 год 17 хв');
  assert.equal(fmtDur(27 * 3600), '1 д 3 год 0 хв');
  assert.equal(fmtDur(-5), '0 хв');
});

test('esc escapes Telegram HTML', () => {
  assert.equal(esc('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  assert.equal(esc(null), '');
});
