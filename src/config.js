/**
 * Static configuration and tunables.
 *
 * Everything specific to a particular home (inverter type, device IDs, time zone)
 * comes from Worker variables, see wrangler.toml → [vars]. Credentials come from
 * Worker secrets and never appear in the code.
 */

export const VERSION = '1.8.0';

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

/**
 * Device categories. An inverter tells its site about the grid and the battery; the others
 * are switched by people and by automation. New categories (socket, AC, ATS) are added here.
 */
export const CATEGORIES = {
  inverter: { name: 'Інвертор', icon: '⚡', control: false },
  boiler: { name: 'Бойлер', icon: '🚿', control: true },
};

/** Device types: a category plus the vendor cloud that serves it. Each has a driver in devices.js. */
export const DEVICE_TYPES = {
  inverter: { category: 'inverter', name: 'Інвертор', icon: '⚡' },
  midea_boiler: { category: 'boiler', name: 'Бойлер', icon: '🚿', vendor: 'Midea' },
};

/** True for devices people and automation switch on and off. @param {Device} dev */
export const controllable = (dev) => Boolean(CATEGORIES[DEVICE_TYPES[dev.type]?.category]?.control);

/**
 * @typedef {object} Site
 * @property {string} id technical id, part of storage keys; never changes
 * @property {string} name shown in messages; the owner sets it in the bot
 * @property {string} inverter which cloud its inverter reports to (see inverter.js)
 * @property {number} account which set of cloud secrets to use: 1 → DESS_USER, 2 → DESS_USER_2 …
 * @property {Record<string, string>} params inverter identifiers in that cloud (sn, pn …)
 * @property {boolean} primary the first site keeps the historical storage keys
 * @property {string | null} [source] id of the inverter device that reports the site's grid
 */

/**
 * @typedef {object} Device
 * @property {string} id technical id; "boiler" for the first one (historical storage keys)
 * @property {string} type key of DEVICE_TYPES
 * @property {string} name
 * @property {string} icon
 * @property {string} site id of the site it belongs to
 * @property {Record<string, string>} params identifiers in the vendor cloud
 * @property {boolean} auto switched off by automation when the grid goes down
 */

/**
 * Configuration that lived in wrangler.toml before 1.6.0. Used once, to seed the database
 * of an existing deployment, and as a fallback before the database is loaded.
 * @param {Env} env
 * @returns {Site[]}
 */
export function legacySites(env) {
  let list = env.SITES;
  if (typeof list === 'string') list = list.trim() ? JSON.parse(list) : null;
  if (!Array.isArray(list) || !list.length) {
    const any = env.DEYE_SN || env.DESS_SN || env.VC_SN;
    list = any ? [{ id: 'home', name: 'Дім', inverter: env.INVERTER || 'deye' }] : [];
  }
  return list.map((x, i) => {
    const inverter = String(x.inverter || 'deye');
    const params =
      inverter === 'deye'
        ? { sn: env.DEYE_SN || '' }
        : inverter === 'dess'
          ? {
              pn: env.DESS_PN,
              sn: env.DESS_SN,
              devcode: env.DESS_DEVCODE,
              devaddr: env.DESS_DEVADDR,
              platform: env.DESS_PLATFORM,
            }
          : { pn: env.VC_PN, sn: env.VC_SN, devcode: env.VC_DEVCODE, devaddr: env.VC_DEVADDR };
    for (const k of Object.keys(params)) if (!params[k]) delete params[k];
    return { id: String(x.id), name: String(x.name || x.id), inverter, account: 1, params, primary: i === 0 };
  });
}

/** @param {Env} env @returns {Device[]} */
export function legacyDevices(env) {
  const site = legacySites(env)[0];
  if (!env.MIDEA_DEVICE_ID || !site) return [];
  return [
    {
      id: 'boiler',
      type: 'midea_boiler',
      name: DEVICE_TYPES.midea_boiler.name,
      icon: DEVICE_TYPES.midea_boiler.icon,
      site: site.id,
      params: { device_id: String(env.MIDEA_DEVICE_ID) },
      auto: true,
    },
  ];
}

/**
 * Sites, in display order. Loaded from the database for every request (see store.js).
 * @param {Env} env
 * @returns {Site[]}
 */
export const sitesOf = (env) => env.CFG?.sites ?? legacySites(env);

/** @param {Env} env @returns {Device[]} */
export const devicesOf = (env) => env.CFG?.devices ?? legacyDevices(env);

/** @param {Env} env @param {string} id */
export const deviceById = (env, id) => devicesOf(env).find((d) => d.id === id) || null;

/** Permission key of a site. */
export const siteKey = (site) => `site.${site.id}`;

/**
 * Sites with the controllable devices that belong to them: the structure of the access screen.
 * (An inverter needs no permission of its own: whoever sees the site sees its data.)
 * @param {Env} env
 * @returns {Array<{site: Site, key: string, devices: string[]}>}
 */
export function siteTree(env) {
  const devices = devicesOf(env).filter(controllable);
  return sitesOf(env).map((site) => ({
    site,
    key: siteKey(site),
    devices: devices.filter((d) => d.site === site.id).map((d) => d.id),
  }));
}

/** The site a device belongs to. @returns {Site | undefined} */
export const deviceSite = (env, id) => sitesOf(env).find((s) => s.id === deviceById(env, id)?.site) || sitesOf(env)[0];

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
 * @property {{sites: Site[], devices: Device[], settings: Record<string, string>, templates: Record<string, string>}} [CFG]
 *   configuration loaded from the database for this request
 * @property {string} [GH_TOKEN] optional: lets the "Оновити" button start the update in GitHub directly
 * @property {string} [COLO] Cloudflare data centre of the current request (diagnostics only)
 */
