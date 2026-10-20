/**
 * "⚙️ Налаштування": everything the owner sets up in the bot, without touching code or
 * Cloudflare (only passwords stay in Cloudflare secrets). Admins only.
 *
 * Callback data starts with "s:". When the bot waits for typed text (a name, a message
 * text, an inverter number) the expected input is kept in kv "await:<chat id>".
 */

import { userCard } from './access.js';
import { CATEGORIES, DEVICE_TYPES, devicesOf, sitesOf } from './config.js';
import { db, kvGet, kvSet } from './db.js';
import { listDevices, missingDeviceSecrets } from './devices.js';
import { CLOUDS, listInverters, missingSecrets, probeInverter, secretNames } from './inverter.js';
import { TEMPLATES, VARS, fill, templateText, unknownVars } from './messages.js';
import {
  addDevice,
  addSite,
  deleteDevice,
  deleteSite,
  setAlias,
  setSetting,
  setTemplate,
  updateDevice,
  updateSite,
} from './store.js';
import { edit, send } from './telegram.js';
import { NL, esc } from './util.js';
import { updateOffer } from './updates.js';

const back = (data) => [{ text: '⬅️ Назад', callback_data: data }];

/* ---------- waiting for typed input ---------- */

const awaitKey = (chat) => `await:${chat}`;
const getAwait = async (env, chat) => JSON.parse((await kvGet(env, awaitKey(chat))) || 'null');
const setAwait = (env, chat, state) => kvSet(env, awaitKey(chat), JSON.stringify(state));
const clearAwait = (env, chat) => kvSet(env, awaitKey(chat), 'null');

/** Asks for text and remembers what it is for. */
async function ask(env, chat, state, question) {
  await setAwait(env, chat, state);
  return send(env, chat, `${question}${NL}${NL}<i>Надішли відповідь повідомленням. /cancel — скасувати.</i>`);
}

/** Bold, italic, underline and code typed in Telegram, as the HTML the bot sends. */
export function entitiesToHtml(text, entities = []) {
  const tags = { bold: 'b', italic: 'i', underline: 'u', strikethrough: 's', code: 'code' };
  const open = {};
  const close = {};
  for (const e of entities) {
    const t = tags[e.type];
    if (!t) continue;
    (open[e.offset] ||= []).push(`<${t}>`);
    (close[e.offset + e.length] ||= []).unshift(`</${t}>`);
  }
  let out = '';
  for (let i = 0; i <= text.length; i++) {
    out += (close[i] || []).join('') + (open[i] || []).join('');
    if (i < text.length) out += esc(text[i]);
  }
  return out;
}

/* ---------- screens ---------- */

function mainMenu() {
  return {
    text: '<b>⚙️ Налаштування</b>',
    kb: [
      [{ text: "🏠 Об'єкти", callback_data: 's:sl' }],
      [{ text: '🔌 Пристрої', callback_data: 's:dl' }],
      [{ text: '✉️ Повідомлення', callback_data: 's:tl' }],
      [
        { text: '🕒 Часовий пояс', callback_data: 's:tz' },
        { text: '🔗 Репозиторій', callback_data: 's:rp' },
      ],
      [{ text: '⬆️ Оновлення', callback_data: 's:up' }],
    ],
  };
}

/** The app a person sees the inverter in: what the bot calls its cloud. */
const cloudLabel = (p) =>
  p.cloud === 'dess' && p.platform === 'shinemonitor' ? 'SmartClient' : CLOUDS[p.cloud]?.name || p.cloud;

const invertersOf = (env, siteId) => devicesOf(env).filter((d) => d.type === 'inverter' && d.site === siteId);
const siteOf = (env, id) => sitesOf(env).find((s) => s.id === id);

function sitesList(env) {
  const kb = sitesOf(env).map((s) => {
    const src = devicesOf(env).find((d) => d.id === s.source);
    return [
      { text: `🏠 ${s.name}${src ? ` · ${src.icon} ${src.name}` : ' · без інвертора'}`, callback_data: `s:so:${s.id}` },
    ];
  });
  kb.push([{ text: "➕ Додати об'єкт", callback_data: 's:sa' }], back('s:m'));
  return {
    text: "<b>🏠 Об'єкти</b>\nМісця: дім, майстерня, дача. Кожен бере стан світла зі свого інвертора.",
    kb,
  };
}

