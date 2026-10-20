/** Setup helper behind /discover: which inverters and boilers the configured accounts can see. */

import { inverterDiscover } from './inverter.js';
import { Midea } from './midea.js';

/** @param {import('./config.js').Env} env */
export async function discover(env) {
  const out = { midea: null, inverter: null };

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

  try {
    out.inverter = await inverterDiscover(env);
  } catch (e) {
    out.inverter = { error: e.message };
  }

  return out;
}
