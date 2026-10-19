/** Setup helper behind /discover: which inverters and boilers the configured accounts can see. */

import { deyeStations } from './deye.js';
import { Midea } from './midea.js';

/** @param {import('./config.js').Env} env */
export async function discover(env) {
  const out = { midea: null, deye: null };

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
    const { stations, code, msg } = await deyeStations(env);
    out.deye = stations.length
      ? stations.map((s) => ({
          station: s.name,
          devices: (s.deviceListItems || s.deviceList || []).map((d) => ({ DEYE_SN: d.deviceSn, type: d.deviceType })),
        }))
      : { error: `${code || ''} ${msg || 'станцій не знайдено'}`.trim() };
  } catch (e) {
    out.deye = { error: e.message };
  }

  return out;
}