function siteCard(env, id) {
  const s = siteOf(env, id);
  if (!s) return sitesList(env);
  const src = devicesOf(env).find((d) => d.id === s.source);
  const lines = [
    `<b>🏠 ${esc(s.name)}</b>`,
    src
      ? `Світло видно з: ${src.icon} ${esc(src.name)} (${cloudLabel(src.params)}, ${esc(src.params.sn || '—')})`
      : 'Інвертора ще немає: бот не знає, чи є тут світло.',
  ];
  const devs = devicesOf(env).filter((d) => d.site === id);
  if (devs.length) lines.push(`Пристрої: ${devs.map((d) => `${d.icon} ${esc(d.name)}`).join(', ')}`);
  const kb = [
    [
      { text: '✏️ Назва', callback_data: `s:sn:${id}` },
      { text: '➕ Інвертор', callback_data: `s:ia:${id}` },
    ],
  ];
  if (invertersOf(env, id).length > 1) kb.push([{ text: '⚡ Звідки брати світло', callback_data: `s:si:${id}` }]);
  kb.push([{ text: '👥 Доступ людей', callback_data: `u:k:site.${id}` }]);
  kb.push([{ text: '🗑 Видалити', callback_data: `s:sd:${id}` }], back('s:sl'));
  return { text: lines.join(NL), kb };
}

function sourceMenu(env, id) {
  const s = siteOf(env, id);
  return {
    text: `З якого інвертора брати стан світла для «${esc(s?.name || '')}»?`,
    kb: [
      ...invertersOf(env, id).map((d) => [
        {
          text: `${d.id === s?.source ? '✅ ' : ''}${d.icon} ${d.name} · ${d.params.sn || cloudLabel(d.params)}`,
          callback_data: `s:sS:${id}:${d.id}`,
        },
      ]),
      back(`s:so:${id}`),
    ],
  };
}

const CLOUD_CHOICES = [
  { key: 'deye', label: 'DeyeCloud' },
  { key: 'dess', label: 'SmartESS / WatchPower' },
  { key: 'shine', label: 'SmartClient for Solar' },
  { key: 'valueclouds', label: 'SmartValue' },
];

function cloudMenu(siteId) {
  return {
    text: 'Яким застосунком ти дивишся цей інвертор?',
    kb: [
      ...CLOUD_CHOICES.map((c) => [{ text: c.label, callback_data: `s:sc:${c.key}` }]),
      back(siteId ? `s:so:${siteId}` : 's:sl'),
    ],
  };
}

function accountMenu(cloud) {
  return {
    text: [
      'Який акаунт?',
      'Основний — секрети з простими назвами. Якщо інвертори в різних акаунтах (наприклад, свій і батьків), для другого додай секрети з «_2» у кінці.',
    ].join(NL),
    kb: [1, 2, 3].map((n) => [
      {
        text: `🔑 ${n === 1 ? 'Основний' : `Акаунт ${n}`}: ${secretNames(cloud, n).join(', ')}`,
        callback_data: `s:sk:${n}`,
      },
    ]),
  };
}

function devicesList(env) {
  const sites = sitesOf(env);
  const kb = devicesOf(env).map((d) => [
    {
      text: `${d.icon} ${d.name} · ${sites.find((s) => s.id === d.site)?.name || '—'}`,
      callback_data: `s:do:${d.id}`,
    },
  ]);
  kb.push([{ text: '➕ Додати пристрій', callback_data: 's:da' }], back('s:m'));
  return { text: '<b>🔌 Пристрої</b>', kb };
}

