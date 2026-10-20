/**
 * Readings history per site, daily summaries with a chart, and charts on demand.
 *
 * Every fresh inverter reading is stored (table `readings`, kept READINGS_DAYS days).
 * Charts are drawn by QuickChart (quickchart.io, an open-source Chart.js renderer): the
 * Worker sends it the numbers, gets a PNG back and sends that to Telegram. Only the
 * numbers leave the Worker, nothing that identifies the home. If the renderer does not
 * answer, the summary goes out as text.
 *
 * Callback data: cg chart menu · ch:<site>:<d|w> chart of today or 7 days · ns toggle summaries.
 */

import { READINGS_DAYS, SUMMARY_HOUR, sitesOf, siteKey } from './config.js';
import { db, getPerm, kvGet, kvSet, usersBy, viewableSites } from './db.js';
import { gridDevice } from './automation.js';
import { tg } from './telegram.js';
import { NL, esc, fmtDur, getTimeZone, now } from './util.js';

const QUICKCHART = 'https://quickchart.io/chart';

/* ---------- local calendar ---------- */

/** Hour, minute, second and the date key of a moment in the bot's time zone. */
export function localParts(ts) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: getTimeZone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(ts * 1000))
      .map((p) => [p.type, p.value])
  );
  return {
    key: `${parts.year}-${parts.month}-${parts.day}`,
    day: `${parts.day}.${parts.month}`,
    h: Number(parts.hour),
    m: Number(parts.minute),
    s: Number(parts.second),
  };
}

/** Start of the local day that contains ts. */
export function dayStart(ts) {
  const p = localParts(ts);
  return ts - (p.h * 3600 + p.m * 60 + p.s);
}

/* ---------- storage ---------- */

/** Stores a reading of a site once (the same inverter timestamp is ignored). */
export async function logReading(env, site, d) {
  await (
    await db(env)
  )
    .prepare('INSERT OR IGNORE INTO readings (site,ts,grid,volt,load,batt,soc) VALUES (?,?,?,?,?,?,?)')
    .bind(site.id, d.ts, d.grid ? 1 : 0, d.volt, d.load, d.batt, d.soc)
    .run();
}

/** Drops readings older than READINGS_DAYS. */
export async function pruneReadings(env) {
  await (
    await db(env)
  )
    .prepare('DELETE FROM readings WHERE ts < ?')
    .bind(now() - READINGS_DAYS * 86400)
    .run();
}

const readings = async (env, site, from, to) =>
  (
    await (
      await db(env)
    )
      .prepare('SELECT ts,grid,load,soc FROM readings WHERE site=? AND ts>=? AND ts<? ORDER BY ts')
      .bind(site.id, from, to)
      .all()
  ).results;

/** Outages of a site that overlap [from, to): pairs of grid_off/grid_on events. */
async function outages(env, site, from, to) {
  const { results } = await (
    await db(env)
  )
    .prepare("SELECT ts,type,data FROM events WHERE device=? AND ts<? AND type IN ('grid_off','grid_on') ORDER BY ts")
    .bind(gridDevice(site), to)
    .all();
  const out = [];
  let start = null;
  for (const e of results) {
    const at = JSON.parse(e.data || '{}').at || e.ts;
    if (e.type === 'grid_off') start = at;
    else if (start !== null) {
      if (at > from) out.push([Math.max(start, from), Math.min(at, to)]);
      start = null;
    }
  }
  if (start !== null) out.push([Math.max(start, from), to]);
  return out;
}

/* ---------- numbers ---------- */

/** Summary numbers of a site over [from, to). */
export async function siteStats(env, site, from, to) {
  const rows = await readings(env, site, from, to);
  let wh = 0;
  for (let i = 1; i < rows.length; i++) {
    const dt = Math.min(rows[i].ts - rows[i - 1].ts, 900); // a gap counts at most 15 min
    if (Number.isFinite(rows[i - 1].load)) wh += (rows[i - 1].load * dt) / 3600;
  }
  const socs = rows.map((r) => r.soc).filter(Number.isFinite);
  const off = await outages(env, site, from, to);
  return {
    rows,
    kwh: wh / 1000,
    socMin: socs.length ? Math.min(...socs) : null,
    socMax: socs.length ? Math.max(...socs) : null,
    outages: off.length,
    offSec: off.reduce((s, [a, b]) => s + (b - a), 0),
  };
}

