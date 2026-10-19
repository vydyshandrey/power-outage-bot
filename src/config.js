/**
 * Static configuration and tunables.
 *
 * Everything specific to a particular home (device IDs, time zone, Deye region)
 * comes from Worker variables, see wrangler.toml → [vars]. Credentials come from
 * Worker secrets and never appear in the code.
 */

export const VERSION = '1.1.5';

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

/** Device registry. New device types (sockets, ATS, TV) are added here. */
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
 * @typedef {object} Env
 * @property {D1Database} DB
 * @property {string} TG_BOT_TOKEN
 * @property {string} ACCESS_KEY
 * @property {string} [NOTIFY_KEY]
 * @property {string} [NOTIFY_NAME]
 * @property {string} [TICK_KEY]
 * @property {string} DEYE_APP_ID
 * @property {string} DEYE_APP_SECRET
 * @property {string} DEYE_EMAIL
 * @property {string} DEYE_PASSWORD
 * @property {string} [DEYE_SN]
 * @property {string} [DEYE_API]
 * @property {string} MIDEA_EMAIL
 * @property {string} MIDEA_PASSWORD
 * @property {string} [MIDEA_DEVICE_ID]
 * @property {string} [TZ]
 * @property {string} [COLO] Cloudflare data centre of the current request (diagnostics only)
 */
