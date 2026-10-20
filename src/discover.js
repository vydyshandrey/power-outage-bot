/** Setup helper behind /discover: which inverters and boilers the configured accounts can see. */

import { sitesOf } from './config.js';
import { inverterDiscover } from './inverter.js';
import { Midea } from './midea.js';

/** @param {import('./config.js').Env} env */
export async function discover(env) {
  /** @type {Record<string, any>} */
  const out = { midea: null, sites: {} };

  try {
    const r = await new Midea(env).listAppliances();
    out.midea = (r?.list || []).map((a) => ({
      MIDEA_DEVICE_ID: String(a.id),
      name: a.name,
      type: a.type, // 0xE2 is an electric water heater
      model: a.productModel || a.modelNumber || '',
      online: a.onlineStatus === '1',
    }));
  } catch (e) {
    out.midea = { error: e.message };
  }

  for (const site of sitesOf(env)) {
    const entry = { name: site.name, inverter: site.inverter };
    try {
      entry.found = await inverterDiscover(env, site);
    } catch (e) {
      entry.error = e.message;
    }
    out.sites[site.id] = entry;
  }

  return out;
}
