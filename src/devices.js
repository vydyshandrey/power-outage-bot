/**
 * Device drivers. Every controllable device goes through here, whatever its vendor.
 * A new device type (a smart socket, an ATS) adds a driver to DRIVERS and a type to
 * DEVICE_TYPES in config.js.
 */

import { kvSet, logEvent } from './db.js';
import { inverterLatest } from './inverter.js';
import { Midea } from './midea.js';

/**
 * Storage key of a device's state. The device with the historical id "boiler" keeps the
 * plain names, so a deployment that predates several devices carries its state over.
 */
export const DK = (dev, k) => (dev.id === 'boiler' ? k : `${k}@${dev.id}`);

/**
 * @typedef {object} DeviceState
 * @property {boolean} on
 * @property {string} short one-line state for the status, e.g. "увімкнений, 57° / 60°"
 * @property {string[]} details lines for the device card
 * @property {number | null} [temp] for the history
 */

const DRIVERS = {
  inverter: {
    /** An inverter is read, not switched: its state is the reading of its cloud. */
    async state(env, dev) {
      const d = await inverterLatest(env, {
        inverter: dev.params.cloud,
        account: dev.params.account || 1,
        params: dev.params,
      });
      return {
        on: d.grid,
        short: `${d.grid ? 'мережа є' : 'мережі немає'}, батарея ${d.soc}%, споживання ${d.load} Вт`,
        details: [
          d.grid ? `💡 Мережа є, ${d.volt} В` : '🔌 Мережі немає',
          `🔋 Батарея: ${d.soc}% (${d.batt} Вт)`,
          `🏠 Споживання: ${d.load} Вт`,
        ],
        temp: null,
      };
    },
    secrets: [],
  },

  midea_boiler: {
    /** @returns {Promise<DeviceState>} */
    async state(env, dev) {
      const st = await new Midea(env).status(dev.params.device_id);
      const on = st?.power === 'on';
      return {
        on,
        short: `${on ? 'увімкнений' : 'вимкнений'}, ${st.cur_temperature}° / ${st.temperature}°`,
        details: [
          `Стан: ${on ? '🔥 увімкнений' : '⛔ вимкнений'}`,
          `Температура: ${st.cur_temperature}° (уставка ${st.temperature}°)`,
        ],
        temp: Number(st.cur_temperature) || null,
      };
    },
    /** @returns {Promise<number | null>} temperature before the change, for the history */
    async setPower(env, dev, on) {
      const before = await new Midea(env).setPower(dev.params.device_id, on);
      return Number(before.cur_temperature) || null;
    },
    /** Devices of this type the account can see, for adding one in the bot. */
    async list(env) {
      const r = await new Midea(env).listAppliances();
      return (r?.list || []).map((a) => ({
        label: `${a.name || 'Midea'}${a.onlineStatus === '1' ? '' : ' (не в мережі)'}`,
        params: { device_id: String(a.id) },
      }));
    },
    secrets: ['MIDEA_EMAIL', 'MIDEA_PASSWORD'],
  },
};

const driver = (dev) => {
  const d = DRIVERS[dev.type];
  if (!d) throw new Error(`Невідомий тип пристрою «${dev.type}»`);
  return d;
};

/** @returns {Promise<DeviceState>} */
export const deviceState = (env, dev) => driver(dev).state(env, dev);

/** Devices of a type visible to the vendor account. */
export const listDevices = (env, type) => DRIVERS[type].list(env);

/** Secrets the vendor account needs that are not set yet. */
export const missingDeviceSecrets = (env, type) => DRIVERS[type].secrets.filter((n) => !env[n]);

/**
 * The only place that switches a device: does it, remembers the state and logs who did it.
 * @param {string} actor user name or "автоматика"
 */
export async function setDevicePower(env, dev, on, actor) {
  const temp = await driver(dev).setPower(env, dev, on);
  await kvSet(env, DK(dev, 'boiler_power'), on ? 'on' : 'off');
  await logEvent(env, on ? 'power_on' : 'power_off', dev.id, actor, { temp, colo: env.COLO || '' });
}
