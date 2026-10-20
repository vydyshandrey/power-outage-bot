/** Read-only views shown in the bot: status, device card, history, outage report, device menu. */

import { controllable, deviceById, devicesOf, sitesOf } from './config.js';
import { db, getPerm, kvGet, viewableDevices, viewableSites } from './db.js';
import { K, gridDevice } from './automation.js';
import { DK, deviceState } from './devices.js';
import { inverterConfigured, inverterLatest, inverterName } from './inverter.js';
import { NL, esc, fmtDur, fmtHM, fmtTime, now } from './util.js';

/** "📊 Статус": per visible site grid, consumption and battery, then one line per visible device. */
export async function statusText(env, user) {
  const sites = await viewableSites(env, user);
  const titled = sitesOf(env).length > 1;
  const devices = (await viewableDevices(env, user)).map((id) => deviceById(env, id));
  const lines = [];
  for (const site of sites) {
    if (titled) lines.push(`${lines.length ? NL : ''}<b>⚡ ${esc(site.name)}</b>`);
    lines.push(...(await siteLines(env, site)));
    for (const dev of devices.filter((d) => d.site === site.id)) lines.push(await deviceLine(env, dev));
  }
  // Devices of sites the user does not see (rare: access given to a single device).
  const rest = devices.filter((d) => !sites.some((s) => s.id === d.site));
  if (rest.length && titled) lines.push(`${lines.length ? NL : ''}<b>🏠 Пристрої</b>`);
  for (const dev of rest) lines.push(await deviceLine(env, dev));
  return lines.join(NL) || "Доступних об'єктів і пристроїв немає. Попроси адміністратора надати доступ.";
}

async function siteLines(env, site) {
  if (!inverterConfigured(env, site)) return ["Інвертор ще не обрано: ⚙️ Налаштування → 🏠 Об'єкти."];
  const lines = [];
  try {
    const d = await inverterLatest(env, site);
    // If the tick has not recorded a fresh transition yet, count from the reading itself.
    const stored = await kvGet(env, K(site, 'grid'));
    const since = stored === (d.grid ? 'on' : 'off') ? Number(await kvGet(env, K(site, 'grid_since'))) || null : d.ts;
    const dur = since ? ` ${fmtDur(now() - since)} (з ${fmtTime(since)})` : '';
    if (d.grid) {
      lines.push(`💡 Світло є${dur}, ${d.volt} В`);
      lines.push(`🏠 Споживання: ${d.load} Вт`);
      lines.push(`🔋 Батарея: ${d.soc}% (${d.batt} Вт)`);
    } else {
      lines.push(`🔌 Світла немає${dur}`);
      lines.push(`🔋 Від інвертора: споживання ${d.load} Вт, батарея ${d.soc}% (${Math.abs(d.batt)} Вт)`);
    }
    lines.push(`🕒 Дані ${inverterName(site)}: ${fmtDur(now() - d.ts)} тому`);
  } catch (e) {
    lines.push(`Інвертор: помилка (${esc(e.message)})`);
  }
  return lines;
}

async function deviceLine(env, dev) {
  try {
    return `${dev.icon} ${esc(dev.name)}: ${(await deviceState(env, dev)).short}`;
  } catch (e) {
    return `${dev.icon} ${esc(dev.name)}: помилка (${esc(e.message)})`;
  }
}

/** Device card with controls (for users who may control it) and navigation. */
export async function deviceCard(env, user, id) {
  const dev = deviceById(env, id);
  const perm = await getPerm(env, user, id);
  const lines = [`<b>${dev.icon} ${esc(dev.name)}</b>`];
  try {
    lines.push(...(await deviceState(env, dev)).details);
    if ((await kvGet(env, DK(dev, 'boiler_auto_off'))) === '1') {
      lines.push('Вимкнений автоматикою, увімкнеться після повернення світла.');
    }
  } catch (e) {
    lines.push(`Помилка: ${esc(e.message)}`);
  }

  const last = await (
    await db(env)
  )
    .prepare("SELECT * FROM events WHERE device=? AND type IN ('power_on','power_off') ORDER BY ts DESC LIMIT 1")
    .bind(id)
    .first();
  if (last) {
    const verb = last.type === 'power_on' ? 'увімкнув' : 'вимкнув';
    lines.push(`Остання зміна: ${verb} ${esc(last.actor)}, ${fmtTime(last.ts)}`);
  }

  const kb = [];
  if (perm === 'control' && controllable(dev)) {
    kb.push([
      { text: '🔥 Увімкнути', callback_data: `dc:${id}:on` },
      { text: '⛔ Вимкнути', callback_data: `dc:${id}:off` },
    ]);
  }
  kb.push(
    controllable(dev)
      ? [
          { text: '📜 Історія', callback_data: `h:${id}` },
          { text: '🔄 Оновити', callback_data: `d:${id}` },
        ]
      : [{ text: '🔄 Оновити', callback_data: `d:${id}` }]
  );
  kb.push([{ text: '⬅️ Пристрої', callback_data: 'dl' }]);
  return { text: lines.join(NL), kb };
}