function deviceCardSettings(env, id) {
  const d = devicesOf(env).find((x) => x.id === id);
  if (!d) return devicesList(env);
  const site = siteOf(env, d.site);
  const lines = [
    `<b>${d.icon} ${esc(d.name)}</b>`,
    `Категорія: ${CATEGORIES[DEVICE_TYPES[d.type]?.category]?.name || d.type}`,
    `Об'єкт: ${esc(site?.name || '—')}`,
  ];
  const kb = [
    [
      { text: '✏️ Назва', callback_data: `s:dn:${id}` },
      { text: '😀 Значок', callback_data: `s:di:${id}` },
    ],
  ];
  if (d.type === 'inverter') {
    lines.push(
      `Хмара: ${cloudLabel(d.params)}${d.params.account > 1 ? `, акаунт ${d.params.account}` : ''}`,
      `Номер: ${esc(d.params.sn || '—')}`,
      site?.source === id ? "Звідси бот бере стан світла об'єкта." : "Стан світла об'єкта береться з іншого інвертора."
    );
    kb.push([{ text: "📍 Об'єкт", callback_data: `s:ds:${id}` }]);
  } else {
    lines.push(`Автоматика: ${d.auto ? 'вимикати, коли зникає світло' : 'не чіпати'}`);
    kb.push(
      [
        { text: "📍 Об'єкт", callback_data: `s:ds:${id}` },
        { text: d.auto ? '🤖 Автоматика: так' : '🤖 Автоматика: ні', callback_data: `s:dA:${id}` },
      ],
      [{ text: '👥 Доступ людей', callback_data: `u:k:${id}` }]
    );
  }
  kb.push([{ text: '🗑 Видалити', callback_data: `s:dd:${id}` }], back('s:dl'));
  return { text: lines.join(NL), kb };
}

function templatesList(env) {
  const kb = Object.entries(TEMPLATES).map(([k, t]) => [
    { text: `${env.CFG?.templates?.[k] !== undefined ? '✏️ ' : ''}${t.title}`, callback_data: `s:to:${k}` },
  ]);
  kb.push(back('s:m'));
  return { text: '<b>✉️ Повідомлення</b>\n✏️ — текст змінено тобою.', kb };
}

function templateCard(env, key) {
  const t = TEMPLATES[key];
  const custom = env.CFG?.templates?.[key] !== undefined;
  const text = templateText(env, key);
  const kb = [[{ text: '✏️ Змінити текст', callback_data: `s:te:${key}` }]];
  if (custom) kb.push([{ text: '↩️ Повернути стандартний', callback_data: `s:tr:${key}` }]);
  kb.push(back('s:tl'));
  return {
    text: [
      `<b>${t.title}</b>${custom ? ' (змінено)' : ''}`,
      '',
      'Так виглядає зараз:',
      fill(text, t.sample),
      '',
      'Текст зі змінними:',
      `<code>${esc(text)}</code>`,
      '',
      'Змінні:',
      ...t.vars.map((v) => `<code>{${v}}</code> — ${VARS[v]}`),
    ].join(NL),
    kb,
  };
}

const TZ_CHOICES = ['Europe/Kyiv', 'Europe/Warsaw', 'Europe/Berlin', 'Europe/London'];

function tzMenu(env) {
  const cur = env.CFG?.settings?.tz || env.TZ || 'Europe/Kyiv';
  return {
    text: `<b>🕒 Часовий пояс</b>${NL}Зараз: ${esc(cur)}`,
    kb: [
      ...TZ_CHOICES.map((z) => [{ text: `${z === cur ? '✅ ' : ''}${z}`, callback_data: `s:tZ:${z}` }]),
      [{ text: '✏️ Інший', callback_data: 's:tY' }],
      back('s:m'),
    ],
  };
}

function repoMenu(env) {
  const repo = env.CFG?.settings?.repo;
  return {
    text: [
      '<b>🔗 Репозиторій</b>',
      `Твоя копія проєкту на GitHub: ${repo ? esc(repo) : 'не вказано'}`,
      '',
      'Потрібна, щоб оновлюватись кнопкою. Формат: <code>власник/назва</code>, як в адресі github.com/власник/назва.',
    ].join(NL),
    kb: [[{ text: '✏️ Вказати', callback_data: 's:rE' }], back('s:m')],
  };
}

/* ---------- adding an inverter ---------- */

