/**
 * Static configuration and tunables.
 *
 * Everything specific to a particular home (inverter type, device IDs, time zone)
 * comes from Worker variables, see wrangler.toml → [vars]. Credentials come from
 * Worker secrets and never appear in the code.
 */

export const VERSION = '1.4.0';

/** Grid is considered present when voltage and frequency are above these values. */
export const GRID_V_MIN = 180;
export const GRID_HZ_MIN = 45;

/** Inverter data older than this pauses automation (logger offline). Seconds. */
export const STALE_SEC = 600;

/** Grid must be stable this long before the boiler is switched back on. Seconds. */
export const ON_DELAY_SEC = 300;

/** How long to retry silently before asking a human to act. Seconds. */
export const GIVEUP_SEC = 600;

/** Notifications about late automation mention the delay only above this. Seconds. */
export const LATE_NOTE_SEC = 150;

/** Same error is re-sent to admins no more often than this. Seconds. */
export const ERROR_REPEAT_SEC = 3600;

export const DEFAULT_TZ = 'Europe/Kyiv';
export const DEFAULT_DEYE_API = 'https://eu1-developer.deyecloud.com/v1.0';

/** Roles, from least to most privileged. */
export const ROLES = { admin: 'Адмін', control: 'Керування', notify: 'Сповіщення' };
export const RANK = { notify: 1, control: 2, admin: 3 };

/** Per-device permissions; cycling order in the admin UI. */
export const PERMS = ['none', 'view', 'control'];
export const PERM_LABEL = { none: '🚫 немає', view: '👁 перегляд', control: '🎛 керування' };

/** For a site, "view" means its notifications and status; there is nothing to control. */
export const SITE_PERMS = ['none', 'view'];

/** Controllable devices. New device types (sockets, ATS, TV) are added here. */
export const DEVICES = {
  boiler: { name: 'Бойлер', icon: '🚿' },
};

/**
 * Whether a device is configured for this deployment.
 * @param {Env} env
 * @param {string} dev device key from DEVICES
 */
export const deviceConfigured = (env, dev) => (dev === 'boiler' ? Boolean(env.MIDEA_DEVICE_ID) : true);

/**
 * @typedef {object} Site
 * @property {string} id short latin id, part of storage keys; never rename it
 * @property {string} name shown in messages
 * @property {string} inverter which cloud its inverter reports to (see inverter.js)
 * @property {boolean} primary the first site: keeps the historical storage keys, owns the boiler
 */

/**
 * Sites (homes, workshops) with their inverters, from the SITES variable.
 * Without SITES there is one site, "Дім", with the inverter from INVERTER.
 * @param {Env} env
 * @returns {Site[]}
 */
export function sitesOf(env) {
  let list = env.SITES;
  if (typeof list === 'string') list = list.trim() ? JSON.parse(list) : null;
  if (!Array.isArray(list) || !list.length) list = [{ id: 'home', name: 'Дім', inverter: env.INVERTER || 'deye' }];
  return list.map((x, i) => {
    if (!/^[a-z0-9_-]+$/i.test(String(x.id))) throw new Error(`SITES: id «${x.id}» має бути латиницею без пробілів`);
    return { id: String(x.id), name: String(x.name || x.id), inverter: String(x.inverter || 'deye'), primary: i === 0 };
  });
}

/** Permission key of a site: who sees its grid notifications and status. */
export const siteKey = (site) => `site.${site.id}`;

/**
 * Everything a permission can be set on: configured devices, then sites.
 * @param {Env} env
 * @returns {Record<string, {name: string, icon: string, kind: 'device' | 'site', site?: Site}>}
 */
export function permTargets(env) {
  const out = {};
  for (const [k, v] of Object.entries(DEVICES)) if (deviceConfigured(env, k)) out[k] = { ...v, kind: 'device' };
  for (const site of sitesOf(env)) out[siteKey(site)] = { name: site.name, icon: '⚡', kind: 'site', site };
  return out;
}

/**
 * @typedef {object} Env
 * @property {D1Database} DB
 * @property {string} TG_BOT_TOKEN
 * @property {string} ACCESS_KEY
 * @property {string} [NOTIFY_KEY]
 * @property {string} [NOTIFY_NAME]
 * @property {string} [TICK_KEY]
 * @property {'deye'|'dess'|'valueclouds'} [INVERTER] inverter cloud when there is one site; default deye
 * @property {string|Array<{id: string, name: string, inverter: string}>} [SITES] several sites, see sitesOf
 * @property {string} [DEYE_APP_ID]
 * @property {string} [DEYE_APP_SECRET]
 * @property {string} [DEYE_EMAIL]
 * @property {string} [DEYE_PASSWORD]
 * @property {string} [DEYE_SN]
 * @property {string} [DEYE_API]
 * @property {string} [DESS_USER] SmartESS / WatchPower account
 * @property {string} [DESS_PASSWORD]
 * @property {'dessmonitor'|'shinemonitor'} [DESS_PLATFORM]
 * @property {string} [DESS_COMPANY_KEY]
 * @property {string} [DESS_PN] dongle (collector) PN, from /discover
 * @property {string} [DESS_SN]
 * @property {string} [DESS_DEVCODE]
 * @property {string} [DESS_DEVADDR]
 * @property {string} [VC_USER] SmartValue account
 * @property {string} [VC_PASSWORD]
 * @property {string} [VC_PN] Wi-Fi module number from its sticker
 * @property {string} [VC_SN] inverter serial number
 * @property {string} [VC_DEVCODE] default 6409, /discover finds it
 * @property {string} [VC_DEVADDR] default 255
 * @property {string} MIDEA_EMAIL
 * @property {string} MIDEA_PASSWORD
 * @property {string} [MIDEA_DEVICE_ID]
 * @property {string} [TZ]
 * @property {string} [COLO] Cloudflare data centre of the current request (diagnostics only)
 */
