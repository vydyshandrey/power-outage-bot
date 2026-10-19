/** Read-only views shown in the bot: status, device card, history, outage report, device menu. */

import { DEVICES } from './config.js';
import { db, getPerm, kvGet, viewableDevices } from './db.js';
import { deyeLatest } from './deye.js';
import { Midea } from './midea.js';
import { NL, esc, fmtDur, fmtHM, fmtTime, now } from './util.js';

/** "📊 Статус": grid, consumption, battery and one line per visible device. */
export async function statusText(env, user) {
  const lines = [];
  try {
    const d = await deyeLatest(env);
    // If the tick has not recorded a fresh transition yet, count from the reading itself.
    const stored = await kvGet(env, 'grid');
    const since = stored === (d.grid ? 'on' : 'off') ? Number(await kvGet(env, 'grid_since')) || null : d.ts;
    const dur = since ? ` ${fmtDur(now() - since)} (з ${fmtTime(since)})` : '';
    if (d.grid) {
      lines.push(`💡 Світло є${dur}, ${d.volt} В`);
      lines.push(`🏠 Споживання: ${d.load} Вт`);
      lines.push(`🔋 Батарея: ${d.soc}% (${d.batt} Вт)`);
    } else {
      lines.push(`🔌 Світла немає${dur}`);
      lines.push(`🔋 Від інвертора: споживання ${d.load} Вт, батарея ${d.soc}% (${Math.abs(d.batt)} Вт)`);
    }
    lines.push(`🕒 Дані Deye: ${fmtDur(now() - d.ts)} тому`);
  } catch (e) {
    lines.push(`Deye: помилка (${esc(e.message)})`);
  }
  for (const dev of await viewableDevices(env, user)) lines.push(await deviceLine(env, dev));
  return lines.join(NL);
}

async function deviceLine(env, dev) {
  const { icon, name } = DEVICES[dev];
  if (dev !== 'boiler') return `${icon} ${name}`;
  try {
    const st = await new Midea(env).status();
    return `${icon} ${name}: ${st.power === 'on' ? 'увімкнений' : 'вимкнений'}, ${st.cur_temperature}° / ${st.temperature}°`;
  } catch (e) {
    return `${icon} ${name}: помилка (${esc(e.message)})`;
  }
}

/** Device card with controls (for users with "control") and navigation. */
export async function deviceCard(env, user, dev) {
  const { icon, name } = DEVICES[dev];
  const perm = await getPerm(env, user, dev);
  const lines = [`<b>${icon} ${name}</b>`];
  try {
    const st = await new Midea(env).status();
    lines.push(`Стан: ${st.power === 'on' ? '🔥 увімкнений' : '⛔ вимкнений'}`);
    lines.push(`Температура: ${st.cur_temperature}° (уставка ${st.temperature}°)`);
    if ((await kvGet(env, 'boiler_auto_off')) === '1') {
      lines.push('Вимкнений автоматикою, увімкнеться після повернення світла.');
    }
  } catch (e) {
    lines.push(`Помилка: ${esc(e.message)}`);
  }

  const last = await (
    await db(env)
  )
    .prepare("SELECT * FROM events WHERE device=? AND type IN ('power_on','power_off') ORDER BY ts DESC LIMIT 1")
    .bind(dev)
    .first();
  if (last) {
    const verb = last.type === 'power_on' ? 'увімкнув' : 'вимкнув';
    lines.push(`Остання зміна: ${verb} ${esc(last.actor)}, ${fmtTime(last.ts)}`);
  }

  const kb = [];
  if (perm === 'control') {
    kb.push([
      { text: '🔥 Увімкнути', callback_data: `dc:${dev}:on` },
      { text: '⛔ Вимкнути', callback_data: `dc:${dev}:off` },
    ]);
  }
  kb.push([
    { text: '📜 Історія', callback_data: `h:${dev}` },
    { text: '🔄 Оновити', callback_data: `d:${dev}` },
  ]);
  kb.push([{ text: '⬅️ Пристрої', callback_data: 'dl' }]);
  return { text: lines.join(NL), kb };
}

/** Last 15 events of a device. */
export async function deviceHistory(env, dev) {
  const { icon, name } = DEVICES[dev];
  const { results } = await (
    await db(env)
  )
    .prepare('SELECT * FROM events WHERE device=? ORDER BY ts DESC LIMIT 15')
    .bind(dev)
    .all();
  const lines = [`<b>📜 ${icon} ${name}: останні події</b>`];
  if (!results.length) lines.push('Подій ще немає.');
  for (const e of results) {
    const data = e.data ? JSON.parse(e.data) : {};
    const what = { power_on: '🔥 увімкнено', power_off: '⛔ вимкнено' }[e.type] || e.type;
    lines.push(`${fmtTime(e.ts)} ${what}, ${esc(e.actor)}${data.temp ? `, ${data.temp}°` : ''}`);
  }
  return { text: lines.join(NL), kb: [[{ text: '⬅️ Назад', callback_data: `d:${dev}` }]] };
}

/** Outages over the last `days`, paired from grid_off/grid_on events, with the total. */
export async function outagesReport(env, days = 7) {
  const from = now() - days * 86400;
  const { results } = await (
    await db(env)
  )
    .prepare("SELECT ts,type,data FROM events WHERE device='grid' AND ts>=? ORDER BY ts")
    .bind(from)
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

  const lines = [`<b>🔌 Відключення за ${days} днів</b>`];
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
  const devs = await viewableDevices(env, user);
  if (!devs.length) return { text: 'Доступних пристроїв немає. Попроси адміністратора надати доступ.', kb: [] };
  const kb = devs.map((dev) => [{ text: `${DEVICES[dev].icon} ${DEVICES[dev].name}`, callback_data: `d:${dev}` }]);
  return { text: '<b>🏠 Пристрої</b>', kb };
}