/** After the cloud and account are chosen: check secrets, then list inverters or ask for numbers. */
async function pickInverter(env, chat, state, cq) {
  const backTo = `s:so:${state.siteId}`;
  const missing = missingSecrets(env, state.cloud, state.account);
  if (missing.length) {
    const text = [
      '🔑 Потрібні паролі від хмари. Додай у Cloudflare (воркер → Settings → Variables and Secrets → Add → Secret):',
      ...missing.map((n) => `• <code>${n}</code>`),
      '',
      'Після цього натисни «Перевірити».',
    ].join(NL);
    return edit(env, cq, text, [[{ text: '🔄 Перевірити', callback_data: `s:sk:${state.account}` }], back(backTo)]);
  }
  let found;
  try {
    found = await listInverters(env, state.cloud, state.account, state.extra || {});
  } catch (e) {
    return edit(env, cq, `Не вдалося увійти в хмару: ${esc(e.message)}`, [
      [{ text: '🔄 Спробувати ще', callback_data: `s:sk:${state.account}` }],
      back(backTo),
    ]);
  }
  if (found === null) {
    await edit(env, cq, '✅ Вхід у SmartValue працює.', []);
    return ask(
      env,
      chat,
      { ...state, kind: 'vc', step: 0, params: {} },
      'Відкрий у SmartValue пристрій → «Деталі пристрою».\nНадішли <b>PN</b>.'
    );
  }
  const taken = new Set(
    devicesOf(env)
      .filter((d) => d.type === 'inverter')
      .map((d) => d.params.sn)
  );
  found = found.filter((f) => !taken.has(f.params.sn));
  if (!found.length) return edit(env, cq, 'Нових інверторів у цьому акаунті не знайдено.', [back(backTo)]);
  await setAwait(env, chat, { ...state, kind: 'pick', found });
  return edit(
    env,
    cq,
    'Обери інвертор:',
    found.slice(0, 20).map((f, i) => [{ text: f.label.slice(0, 60), callback_data: `s:sp:${i}` }])
  );
}

/** Stores the chosen inverter as a device of the site; the site's first inverter shows its grid. */
async function saveInverter(env, chat, state, params) {
  await clearAwait(env, chat);
  const site = siteOf(env, state.siteId);
  if (!site) return send(env, chat, "Об'єкт уже видалено.");
  const id = await addDevice(env, {
    type: 'inverter',
    name: DEVICE_TYPES.inverter.name,
    icon: DEVICE_TYPES.inverter.icon,
    site: site.id,
    params: { cloud: state.cloud, account: state.account, ...(state.extra || {}), ...params },
    auto: false,
  });
  if (!site.source) await updateSite(env, site.id, { source: id });
  const card = siteCard(env, site.id);
  return send(env, chat, `✅ Збережено.${NL}${NL}${card.text}`, { reply_markup: { inline_keyboard: card.kb } });
}

const VC_STEPS = [
  { key: 'pn', ask: 'Надішли <b>SN</b>.' },
  { key: 'sn', ask: "Надішли <b>Протокол зв'язку</b> (число). Якщо його немає — надішли «-»." },
  { key: 'devcode', ask: "Надішли <b>Адресу зв'язку</b> (число). Якщо її немає — надішли «-»." },
  { key: 'devaddr', ask: null },
];

/* ---------- typed input ---------- */

/**
 * Handles text the bot was waiting for. @returns {Promise<boolean>} false if nothing was awaited
 */
