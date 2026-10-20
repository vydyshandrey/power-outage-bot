/**
 * Inverter facade: the rest of the bot reads the grid through here and does not
 * care which cloud the inverter reports to. Chosen by the INVERTER variable.
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

/** @param {import('./config.js').Env} env */
function provider(env) {
  const key = env.INVERTER || 'deye';
  const p = PROVIDERS[key];
  if (!p) throw new Error(`INVERTER має бути ${Object.keys(PROVIDERS).join(' або ')}, а не «${key}»`);
  return p;
}

/** Name used in messages, e.g. "Deye не відповідає". */
export const inverterName = (env) => provider(env).name;

/** True once the device IDs from /discover are in wrangler.toml. */
export const inverterConfigured = (env) => provider(env).configured(env);

/** @returns {Promise<import('./deye.js').Reading>} */
export const inverterLatest = (env) => provider(env).latest(env);

/** Devices visible to the configured account, for /discover. */
export const inverterDiscover = (env) => provider(env).discover(env);
