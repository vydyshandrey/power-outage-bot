/**
 * Diagnostics behind /discover: what the configured accounts can see. Setting things up is
 * done in the bot (⚙️ Налаштування); this page helps when something does not work.
 */

import { HOME, siteCabinet, sitesOf } from './config.js';
import { listDevices } from './devices.js';
import { inverterLatest, listInverters, missingSecrets } from './inverter.js';
import { credEnv } from './secrets.js';

/** Only the first cabinet: other cabinets' accounts are not the operator's to inspect. @param {import('./config.js').Env} env */
export async function discover(env) {
  const cenv = await credEnv(env, HOME);
  /** @type {Record<string, any>} */
  const out = { midea: null, sites: {} };

  try {
    out.midea = await listDevices(cenv, 'midea_boiler');
  } catch (e) {
    out.midea = { error: e.message };
  }

  for (const site of sitesOf(env).filter((s) => siteCabinet(s) === HOME && s.inverter)) {
    const entry = { name: site.name, inverter: site.inverter, params: site.params };
    const missing = missingSecrets(cenv, site.inverter, site.account);
    if (missing.length) entry.missing_secrets = missing;
    else {
      try {
        entry.found = await listInverters(
          cenv,
          site.inverter,
          site.account,
          site.params.platform ? { platform: site.params.platform } : {}
        );
      } catch (e) {
        entry.error = e.message;
      }
      try {
        entry.reading = await inverterLatest(env, site);
      } catch (e) {
        entry.reading_error = e.message;
      }
    }
    out.sites[site.id] = entry;
  }
  return out;
}
