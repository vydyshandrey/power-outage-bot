/**
 * Static configuration and tunables.
 *
 * Everything specific to a particular home (inverter type, device IDs, time zone)
 * comes from Worker variables, see wrangler.toml → [vars]. Credentials come from
 * Worker secrets and never appear in the code.
 */

export const VERSION = '1.5.0';

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

/**
 * Roles. An admin sees and controls everything and manages people; a user gets a level per site.
 * "control" and "notify" are roles from before 1.5.0; the schema v4 migration turns them into "user".
 */
export const ROLES = { admin: 'Адмін', user: 'Користувач' };
export const RANK = { user: 1, notify: 1, control: 1, admin: 3 };

/**
 * Access levels, from least to most. A site level covers the site's status, its grid
 * notifications and, at "control", switching its devices. A device can be limited below
 * its site's level, never raised above it.
 */
export const LEVELS = ['none', 'view', 'control'];
export const LEVEL_LABEL = { none: '🚫 немає', view: '👁 бачить', control: '🎛 керує' };

/** Controllable devices and the site each belongs to. New device types are added here. */
export const DEVICES = {
  boiler: { name: 'Бойлер', icon: '🚿', site: 'primary' },
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

/** Permission key of a site. */
export const siteKey = (site) => `site.${site.id}`;

/**
 * Sites with the configured devices that belong to them: the structure of the permissions screen.
 * @param {Env} env
 * @returns {Array<{site: Site, key: string, devices: string[]}>}
 */
export function siteTree(env) {
  const sites = sitesOf(env);
  return sites.map((site) => ({
    site,
    key: siteKey(site),
    devices: Object.keys(DEVICES).filter(
      (dev) =>
        deviceConfigured(env, dev) && (DEVICES[dev].site === 'primary' ? site.primary : DEVICES[dev].site === site.id)
    ),
  }));
}

/** The site a device belongs to. @returns {Site} */
export const deviceSite = (env, dev) => siteTree(env).find((n) => n.devices.includes(dev))?.site || sitesOf(env)[0];

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
