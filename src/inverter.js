/**
 * Inverter facade: the rest of the bot reads the grid through here and does not
 * care which cloud an inverter reports to. Each site names its cloud (see sitesOf).
 *
 *   deye — Deye Cloud OpenAPI (default)
 *   dess — DESS Monitor / ShineMonitor (SmartESS, WatchPower and rebranded apps)
 *   valueclouds — ValueClouds (SmartValue app)
 */

import { dessDevices, dessLatest } from './dess.js';
import { deyeLatest, deyeStations } from './deye.js';
import { valueCloudsDiscover, valueCloudsLatest } from './valueclouds.js';

const PROVIDERS = {
  deye: {
    name: 'Deye',
    configured: (env) => Boolean(env.DEYE_SN),
    latest: deyeLatest,
    async discover(env) {
      const { stations, code, msg } = await deyeStations(env);
      if (!stations.length) return { error: `${code || ''} ${msg || 'станцій не знайдено'}`.trim() };
      return stations.map((s) => ({
        station: s.name,
        devices: (s.deviceListItems || s.deviceList || []).map((d) => ({ DEYE_SN: d.deviceSn, type: d.deviceType })),
      }));
    },
  },
  dess: {
    name: 'DESS Monitor',
    configured: (env) => Boolean(env.DESS_SN),
    latest: dessLatest,
    discover: dessDevices,
  },
  valueclouds: {
    name: 'SmartValue',
    configured: (env) => Boolean(env.VC_SN),
    latest: valueCloudsLatest,
    discover: valueCloudsDiscover,
  },
};

/** @param {import('./config.js').Site} site */
function provider(site) {
  const p = PROVIDERS[site.inverter];
  if (!p) throw new Error(`Інвертор «${site.inverter}»: має бути ${Object.keys(PROVIDERS).join(', ')}`);
  return p;
}

/** Name used in messages, e.g. "Deye не відповідає". */
export const inverterName = (site) => provider(site).name;

/** True once the device IDs for this site's cloud are in wrangler.toml. */
export const inverterConfigured = (env, site) => provider(site).configured(env);

/** @returns {Promise<import('./deye.js').Reading>} */
export const inverterLatest = (env, site) => provider(site).latest(env);

/** Devices visible to the site's account, for /discover. */
export const inverterDiscover = (env, site) => provider(site).discover(env);