export async function onSettingsText(env, msg, user) {
  const chat = msg.chat.id;
  const state = await getAwait(env, chat);
  if (!state || user.role !== 'admin') return false;
  const text = (msg.text || '').trim();
  if (text === '/cancel') {
    await clearAwait(env, chat);
    await send(env, chat, 'Скасовано.');
    return true;
  }
  if (!text) return true;

  switch (state.kind) {
    case 'site_new_name': {
      const id = await addSite(env, { name: text.slice(0, 40) });
      await setAwait(env, chat, { kind: 'inv_new', siteId: id });
      const m = cloudMenu(id);
      await send(env, chat, `✅ Об'єкт «${esc(text.slice(0, 40))}» додано. Тепер його інвертор.${NL}${NL}${m.text}`, {
        reply_markup: { inline_keyboard: m.kb },
      });
      return true;
    }
    case 'site_name': {
      await updateSite(env, state.id, { name: text.slice(0, 40) });
      await clearAwait(env, chat);
      const c = siteCard(env, state.id);
      await send(env, chat, c.text, { reply_markup: { inline_keyboard: c.kb } });
      return true;
    }
    case 'vc': {
      const step = VC_STEPS[state.step];
      const params = { ...state.params, [step.key]: text === '-' ? '' : text };
      const next = VC_STEPS[state.step + 1];
      if (next && step.ask) {
        await ask(env, chat, { ...state, step: state.step + 1, params }, step.ask);
        return true;
      }
      try {
        const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v));
        const { params: found, sample } = await probeInverter(env, state.cloud, state.account, clean);
        await send(env, chat, `✅ Інвертор відповідає: мережа ${sample.grid ? 'є' : 'немає'}, батарея ${sample.soc}%.`);
        await saveInverter(env, chat, state, found);
      } catch (e) {
        await clearAwait(env, chat);
        await send(env, chat, `Не вдалося прочитати інвертор: ${esc(e.message)}. Перевір номери й спробуй ще раз.`, {
          reply_markup: { inline_keyboard: [back(`s:so:${state.siteId}`)] },
        });
      }
      return true;
    }
    case 'device_name':
    case 'device_icon': {
      const field = state.kind === 'device_name' ? { name: text.slice(0, 40) } : { icon: [...text][0] };
      await updateDevice(env, state.id, field);
      await clearAwait(env, chat);
      const c = deviceCardSettings(env, state.id);
      await send(env, chat, c.text, { reply_markup: { inline_keyboard: c.kb } });
      return true;
    }
    case 'tpl': {
      const html = entitiesToHtml(msg.text, msg.entities);
      const unknown = unknownVars(state.key, html);
      if (unknown.length) {
        await send(
          env,
          chat,
          `Невідомі змінні: ${unknown.map((u) => `<code>{${u}}</code>`).join(', ')}.${NL}Можна: ${TEMPLATES[state.key].vars.map((v) => `<code>{${v}}</code>`).join(', ')}.${NL}Надішли текст ще раз або /cancel.`
        );
        return true;
      }
      await setAwait(env, chat, { kind: 'tpl_confirm', key: state.key, text: html });
      await send(env, chat, `Так виглядатиме:${NL}${NL}${fill(html, TEMPLATES[state.key].sample)}`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Зберегти', callback_data: 's:ts' },
              { text: '✖️ Скасувати', callback_data: 's:tx' },
            ],
          ],
        },
      });
      return true;
    }
    case 'alias': {
      await setAlias(env, state.id, text === '-' ? null : text.slice(0, 40));
      await clearAwait(env, chat);
      const u = await (await db(env)).prepare('SELECT * FROM users WHERE chat_id=?').bind(state.id).first();
      const m = await userCard(env, user, u);
      await send(env, chat, m.text, { reply_markup: { inline_keyboard: m.kb } });
      return true;
    }
    case 'tz': {
      try {
        new Intl.DateTimeFormat('uk-UA', { timeZone: text }).format();
      } catch {
        await send(
          env,
          chat,
          'Не знаю такого часового поясу. Приклад: <code>Europe/Kyiv</code>. Спробуй ще або /cancel.'
        );
        return true;
      }
      await setSetting(env, 'tz', text);
      await clearAwait(env, chat);
      await send(env, chat, `✅ Часовий пояс: ${esc(text)}`);
      return true;
    }
    case 'repo': {
      const repo = text.replace(/^https?:\/\/github\.com\//, '').replace(/\/$/, '');
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
        await send(env, chat, 'Формат: <code>власник/назва</code>. Спробуй ще або /cancel.');
        return true;
      }
      await setSetting(env, 'repo', repo);
      await clearAwait(env, chat);
      await send(env, chat, `✅ Репозиторій: ${esc(repo)}`);
      return true;
    }
    default:
      await clearAwait(env, chat);
      return false;
  }
}

/* ---------- buttons ---------- */

