/**
 * The periodic check ("tick"), run every 2 minutes.
 *
 *   1. Read the inverter. Cloud hiccups are silent; an outage longer than
 *      GIVEUP_SEC produces one alert and one "recovered" message.
 *   2. Detect grid transitions and notify everyone, with the duration of the previous state.
 *   3. Grid lost → switch the boiler off, retrying on every tick until it works.
 *   4. Grid back for ON_DELAY_SEC → switch the boiler on, but only if automation switched it off.
 *   5. If a boiler action keeps failing for GIVEUP_SEC, ask a human once, keep retrying.
 */

import { ERROR_REPEAT_SEC, GIVEUP_SEC, LATE_NOTE_SEC, ON_DELAY_SEC, STALE_SEC, VERSION } from './config.js';
import { kvGet, kvSet, logEnergy, logEvent } from './db.js';
import { inverterConfigured, inverterLatest, inverterName } from './inverter.js';
import { Midea, boilerPower } from './midea.js';
import { broadcast, broadcastDevice, mainKeyboard } from './telegram.js';
import { NL, esc, fmtDur, fmtHM, now } from './util.js';

const AUTOMATION = 'автоматика';

/** Sends an error to admins, de-duplicating identical messages for an hour. */
export async function reportError(env, where, e) {
  const msg = `${where}: ${e.message || e}`;
  const last = JSON.parse((await kvGet(env, 'last_err')) || '{}');
  if (last.msg !== msg || now() - (last.ts || 0) > ERROR_REPEAT_SEC) {
    await kvSet(env, 'last_err', JSON.stringify({ msg, ts: now() }));
    await broadcast(env, `⚠️ Помилка автоматики${NL}<code>${esc(msg)}</code>`, 'admin');
  }
}

/**
 * What changed for people using the bot, per minor release. A minor release listed here
 * is announced to everyone with the refreshed keyboard; anything else is a short note
 * to admins (internal changes, support for other hardware).
 */
const USER_NOTES = {
  1.1: [
    '• Керування пристроями тепер у меню «🏠 Пристрої».',
    '• У статусі видно, скільки світло є чи немає, і споживання від інвертора.',
    '• Сповіщення про світло показують тривалість.',
  ],
};

/** Tells people about a new version once. */
export async function announce(env) {
  const minor = VERSION.split('.').slice(0, 2).join('.');
  const prev = (await kvGet(env, 'announced')) || '';
  if (prev === VERSION) return;
  await kvSet(env, 'announced', VERSION);
  const notes = USER_NOTES[minor];
  if (!notes || prev.startsWith(minor)) {
    await broadcast(env, `🔧 Бот оновлено до v${VERSION}.`, 'admin');
    return;
  }
  const text = [`🆕 Бот оновлено до v${VERSION}.`, ...notes].join(NL);
  await broadcast(env, text, 'notify', (u) => ({ reply_markup: mainKeyboard(u.role) }));
}

/* ---------- inverter availability ---------- */

// KV keys keep their historical "deye_" names so existing deployments carry their state over.

async function inverterDown(env, e) {
  const since = Number(await kvGet(env, 'deye_fail_since')) || 0;
  if (!since) return kvSet(env, 'deye_fail_since', now());
  if (now() - since < GIVEUP_SEC || (await kvGet(env, 'deye_alerted')) === '1') return;
  await kvSet(env, 'deye_alerted', '1');
  await broadcast(
    env,
    `⚠️ ${inverterName(env)} не відповідає ${fmtDur(now() - since)}. Автоматика на паузі, доки зв'язок не повернеться.${NL}<code>${esc(e.message || e)}</code>`,
    'admin'
  );
}

async function inverterUp(env) {
  const since = Number(await kvGet(env, 'deye_fail_since')) || 0;
  if (!since) return;
  await kvSet(env, 'deye_fail_since', '0');
  if ((await kvGet(env, 'deye_alerted')) === '1') {
    await kvSet(env, 'deye_alerted', '0');
    await broadcast(
      env,
      `✅ ${inverterName(env)} знову відповідає (не було зв'язку ${fmtDur(now() - since)}).`,
      'admin'
    );
  }
}

/** Pauses automation while the logger sends no fresh data. @returns {Promise<boolean>} true if stale */
async function checkStale(env, reading) {
  const age = now() - reading.ts;
  if (age > STALE_SEC) {
    if ((await kvGet(env, 'stale')) !== '1') {
      await kvSet(env, 'stale', '1');
      await broadcast(
        env,
        `⚠️ Дані ${inverterName(env)} не оновлювались ${fmtDur(age)}. Автоматика на паузі, доки логер не повернеться.`,
        'admin'
      );
    }
    return true;
  }
  if ((await kvGet(env, 'stale')) === '1') {
    await kvSet(env, 'stale', '0');
    await broadcast(env, `✅ Дані ${inverterName(env)} знову оновлюються.`, 'admin');
  }
  return false;
}

