#!/usr/bin/env node
/**
 * Brings a new version of the public project into an owner's copy.
 * Used by .github/workflows/update.yml:  node apply-update.mjs <new version dir> <copy dir>
 *
 * The owner's sites, devices, texts and people live in the database, so the code can be
 * replaced wholesale. What belongs to the owner and stays:
 *   - wrangler.toml: worker name, database name and id, schedule, [vars];
 *   - .github/workflows: GitHub does not let a workflow change workflow files; if they
 *     changed, the summary says so and the owner updates them by hand;
 *   - files the owner added that the project does not have (outside src/ and test/).
 * src/ and test/ are mirrored exactly, so removed files do not linger.
 */

import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error('usage: apply-update.mjs <new version dir> <copy dir>');
  process.exit(2);
}

const SKIP = new Set(['.git', 'node_modules', '.github']);
const MIRROR = ['src', 'test'];
const notes = [];

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (dir === base && SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
}

// 1. Mirrored directories: start clean.
for (const d of MIRROR) if (existsSync(join(to, d))) rmSync(join(to, d), { recursive: true });

// 2. Everything else from the new version, except wrangler.toml (merged below).
for (const f of walk(from)) {
  if (f === 'wrangler.toml') continue;
  cpSync(join(from, f), join(to, f));
}

// 3. wrangler.toml: the new file, with the owner's own values put back.
const mine = existsSync(join(to, 'wrangler.toml')) ? readFileSync(join(to, 'wrangler.toml'), 'utf8') : '';
let next = readFileSync(join(from, 'wrangler.toml'), 'utf8');
const line = (text, key) => text.match(new RegExp(`^${key}\\s*=.*$`, 'm'))?.[0];
for (const key of ['name', 'database_name', 'database_id', 'crons']) {
  const own = line(mine, key);
  if (!own) continue;
  if (line(next, key)) next = next.replace(new RegExp(`^${key}\\s*=.*$`, 'm'), own);
  else if (key === 'database_id') next = next.replace(/^(database_name\s*=.*)$/m, `$1\n${own}`);
}
const section = (text, name) => text.match(new RegExp(`^\\[${name}\\][\\s\\S]*?(?=^\\[|(?![\\s\\S]))`, 'm'))?.[0];
const ownVars = section(mine, 'vars');
if (ownVars)
  next = section(next, 'vars') ? next.replace(section(next, 'vars'), ownVars) : `${next.trimEnd()}\n\n${ownVars}`;
writeFileSync(join(to, 'wrangler.toml'), next);

// 4. Workflows cannot be updated from a workflow: report the ones that differ.
const wf = join(from, '.github', 'workflows');
if (existsSync(wf)) {
  for (const name of readdirSync(wf)) {
    const theirs = readFileSync(join(wf, name), 'utf8');
    const p = join(to, '.github', 'workflows', name);
    if (!existsSync(p) || readFileSync(p, 'utf8') !== theirs) notes.push(name);
  }
}

const version = JSON.parse(readFileSync(join(to, 'package.json'), 'utf8')).version;
const summary = [
  `## Оновлено до v${version}`,
  notes.length
    ? `\nЗмінились файли GitHub Actions, їх треба оновити вручну (скопіювати з github.com/vydyshandrey/power-outage-bot): ${notes.map((n) => `\`.github/workflows/${n}\``).join(', ')}`
    : '',
].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
