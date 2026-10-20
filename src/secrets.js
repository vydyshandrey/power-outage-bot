/**
 * Cloud passwords per cabinet.
 *
 * The first cabinet (the deployment owner's) may keep them in Cloudflare secrets, as before.
 * Every cabinet can also enter them in the bot: they are stored in the database encrypted
 * with AES-GCM; the key is derived from the MASTER_KEY secret (or ACCESS_KEY when there is
 * none). Without that key the stored values cannot be read, also not from a database copy.
 * If ACCESS_KEY is changed without a MASTER_KEY, the stored passwords have to be entered again.
 *
 * Code that talks to a cloud gets `credEnv(env, cabinet)`: the environment with that
 * cabinet's credentials and nobody else's, and a prefix for the cloud sessions it caches.
 */

import { HOME } from './config.js';
import { db } from './db.js';
import { encode } from './util.js';

/** Names of credentials; other cabinets never see the deployment's own values. */
const CREDENTIAL = /^(DEYE|DESS|VC|MIDEA)_/;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(env) {
  const material = env.MASTER_KEY || env.ACCESS_KEY;
  if (!material) throw new Error('Немає MASTER_KEY чи ACCESS_KEY для шифрування паролів');
  const raw = await crypto.subtle.digest('SHA-256', encode(`home-bot secrets v1:${material}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encrypt(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), encode(text));
  return `${b64(iv)}.${b64(data)}`;
}

async function decrypt(env, value) {
  const [iv, data] = value.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(data));
  return new TextDecoder().decode(plain);
}

/** Stores a credential of a cabinet (replacing the old value). */
export async function setSecret(env, cabinet, name, value) {
  await (
    await db(env)
  )
    .prepare(
      'INSERT INTO secrets (cabinet,name,value) VALUES (?,?,?) ON CONFLICT(cabinet,name) DO UPDATE SET value=excluded.value'
    )
    .bind(cabinet, name, await encrypt(env, value))
    .run();
  if (env.__cred) delete env.__cred[cabinet];
}

/** Removes credentials of a cabinet whose names start with the prefix. */
export async function deleteSecrets(env, cabinet, prefix) {
  await (
    await db(env)
  )
    .prepare('DELETE FROM secrets WHERE cabinet=? AND name LIKE ?')
    .bind(cabinet, `${prefix}%`)
    .run();
  if (env.__cred) delete env.__cred[cabinet];
}

/** Names of the credentials a cabinet entered in the bot. */
export async function secretNamesOf(env, cabinet) {
  const { results } = await (
    await db(env)
  )
    .prepare('SELECT name FROM secrets WHERE cabinet=? ORDER BY name')
    .bind(cabinet)
    .all();
  return results.map((r) => r.name);
}

/**
 * The environment for talking to clouds on behalf of a cabinet. Cached per request.
 * @returns {Promise<import('./config.js').Env>}
 */
export async function credEnv(env, cabinet = HOME) {
  env.__cred ||= {};
  if (env.__cred[cabinet]) return env.__cred[cabinet];
  const out = { ...env, CRED_PREFIX: cabinet === HOME ? '' : `${cabinet}:` };
  if (cabinet !== HOME) for (const k of Object.keys(out)) if (CREDENTIAL.test(k)) delete out[k];
  const { results } = await (
    await db(env)
  )
    .prepare('SELECT name, value FROM secrets WHERE cabinet=?')
    .bind(cabinet)
    .all();
  for (const r of results) {
    try {
      out[r.name] = await decrypt(env, r.value);
    } catch {
      /* a value that cannot be decrypted counts as not entered */
    }
  }
  env.__cred[cabinet] = out;
  return out;
}
