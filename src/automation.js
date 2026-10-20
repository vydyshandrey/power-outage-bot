/**
 * The periodic check ("tick"), run every 2 minutes, for every site.
 *
 *   1. Read the inverter. Cloud hiccups are silent; an outage longer than
 *      GIVEUP_SEC produces one alert and one "recovered" message.
 *   2. Detect grid transitions and notify the site's viewers, with the duration of the previous state.
 *   3. Grid lost → switch the site's automated devices off, retrying on every tick until it works.
 *   4. Grid back for ON_DELAY_SEC → switch them on, but only those automation switched off.
 *   5. If a device action keeps failing for GIVEUP_SEC, ask a human once, keep retrying.
 */

import {
  ERROR_REPEAT_SEC,
  GIVEUP_SEC,
  LATE_NOTE_SEC,
  ON_DELAY_SEC,
  STALE_SEC,
  VERSION,
  controllable,
  devicesOf,
  siteKey,
  sitesOf,
} from './config.js';
import { kvGet, kvSet, logEnergy, logEvent } from './db.js';
import { DK, deviceState, setDevicePower } from './devices.js';
import { inverterConfigured, inverterLatest, inverterName } from './inverter.js';
import { render } from './messages.js';
import { broadcast, broadcastDevice, mainKeyboard } from './telegram.js';
import { checkUpdates } from './updates.js';
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
 * Release notes per minor release. USER_NOTES go to everyone with the refreshed keyboard;
 * ADMIN_NOTES go to admins only (new settings, other hardware). A release with neither,
 * or a patch release, gets a one-line note to admins.
 */
const USER_NOTES = {
  1.1: [
    '• Керування пристроями тепер у меню «🏠 Пристрої».',
    '• У статусі видно, скільки світло є чи немає, і споживання від інвертора.',
    '• Сповіщення про світло показують тривалість.',
  ],
};
const ADMIN_NOTES = {
  1.6: [
    "• ⚙️ Налаштування: об'єкти, пристрої, тексти повідомлень, імена людей і часовий пояс — тепер у боті.",
    '• Нові версії приходять повідомленням з кнопкою «⬆️ Оновити».',
  ],
};

/** Tells people about a new version once. */
export async function announce(env) {
  const minor = VERSION.split('.').slice(0, 2).join('.');
  const prev = (await kvGet(env, 'announced')) || '';
  if (prev === VERSION) return;
  await kvSet(env, 'announced', VERSION);
  const newMinor = !prev.startsWith(minor);
  if (newMinor && USER_NOTES[minor]) {
    const text = [`🆕 Бот оновлено до v${VERSION}.`, ...USER_NOTES[minor]].join(NL);
    await broadcast(env, text, 'user', (u) => ({ reply_markup: mainKeyboard(u.role) }));
    return;
  }
  const notes = newMinor ? ADMIN_NOTES[minor] || [] : [];
  await broadcast(env, [`🔧 Бот оновлено до v${VERSION}.`, ...notes].join(NL), 'admin', (u) => ({
    reply_markup: mainKeyboard(u.role),
  }));
}

/* ---------- per-site state ---------- */

/**
 * Storage key of a site's state. The first site keeps the historical names, so a
 * deployment that predates sites carries its state over; others get an "@id" suffix.
 * ("deye_" names are historical too: they hold the state of whatever inverter the site has.)
 */
export const K = (site, k) => (site.primary ? k : `${k}@${site.id}`);

/** Event-log device for a site's grid events; the first site keeps the historical "grid". */
export const gridDevice = (site) => (site.primary ? 'grid' : `grid@${site.id}`);

const several = (env) => sitesOf(env).length > 1;

/** Variables every site message has. */
const siteVars = (env, site) => ({
  where: several(env) ? `${site.name} · ` : '',
  object: site.name,
  source: `${inverterName(site)}${several(env) ? ` (${site.name})` : ''}`,
});

/* ---------- inverter availability ---------- */

async function inverterDown(env, site, e) {
  const since = Number(await kvGet(env, K(site, 'deye_fail_since'))) || 0;
  if (!since) return kvSet(env, K(site, 'deye_fail_since'), now());
  if (now() - since < GIVEUP_SEC || (await kvGet(env, K(site, 'deye_alerted'))) === '1') return;
  await kvSet(env, K(site, 'deye_alerted'), '1');
  const vars = { ...siteVars(env, site), duration: fmtDur(now() - since), error: e.message || String(e) };
  await broadcast(env, render(env, 'inverter_down', vars), 'admin');
}

async function inverterUp(env, site) {
  const since = Number(await kvGet(env, K(site, 'deye_fail_since'))) || 0;
  if (!since) return;
  await kvSet(env, K(site, 'deye_fail_since'), '0');
  if ((await kvGet(env, K(site, 'deye_alerted'))) === '1') {
    await kvSet(env, K(site, 'deye_alerted'), '0');
    const vars = { ...siteVars(env, site), duration: fmtDur(now() - since) };
    await broadcast(env, render(env, 'inverter_up', vars), 'admin');
  }
}

/** Pauses automation while the logger sends no fresh data. @returns {Promise<boolean>} true if stale */
async function checkStale(env, site, reading) {
  const age = now() - reading.ts;
  const key = K(site, 'stale');
  if (age > STALE_SEC) {
    if ((await kvGet(env, key)) !== '1') {
      await kvSet(env, key, '1');
      await broadcast(env, render(env, 'stale', { ...siteVars(env, site), duration: fmtDur(age) }), 'admin');
    }
    return true;
  }
  if ((await kvGet(env, key)) === '1') {
    await kvSet(env, key, '0');
    await broadcast(env, render(env, 'fresh', siteVars(env, site)), 'admin');
  }
  return false;
}