/** Buckets of `step` seconds: average load, last battery level, whether the grid was off. */
function buckets(rows, from, to, step) {
  const out = [];
  for (let t = from; t < to; t += step) {
    const inB = rows.filter((r) => r.ts >= t && r.ts < t + step);
    const loads = inB.map((r) => r.load).filter(Number.isFinite);
    out.push({
      t,
      load: loads.length ? Math.round(loads.reduce((a, b) => a + b, 0) / loads.length) : null,
      soc: inB.length ? inB[inB.length - 1].soc : null,
      off: inB.some((r) => !r.grid),
    });
  }
  return out;
}

/* ---------- chart ---------- */

const hm = (ts) => {
  const p = localParts(ts);
  return `${String(p.h).padStart(2, '0')}:${String(p.m).padStart(2, '0')}`;
};

/** Chart.js configuration: consumption, battery, and the hours without grid shaded. */
export function chartConfig(title, bs, week) {
  const label = (b) => (week ? `${localParts(b.t).day} ${hm(b.t)}` : hm(b.t));
  return {
    type: 'line',
    data: {
      labels: bs.map(label),
      datasets: [
        {
          label: 'Без світла',
          data: bs.map((b) => (b.off ? 100 : null)),
          yAxisID: 'soc',
          stepped: true,
          fill: 'origin',
          borderWidth: 0,
          pointRadius: 0,
          backgroundColor: 'rgba(239,83,80,0.18)',
          spanGaps: false,
        },
        {
          label: 'Споживання, Вт',
          data: bs.map((b) => b.load),
          yAxisID: 'w',
          borderColor: '#1e88e5',
          backgroundColor: '#1e88e5',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.25,
          spanGaps: true,
        },
        {
          label: 'Батарея, %',
          data: bs.map((b) => b.soc),
          yAxisID: 'soc',
          borderColor: '#43a047',
          backgroundColor: '#43a047',
          borderWidth: 2,
          pointRadius: 0,
          spanGaps: true,
        },
      ],
    },
    options: {
      plugins: { title: { display: true, text: title }, legend: { position: 'bottom' } },
      scales: {
        x: { ticks: { maxTicksLimit: week ? 8 : 9, maxRotation: 0 } },
        w: { position: 'left', beginAtZero: true, title: { display: true, text: 'Вт' } },
        soc: {
          position: 'right',
          min: 0,
          max: 100,
          grid: { drawOnChartArea: false },
          title: { display: true, text: '%' },
        },
      },
    },
  };
}

/** PNG of a chart, or null when the renderer does not answer. */
async function renderPng(config) {
  try {
    const r = await fetch(QUICKCHART, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: '4',
        width: 900,
        height: 450,
        backgroundColor: 'white',
        format: 'png',
        chart: config,
      }),
    });
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch {
    return null;
  }
}