/** Last 15 events of a device. */
export async function deviceHistory(env, id) {
  const { icon, name } = deviceById(env, id);
  const dev = id;
  const { results } = await (
    await db(env)
  )
    .prepare('SELECT * FROM events WHERE device=? ORDER BY ts DESC LIMIT 15')
    .bind(dev)
    .all();
  const lines = [`<b>📜 ${icon} ${esc(name)}: останні події</b>`];
  if (!results.length) lines.push('Подій ще немає.');
  for (const e of results) {
    const data = e.data ? JSON.parse(e.data) : {};
    const what = { power_on: '🔥 увімкнено', power_off: '⛔ вимкнено' }[e.type] || e.type;
    lines.push(`${fmtTime(e.ts)} ${what}, ${esc(e.actor)}${data.temp ? `, ${data.temp}°` : ''}`);
  }
  return { text: lines.join(NL), kb: [[{ text: '⬅️ Назад', callback_data: `d:${dev}` }]] };
}

/** Outages over the last `days` at every site the user sees. */
export async function outagesReport(env, user, days = 7) {
  const titled = sitesOf(env).length > 1;
  const parts = [];
  for (const site of await viewableSites(env, user)) parts.push(await siteOutages(env, site, days, titled));
  return parts.join(NL + NL) || "Немає доступних об'єктів.";
}

/** Outages of one site, paired from grid_off/grid_on events, with the total. */
async function siteOutages(env, site, days, titled) {
  const from = now() - days * 86400;
  const { results } = await (
    await db(env)
  )
    .prepare('SELECT ts,type,data FROM events WHERE device=? AND ts>=? ORDER BY ts')
    .bind(gridDevice(site), from)
    .all();

  const rows = [];
  let start = null;
  for (const e of results) {
    const at = JSON.parse(e.data || '{}').at || e.ts;
    if (e.type === 'grid_off') start = at;
    else if (e.type === 'grid_on' && start) {
      rows.push([start, at]);
      start = null;
    }
  }
  if (start) rows.push([start, null]);

  const lines = [`<b>🔌 ${titled ? `${esc(site.name)}: в` : 'В'}ідключення за ${days} днів</b>`];
  if (!rows.length) lines.push('Відключень не було (або історія ще порожня).');
  let total = 0;
  for (const [a, b] of rows) {
    const dur = (b || now()) - a;
    total += dur;
    lines.push(`${fmtTime(a)} – ${b ? fmtHM(b) : 'триває'} · ${fmtDur(dur)}`);
  }
  if (rows.length) lines.push(`Разом без світла: ${fmtDur(total)}`);
  return lines.join(NL);
}

/** "🏠 Пристрої": devices the user may see. */
export async function devicesMenu(env, user) {
  // Inverters are shown read-only to whoever sees their site; switchable devices by their own access.
  const sites = new Set((await viewableSites(env, user)).map((s) => s.id));
  const inverters = devicesOf(env).filter((d) => d.type === 'inverter' && sites.has(d.site));
  const switchable = (await viewableDevices(env, user)).map((id) => deviceById(env, id));
  const devs = sitesOf(env).flatMap((s) => [...inverters, ...switchable].filter((d) => d.site === s.id));
  if (!devs.length) return { text: 'Доступних пристроїв немає. Попроси адміністратора надати доступ.', kb: [] };
  const titled = sitesOf(env).length > 1;
  const kb = devs.map((d) => [
    {
      text: `${d.icon} ${d.name}${titled ? ` · ${sitesOf(env).find((s) => s.id === d.site)?.name}` : ''}`,
      callback_data: `d:${d.id}`,
    },
  ]);
  return { text: '<b>🏠 Пристрої</b>', kb };
}