/* ---------- grid transitions ---------- */

/** Automated devices of a site. */
const automated = (env, site) => devicesOf(env).filter((d) => d.site === site.id && d.auto && controllable(d));

/** Records a grid change, notifies the site's viewers and opens the device tasks. */
async function onGridChange(env, site, prev, d) {
  const prevSince = Number(await kvGet(env, K(site, 'grid_since'))) || null;
  const dur = prevSince ? d.ts - prevSince : null;
  await kvSet(env, K(site, 'grid'), d.grid ? 'on' : 'off');
  await kvSet(env, K(site, 'grid_since'), d.ts);

  if (prev !== null) {
    await logEvent(env, d.grid ? 'grid_on' : 'grid_off', gridDevice(site), 'inverter', { at: d.ts, prev_dur: dur });
    const vars = {
      ...siteVars(env, site),
      time: fmtHM(d.ts),
      duration: dur ? fmtDur(dur) : '',
      load: d.load,
      soc: d.soc,
      volt: d.volt,
    };
    await broadcastDevice(env, siteKey(site), render(env, d.grid ? 'grid_on' : 'grid_off', vars));
  }

  // Grid lost → the devices must go off; each task stays open until it succeeds.
  for (const dev of automated(env, site)) {
    await kvSet(env, DK(dev, 'want_off'), d.grid ? '0' : '1');
    await kvSet(env, DK(dev, 'off_alerted'), '0');
    await kvSet(env, DK(dev, 'on_alerted'), '0');
  }
}

/* ---------- device control ---------- */

/** One "do it manually" message after GIVEUP_SEC of failures; retries continue. */
async function escalateOnce(env, dev, flag, since, key, site) {
  if (now() - since < GIVEUP_SEC || (await kvGet(env, DK(dev, flag))) === '1') return;
  await kvSet(env, DK(dev, flag), '1');
  await broadcastDevice(env, dev.id, render(env, key, { device: dev.name, object: site.name }));
}

const delay = (since) => (now() - since > LATE_NOTE_SEC ? fmtDur(now() - since) : '');

async function switchOff(env, site, dev, d) {
  const since = Number(await kvGet(env, K(site, 'grid_since'))) || d.ts;
  try {
    if ((await deviceState(env, dev)).on) {
      await setDevicePower(env, dev, false, AUTOMATION);
      await kvSet(env, DK(dev, 'boiler_auto_off'), '1');
      const vars = { device: dev.name, object: site.name, delay: delay(since) };
      await broadcastDevice(env, dev.id, render(env, 'device_auto_off', vars));
    }
    await kvSet(env, DK(dev, 'want_off'), '0');
  } catch {
    await escalateOnce(env, dev, 'off_alerted', since, 'device_off_failed', site);
  }
}

async function switchBackOn(env, site, dev, d) {
  const gridSince = Number(await kvGet(env, K(site, 'grid_since'))) || d.ts;
  if (d.ts - gridSince < ON_DELAY_SEC) return;
  const since = gridSince + ON_DELAY_SEC;
  try {
    await setDevicePower(env, dev, true, AUTOMATION);
    await kvSet(env, DK(dev, 'boiler_auto_off'), '0');
    const vars = { device: dev.name, object: site.name, delay: delay(since) };
    await broadcastDevice(env, dev.id, render(env, 'device_auto_on', vars));
  } catch {
    await escalateOnce(env, dev, 'on_alerted', since, 'device_on_failed', site);
  }
}

/* ---------- entry point ---------- */

/** One site: read its inverter, report grid changes, drive its automated devices. */
async function tickSite(env, site) {
  if (!inverterConfigured(env, site)) return; // the inverter is not chosen yet

  let d;
  try {
    d = await inverterLatest(env, site);
  } catch (e) {
    return inverterDown(env, site, e);
  }
  await inverterUp(env, site);

  // The energy log has one series; it belongs to the first site.
  if (site.primary && String(d.ts) !== (await kvGet(env, 'last_deye_ts'))) {
    await kvSet(env, 'last_deye_ts', d.ts);
    await logEnergy(env, d);
  }

  if (await checkStale(env, site, d)) return;

  const prev = await kvGet(env, K(site, 'grid'));
  if (prev !== (d.grid ? 'on' : 'off')) {
    await onGridChange(env, site, prev, d);
    if (d.grid) return; // switching back on waits for ON_DELAY_SEC of stable grid
  }

  for (const dev of automated(env, site)) {
    try {
      if (!d.grid && (await kvGet(env, DK(dev, 'want_off'))) === '1') await switchOff(env, site, dev, d);
      if (d.grid && (await kvGet(env, DK(dev, 'boiler_auto_off'))) === '1') await switchBackOn(env, site, dev, d);
    } catch (e) {
      await reportError(env, dev.name, e);
    }
  }
}

/** @param {import('./config.js').Env} env */
export async function tick(env) {
  await announce(env);
  // Sites are independent: a failure at one must not stop the others.
  for (const site of sitesOf(env)) {
    try {
      await tickSite(env, site);
    } catch (e) {
      await reportError(env, site.name, e);
    }
  }
  try {
    await checkUpdates(env);
  } catch {
    /* an unreachable GitHub must not disturb the automation */
  }
}