/** Sends a photo with a caption; without a picture, the caption alone. */
async function sendPicture(env, chatId, png, caption, kb) {
  const markup = kb?.length ? { inline_keyboard: kb } : undefined;
  if (png) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    if (markup) form.append('reply_markup', JSON.stringify(markup));
    form.append('photo', new Blob([png], { type: 'image/png' }), 'chart.png');
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendPhoto`, { method: 'POST', body: form });
    const j = await r.json().catch(() => ({}));
    if (j.ok) return j;
  }
  return tg(env, 'sendMessage', { chat_id: chatId, text: caption, parse_mode: 'HTML', reply_markup: markup });
}

/* ---------- texts ---------- */

const titled = (env) => sitesOf(env).length > 1;

function statsLines(st) {
  const lines = [];
  lines.push(
    st.outages
      ? `🔌 Без світла: ${fmtDur(st.offSec)} (${st.outages} раз${st.outages > 1 && st.outages < 5 ? 'и' : st.outages >= 5 ? 'ів' : ''})`
      : '💡 Світло було весь час'
  );
  if (st.rows.length > 1) lines.push(`🏠 Спожито: ${st.kwh.toFixed(1)} кВт·год`);
  if (st.socMin !== null) lines.push(`🔋 Батарея: від ${st.socMin}% до ${st.socMax}%`);
  return lines;
}

const SUMMARY_OFF = [{ text: '🔕 Не надсилати підсумки', callback_data: 'ns' }];

/** One site's summary of yesterday to one person. */
async function sendSummary(env, chatId, site, from, to) {
  const st = await siteStats(env, site, from, to);
  if (!st.rows.length && !st.outages) return; // nothing to tell
  const day = localParts(from).day;
  const head = `📊 <b>Підсумки дня · ${day}</b>${titled(env) ? `${NL}🏠 ${esc(site.name)}` : ''}`;
  const caption = [head, '', ...statsLines(st)].join(NL);
  const png =
    st.rows.length > 1
      ? await renderPng(chartConfig(`${site.name} · ${day}`, buckets(st.rows, from, to, 900), false))
      : null;
  await sendPicture(env, chatId, png, caption, [SUMMARY_OFF]);
}

/** Once a day after SUMMARY_HOUR: yesterday's summary to everyone who sees a site, unless they opted out. */
export async function dailySummaries(env) {
  const t = now();
  const today = localParts(t);
  if (today.h < SUMMARY_HOUR || (await kvGet(env, 'summary_day')) === today.key) return;
  await kvSet(env, 'summary_day', today.key);
  await pruneReadings(env);
  const to = dayStart(t);
  const from = dayStart(to - 3600);
  for (const u of await usersBy(env, 'user')) {
    if ((await kvGet(env, `nosum:${u.chat_id}`)) === '1') continue;
    for (const site of sitesOf(env)) {
      if ((await getPerm(env, u, siteKey(site))) === 'none') continue;
      try {
        await sendSummary(env, u.chat_id, site, from, to);
      } catch {
        /* one failure must not stop the rest */
      }
    }
  }
}

/* ---------- on demand ---------- */

/** "📈 Графік": which site and period. */
export async function chartMenu(env, user) {
  const sites = await viewableSites(env, user);
  const kb = sites.map((s) => [
    { text: `${titled(env) ? `${s.name}: ` : ''}сьогодні`, callback_data: `ch:${s.id}:d` },
    { text: `${titled(env) ? `${s.name}: ` : ''}7 днів`, callback_data: `ch:${s.id}:w` },
  ]);
  const off = (await kvGet(env, `nosum:${user.chat_id}`)) === '1';
  kb.push([{ text: off ? '🔔 Надсилати підсумки дня' : '🔕 Не надсилати підсумки дня', callback_data: 'ns' }]);
  return {
    text: `<b>📈 Графік</b>${NL}Споживання, батарея і час без світла.${NL}Підсумки дня приходять щоранку о ${SUMMARY_HOUR}:00${off ? ' (у тебе вимкнено)' : ''}.`,
    kb,
  };
}

/** Sends the chart of today or the last 7 days for a site the user sees. */
export async function sendChart(env, user, siteId, range) {
  const site = sitesOf(env).find((s) => s.id === siteId);
  if (!site || (await getPerm(env, user, siteKey(site))) === 'none') return false;
  const t = now();
  const week = range === 'w';
  const from = week ? dayStart(t) - 6 * 86400 : dayStart(t);
  const st = await siteStats(env, site, from, t);
  const period = week ? '7 днів' : 'сьогодні';
  const caption = [`📈 <b>${titled(env) ? `${esc(site.name)}, ` : ''}${period}</b>`, '', ...statsLines(st)].join(NL);
  const png =
    st.rows.length > 1
      ? await renderPng(chartConfig(`${site.name} · ${period}`, buckets(st.rows, from, t, week ? 7200 : 900), week))
      : null;
  await sendPicture(
    env,
    user.chat_id,
    png,
    st.rows.length ? caption : `${caption}${NL}${NL}Даних ще мало для графіка.`
  );
  return true;
}

/** Turns the daily summary off or back on for a person. @returns {Promise<boolean>} true if now off */
export async function toggleSummaries(env, chatId) {
  const off = (await kvGet(env, `nosum:${chatId}`)) === '1';
  await kvSet(env, `nosum:${chatId}`, off ? '0' : '1');
  return !off;
}