/* ---------- grid transitions ---------- */

/** Records a grid change and notifies everyone. Resets the boiler task state. */
async function onGridChange(env, prev, d) {
  const prevSince = Number(await kvGet(env, 'grid_since')) || null;
  const dur = prevSince ? d.ts - prevSince : null;
  await kvSet(env, 'grid', d.grid ? 'on' : 'off');
  await kvSet(env, 'grid_since', d.ts);

  if (prev !== null) {
    await logEvent(env, d.grid ? 'grid_on' : 'grid_off', 'grid', 'inverter', { at: d.ts, prev_dur: dur });
    const lines = d.grid
      ? [`💡 Світло з'явилось о ${fmtHM(d.ts)}, ${d.volt} В.`, dur ? `Світла не було ${fmtDur(dur)}.` : null]
      : [
          `🔌 Світло зникло о ${fmtHM(d.ts)}.`,
          dur ? `Світло було ${fmtDur(dur)}.` : null,
          `🔋 Від інвертора: споживання ${d.load} Вт, батарея ${d.soc}%.`,
        ];
    await broadcast(env, lines.filter(Boolean).join(NL));
  }

  // Grid lost → the boiler must go off; the task stays open until it succeeds.
  await kvSet(env, 'want_off', d.grid ? '0' : '1');
  await kvSet(env, 'off_alerted', '0');
  await kvSet(env, 'on_alerted', '0');
}

/* ---------- boiler control ---------- */

/** One "do it manually" message after GIVEUP_SEC of failures; retries continue. */
async function escalateOnce(env, flagKey, since, text) {
  if (now() - since < GIVEUP_SEC || (await kvGet(env, flagKey)) === '1') return;
  await kvSet(env, flagKey, '1');
  await broadcastDevice(env, 'boiler', text);
}

const lateNote = (since, template) => (now() - since > LATE_NOTE_SEC ? template(fmtDur(now() - since)) : '');

async function switchBoilerOff(env, d) {
  const since = Number(await kvGet(env, 'grid_since')) || d.ts;
  try {
    const st = await new Midea(env).status();
    if (st?.power === 'on') {
      await boilerPower(env, false, AUTOMATION);
      await kvSet(env, 'boiler_auto_off', '1');
      const late = lateNote(since, (t) => ` (через ${t} після зникнення світла)`);
      await broadcastDevice(env, 'boiler', `⛔ Бойлер вимкнено автоматично${late}.`);
    }
    await kvSet(env, 'want_off', '0');
  } catch {
    await escalateOnce(
      env,
      'off_alerted',
      since,
      '⚠️ Не вдалося вимкнути бойлер за 10 хв: Midea не відповідає. Вимкни його вручну. Бот пробуватиме далі.'
    );
  }
}

async function switchBoilerBackOn(env, d) {
  const gridSince = Number(await kvGet(env, 'grid_since')) || d.ts;
  if (d.ts - gridSince < ON_DELAY_SEC) return;
  const since = gridSince + ON_DELAY_SEC;
  try {
    await boilerPower(env, true, AUTOMATION);
    await kvSet(env, 'boiler_auto_off', '0');
    const late = lateNote(since, (t) => ` (із запізненням ${t})`);
    await broadcastDevice(env, 'boiler', `🔥 Бойлер увімкнено автоматично${late}.`);
  } catch {
    await escalateOnce(
      env,
      'on_alerted',
      since,
      '⚠️ Не вдалося увімкнути бойлер за 10 хв після повернення світла: Midea не відповідає. Увімкни його вручну. Бот пробуватиме далі.'
    );
  }
}

/* ---------- entry point ---------- */

/** @param {import('./config.js').Env} env */
export async function tick(env) {
  await announce(env);
  if (!inverterConfigured(env)) return; // device IDs not in wrangler.toml yet

  let d;
  try {
    d = await inverterLatest(env);
  } catch (e) {
    return inverterDown(env, e);
  }
  await inverterUp(env);

  if (String(d.ts) !== (await kvGet(env, 'last_deye_ts'))) {
    await kvSet(env, 'last_deye_ts', d.ts);
    await logEnergy(env, d);
  }

  if (await checkStale(env, d)) return;

  const prev = await kvGet(env, 'grid');
  if (prev !== (d.grid ? 'on' : 'off')) {
    await onGridChange(env, prev, d);
    if (d.grid) return; // switching back on waits for ON_DELAY_SEC of stable grid
  }

  if (!env.MIDEA_DEVICE_ID) return; // no boiler: notifications only

  if (!d.grid && (await kvGet(env, 'want_off')) === '1') return switchBoilerOff(env, d);
  if (d.grid && (await kvGet(env, 'boiler_auto_off')) === '1') return switchBoilerBackOn(env, d);
}