/** @param {string[]} parts callback data split by ":" without the leading "s" */
export async function onSettingsCallback(env, cq, me, parts, done) {
  if (me.role !== 'admin') return done('Лише для адміна');
  const chat = me.chat_id;
  const [act, a, b] = parts;
  const show = async (view) => {
    await edit(env, cq, view.text, view.kb);
    return done();
  };
  const state = (await getAwait(env, chat)) || {};

  switch (act) {
    case 'm':
      await clearAwait(env, chat);
      return show(mainMenu());

    /* sites */
    case 'sl':
      await clearAwait(env, chat);
      return show(sitesList(env));
    case 'so':
      return show(siteCard(env, a));
    case 'sa':
      await ask(env, chat, { kind: 'site_new_name' }, "Як назвати об'єкт? Наприклад: Дім, Майстерня, Дача.");
      return done();
    case 'sn':
      await ask(env, chat, { kind: 'site_name', id: a }, "Нова назва об'єкта:");
      return done();
    case 'ia':
      if (!siteOf(env, a)) return show(sitesList(env));
      await setAwait(env, chat, { kind: 'inv_new', siteId: a });
      return show(cloudMenu(a));
    case 'si':
      return show(sourceMenu(env, a));
    case 'sS':
      if (invertersOf(env, a).some((d) => d.id === b)) await updateSite(env, a, { source: b });
      return show(siteCard(env, a));
    case 'sc': {
      const cloud = a === 'shine' ? 'dess' : a;
      const extra = a === 'shine' ? { platform: 'shinemonitor' } : {};
      await setAwait(env, chat, { ...state, cloud, extra });
      return show(accountMenu(cloud));
    }
    case 'sk':
      if (!state.cloud || !state.siteId) return show(sitesList(env));
      await setAwait(env, chat, { ...state, account: Number(a) || 1 });
      await pickInverter(env, chat, { ...state, account: Number(a) || 1 }, cq);
      return done();
    case 'sp': {
      const f = state.found?.[Number(a)];
      if (!f) return show(sitesList(env));
      await edit(env, cq, `Обрано: ${esc(f.label)}`, []);
      await saveInverter(env, chat, state, f.params);
      return done();
    }
    case 'sd':
      return show({
        text: "Видалити об'єкт разом з його пристроями й доступами людей? Історія лишиться.",
        kb: [
          [
            { text: '🗑 Так, видалити', callback_data: `s:sD:${a}` },
            { text: 'Ні', callback_data: `s:so:${a}` },
          ],
        ],
      });
    case 'sD':
      await deleteSite(env, a);
      return show(sitesList(env));

    /* devices */
    case 'dl':
      await clearAwait(env, chat);
      return show(devicesList(env));
    case 'do':
      return show(deviceCardSettings(env, a));
    case 'da':
      if (!sitesOf(env).length) return show({ text: "Спершу додай об'єкт.", kb: [back('s:m')] });
      return show({
        text: 'Який пристрій?',
        kb: [
          ...Object.entries(DEVICE_TYPES).map(([k, t]) => [
            {
              text: `${t.icon} ${t.name}${t.vendor ? ` ${t.vendor}` : ''}`,
              callback_data: k === 'inverter' ? 's:dI' : `s:dt:${k}`,
            },
          ]),
          back('s:dl'),
        ],
      });
    case 'dI':
      return show({
        text: "На якому об'єкті цей інвертор?",
        kb: [...sitesOf(env).map((s) => [{ text: `🏠 ${s.name}`, callback_data: `s:ia:${s.id}` }]), back('s:da')],
      });
    case 'dt': {
      const missing = missingDeviceSecrets(env, a);
      if (missing.length) {
        return show({
          text: [
            '🔑 Потрібен акаунт Midea для бота. Додай у Cloudflare секрети:',
            ...missing.map((n) => `• <code>${n}</code>`),
            '',
            'Це має бути окремий акаунт SmartHome, з яким основний поділився бойлером.',
          ].join(NL),
          kb: [[{ text: '🔄 Перевірити', callback_data: `s:dt:${a}` }], back('s:dl')],
        });
      }
      let found;
      try {
        found = await listDevices(env, a);
      } catch (e) {
        return show({
          text: `Не вдалося увійти в хмару: ${esc(e.message)}`,
          kb: [[{ text: '🔄 Ще раз', callback_data: `s:dt:${a}` }], back('s:dl')],
        });
      }
      const taken = new Set(devicesOf(env).map((d) => d.params.device_id));
      found = found.filter((f) => !taken.has(f.params.device_id));
      if (!found.length) return show({ text: 'Нових пристроїв в акаунті не знайдено.', kb: [back('s:dl')] });
      await setAwait(env, chat, { kind: 'dev_pick', type: a, found });
      return show({
        text: 'Обери пристрій:',
        kb: found.slice(0, 20).map((f, i) => [{ text: f.label.slice(0, 60), callback_data: `s:dp:${i}` }]),
      });
    }
    case 'dp': {
      const f = state.found?.[Number(a)];
      if (!f) return show(devicesList(env));
      await setAwait(env, chat, { ...state, chosen: f });
      return show({
        text: "До якого об'єкта він належить? Коли там зникне світло, бот його вимкне.",
        kb: sitesOf(env).map((s) => [{ text: `🏠 ${s.name}`, callback_data: `s:dP:${s.id}` }]),
      });
    }
    case 'dP': {
      if (!state.chosen) return show(devicesList(env));
      const t = DEVICE_TYPES[state.type];
      const id = await addDevice(env, {
        type: state.type,
        name: t.name,
        icon: t.icon,
        site: a,
        params: state.chosen.params,
      });
      await clearAwait(env, chat);
      return show(deviceCardSettings(env, id));
    }
    case 'dn':
      await ask(env, chat, { kind: 'device_name', id: a }, 'Нова назва пристрою:');
      return done();
    case 'di':
      await ask(env, chat, { kind: 'device_icon', id: a }, 'Надішли один емодзі для значка.');
      return done();
    case 'ds':
      return show({
        text: "До якого об'єкта належить пристрій?",
        kb: [
          ...sitesOf(env).map((s) => [{ text: `🏠 ${s.name}`, callback_data: `s:dS:${a}:${s.id}` }]),
          back(`s:do:${a}`),
        ],
      });
    case 'dS':
      await updateDevice(env, a, { site: b });
      return show(deviceCardSettings(env, a));
    case 'dA': {
      const d = devicesOf(env).find((x) => x.id === a);
      if (d && d.type !== 'inverter') await updateDevice(env, a, { auto: !d.auto });
      return show(deviceCardSettings(env, a));
    }
    case 'dd':
      return show({
        text: [
          'Видалити пристрій з бота? Сам пристрій і його історія не постраждають.',
          sitesOf(env).some((s) => s.source === a && invertersOf(env, s.id).length === 1)
            ? "Об'єкт лишиться без джерела стану світла, поки не додаси інший інвертор."
            : '',
        ]
          .filter(Boolean)
          .join(NL),
        kb: [
          [
            { text: '🗑 Так, видалити', callback_data: `s:dD:${a}` },
            { text: 'Ні', callback_data: `s:do:${a}` },
          ],
        ],
      });
    case 'dD':
      await deleteDevice(env, a);
      return show(devicesList(env));

    /* message texts */
    case 'tl':
      await clearAwait(env, chat);
      return show(templatesList(env));
    case 'to':
      if (!TEMPLATES[a]) return show(templatesList(env));
      return show(templateCard(env, a));
    case 'te':
      await ask(
        env,
        chat,
        { kind: 'tpl', key: a },
        `Надішли новий текст для «${TEMPLATES[a].title}».${NL}Можна жирний і курсив, як звичайно в Telegram. Змінні пиши у фігурних дужках, наприклад <code>{time}</code>.`
      );
      return done();
    case 'ts':
      if (state.kind !== 'tpl_confirm') return show(templatesList(env));
      await setTemplate(env, state.key, state.text);
      await clearAwait(env, chat);
      return show(templateCard(env, state.key));
    case 'tx':
      await clearAwait(env, chat);
      return show(templatesList(env));
    case 'tr':
      await setTemplate(env, a, null);
      return show(templateCard(env, a));

    /* people, time zone, repository, updates */
    case 'uo':
      await ask(
        env,
        chat,
        { kind: 'alias', id: Number(a) },
        'Як називати цю людину в повідомленнях? «-» — як у Telegram.'
      );
      return done();
    case 'tz':
      return show(tzMenu(env));
    case 'tZ':
      await setSetting(env, 'tz', parts.slice(1).join(':'));
      return show(tzMenu(env));
    case 'tY':
      await ask(env, chat, { kind: 'tz' }, 'Надішли часовий пояс, наприклад <code>Europe/Kyiv</code>.');
      return done();
    case 'rp':
      return show(repoMenu(env));
    case 'rE':
      await ask(env, chat, { kind: 'repo' }, 'Надішли <code>власник/назва</code> своєї копії проєкту на GitHub.');
      return done();
    case 'up': {
      let offer;
      try {
        offer = await updateOffer();
      } catch (e) {
        return show({ text: `Не вдалося перевірити оновлення: ${esc(e.message)}`, kb: [back('s:m')] });
      }
      return show({ text: offer.text, kb: [...offer.kb, back('s:m')] });
    }
    default:
      return done('Невідома дія');
  }
}

/** "⚙️ Налаштування" from the keyboard. */
export async function openSettings(env, chat) {
  await clearAwait(env, chat);
  const m = mainMenu();
  return send(env, chat, m.text, { reply_markup: { inline_keyboard: m.kb } });
}
