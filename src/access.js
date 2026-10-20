/**
 * People and their access, for admins: the compact users list, a person's card, and two
 * access editors — by person (every site and device) and by site or device (every person).
 *
 * Editors work on a draft: taps change only the draft, "✅ Зберегти" writes it, "✖️ Скасувати"
 * drops it. The draft lives in kv "draft:<admin chat id>".
 *
 * Callback data "u:…": l list · o:<uid> card · r:<uid> confirm removal · e:<uid> edit by person ·
 * k:<site.id|dev> edit by site/device · c:<key|uid> change a line · p:<page> page ·
 * q search · q0 clear search · s save · x cancel.
 */

import { LEVELS, LEVEL_LABEL, ROLES, deviceById, deviceSite, siteKey, siteTree, sitesOf } from './config.js';
import { clearPerm, db, kvGet, kvSet, setPerm } from './db.js';
import { displayName } from './store.js';
import { edit, send } from './telegram.js';
import { NL, esc } from './util.js';

const PAGE = 8;
const SHORT = { none: '🚫', view: '👁', control: '🎛' };

/** Keeps a name written right-to-left (Arabic, Hebrew) from scrambling the rest of the line. */
export const isolate = (text) => `⁨${text}⁩`;

export const userLabel = (u) =>
  `${isolate(esc(displayName(u)))}${u.alias && u.name ? ` (${isolate(esc(u.name))})` : ''}${u.username ? ` @${esc(u.username)}` : ''} (<code>${u.chat_id}</code>)`;

const roleIcon = (u) => (u.status === 'pending' ? '⏳' : u.role === 'admin' ? '👑' : '👤');
const back = (data, text = '⬅️ Назад') => [{ text, callback_data: data }];

/* ---------- reading levels, with a draft on top ---------- */

async function allRows(env) {
  const { results } = await (await db(env)).prepare('SELECT chat_id, device, perm FROM user_devices').all();
  return new Map(results.map((r) => [`${r.chat_id}|${r.device}`, r.perm]));
}

/** Levels as they would be after saving the draft. */
function levels(env, rows, ch = {}) {
  const raw = (uid, key) => {
    const k = `${uid}|${key}`;
    return k in ch ? ch[k] : (rows.get(k) ?? null);
  };
  const site = (uid, key) => raw(uid, key) || 'none';
  const device = (uid, dev) => {
    const s = deviceSite(env, dev);
    const sl = s ? site(uid, siteKey(s)) : 'none';
    const lim = raw(uid, dev);
    return { site: sl, limit: lim, level: lim && LEVELS.indexOf(lim) < LEVELS.indexOf(sl) ? lim : sl };
  };
  return { raw, site, device };
}

/** Next value of one line. @returns {{value: string | null} | {error: string}} */
function nextValue(env, L, uid, key) {
  if (key.startsWith('site.')) return { value: LEVELS[(LEVELS.indexOf(L.site(uid, key)) + 1) % LEVELS.length] };
  // A device follows its site, or is limited to a level below it.
  const d = L.device(uid, key);
  const options = [null, ...LEVELS.slice(0, LEVELS.indexOf(d.site)).reverse()];
  if (options.length === 1) return { error: "Спершу відкрий доступ до об'єкта" };
  return { value: options[(options.indexOf(d.limit) + 1) % options.length] };
}

/* ---------- draft ---------- */

const draftKey = (chat) => `draft:${chat}`;
const getDraft = async (env, chat) => JSON.parse((await kvGet(env, draftKey(chat))) || 'null');
const setDraft = (env, chat, d) => kvSet(env, draftKey(chat), JSON.stringify(d));
const dropDraft = (env, chat) => kvSet(env, draftKey(chat), 'null');

async function saveDraft(env, d) {
  for (const [k, v] of Object.entries(d.ch)) {
    const i = k.indexOf('|');
    const uid = Number(k.slice(0, i));
    const key = k.slice(i + 1);
    if (v === null) await clearPerm(env, uid, key);
    else await setPerm(env, uid, key, v);
  }
}

const people = async (env) =>
  (await (await db(env)).prepare("SELECT * FROM users WHERE status IN ('approved','pending') ORDER BY created").all())
    .results;

/* ---------- screens ---------- */

/** "Дім 🎛 · Майстерня 👁" — the sites a user sees. */
function shortAccess(env, L, u) {
  if (u.status === 'pending') return 'чекає схвалення';
  if (u.role === 'admin') return 'адмін, усе';
  const parts = sitesOf(env)
    .map((s) => [s, L.site(u.chat_id, siteKey(s))])
    .filter(([, l]) => l !== 'none')
    .map(([s, l]) => `${esc(s.name)} ${SHORT[l]}`);
  return parts.join(' · ') || 'нічого не бачить';
}

/** "👥 Користувачі": one line per person, buttons two in a row. */
export async function usersList(env) {
  const list = await people(env);
  if (!list.length) return { text: 'Користувачів немає.', kb: [] };
  const L = levels(env, await allRows(env));
  const lines = list.map((u) => `${roleIcon(u)} ${isolate(esc(displayName(u)))}: ${shortAccess(env, L, u)}`);
  const kb = [];
  for (let i = 0; i < list.length; i += 2) {
    kb.push(
      list.slice(i, i + 2).map((u) => ({ text: `${roleIcon(u)} ${displayName(u)}`, callback_data: `u:o:${u.chat_id}` }))
    );
  }
  return {
    text: [
      `<b>👥 Користувачі</b> (${list.length})`,
      '👑 адмін · 👤 користувач · ⏳ чекає · 👁 бачить · 🎛 керує',
      '',
      ...lines,
    ].join(NL),
    kb,
  };
}

/** A person's card: who, role, access, and every action on them. */
export async function userCard(env, me, u) {
  const L = levels(env, await allRows(env));
  const lines = [`${roleIcon(u)} ${userLabel(u)}`];
  if (u.status === 'pending') lines.push('Чекає схвалення.');
  else lines.push(`Роль: ${ROLES[u.role] || ROLES.user}`, `Доступ: ${shortAccess(env, L, u)}`);
  if (u.alias) lines.push(`У повідомленнях: ${isolate(esc(u.alias))}`);

  const id = u.chat_id;
  const kb = [];
  if (u.status === 'pending') {
    kb.push(
      [
        { text: '👤 Схвалити: користувач', callback_data: `a:${id}:user` },
        { text: '👑 Адмін', callback_data: `a:${id}:admin` },
      ],
      [{ text: 'Відхилити', callback_data: `r:${id}` }]
    );
  } else if (id !== me.chat_id) {
    if (u.role !== 'admin') kb.push([{ text: '🔐 Доступ', callback_data: `u:e:${id}` }]);
    kb.push([
      u.role === 'admin'
        ? { text: '👤 Зробити користувачем', callback_data: `a:${id}:user` }
        : { text: '👑 Зробити адміном', callback_data: `a:${id}:admin` },
    ]);
  }
  if (u.status === 'approved') kb.push([{ text: "✏️ Ім'я в повідомленнях", callback_data: `s:uo:${id}` }]);
  if (u.status === 'approved' && id !== me.chat_id) kb.push([{ text: '🗑 Прибрати', callback_data: `u:r:${id}` }]);
  kb.push(back('u:l', '⬅️ Користувачі'));
  return { text: lines.join(NL), kb };
}

function footer(env, d) {
  const rows = [
    [
      { text: '✅ Зберегти', callback_data: 'u:s' },
      { text: '✖️ Скасувати', callback_data: 'u:x' },
    ],
  ];
  if (d.mode === 'key') rows.push(back(d.key.startsWith('site.') ? `s:so:${d.key.slice(5)}` : `s:do:${d.key}`));
  return rows;
}

const pendingNote = (d) => (Object.keys(d.ch).length ? `${NL}${NL}<i>Є незбережені зміни.</i>` : '');

/** Editor by person: every site, its devices indented under it. */
async function byUserView(env, d) {
  const u = await (await db(env)).prepare('SELECT * FROM users WHERE chat_id=?').bind(d.uid).first();
  const L = levels(env, await allRows(env), d.ch);
  const kb = [];
  for (const { site, key, devices } of siteTree(env)) {
    kb.push([{ text: `⚡ ${site.name}: ${LEVEL_LABEL[L.site(d.uid, key)]}`, callback_data: `u:c:${key}` }]);
    for (const dev of devices) {
      const x = L.device(d.uid, dev);
      const { icon, name } = deviceById(env, dev);
      kb.push([
        {
          text: `      ${icon} ${name}: ${x.limit ? LEVEL_LABEL[x.level] : `як ${site.name}`}`,
          callback_data: `u:c:${dev}`,
        },
      ]);
    }
  }
  kb.push(...footer(env, d));
  return {
    text:
      [
        `🔐 Доступ: ${u ? userLabel(u) : d.uid}`,
        '',
        "⚡ Об'єкт: 🚫 немає → 👁 бачить (статус і сповіщення про світло) → 🎛 керує (ще й вмикає пристрої).",
        "Пристрій під об'єктом за замовчуванням має той самий доступ; можна обмежити, але не розширити.",
        'Натискай рядки, потім «✅ Зберегти».',
      ].join(NL) + pendingNote(d),
    kb,
  };
}

/** Editor by site or device: every person, with search and pages. */
async function byKeyView(env, d) {
  const isSite = d.key.startsWith('site.');
  const site = isSite ? sitesOf(env).find((s) => siteKey(s) === d.key) : deviceSite(env, d.key);
  const dev = isSite ? null : deviceById(env, d.key);
  const all = (await people(env)).filter((u) => u.status === 'approved');
  const admins = all.filter((u) => u.role === 'admin');
  const q = (d.q || '').toLowerCase();
  const users = all
    .filter((u) => u.role !== 'admin')
    .filter(
      (u) => !q || [u.name, u.username, u.alias, String(u.chat_id)].some((v) => (v || '').toLowerCase().includes(q))
    );
  const pages = Math.max(1, Math.ceil(users.length / PAGE));
  const page = Math.min(d.page || 0, pages - 1);
  const L = levels(env, await allRows(env), d.ch);

  const kb = users.slice(page * PAGE, page * PAGE + PAGE).map((u) => {
    let label;
    if (isSite) label = LEVEL_LABEL[L.site(u.chat_id, d.key)];
    else {
      const x = L.device(u.chat_id, d.key);
      label = x.limit ? LEVEL_LABEL[x.level] : `як ${site.name} (${SHORT[x.site]})`;
    }
    return [{ text: `${displayName(u)}: ${label}`, callback_data: `u:c:${u.chat_id}` }];
  });
  const nav = [];
  if (page > 0) nav.push({ text: '◀️', callback_data: `u:p:${page - 1}` });
  nav.push({ text: q ? `🔍 «${d.q}» ✖️` : '🔍 Пошук', callback_data: q ? 'u:q0' : 'u:q' });
  if (page < pages - 1) nav.push({ text: '▶️', callback_data: `u:p:${page + 1}` });
  kb.push(nav, ...footer(env, d));

  const title = isSite
    ? `⚡ ${esc(site?.name || d.key)}`
    : `${dev?.icon || ''} ${esc(dev?.name || d.key)} (${esc(site?.name || '—')})`;
  const lines = [`<b>👥 Доступ: ${title}</b>`];
  if (admins.length)
    lines.push(`👑 Адміни бачать і керують усім: ${admins.map((a) => isolate(esc(displayName(a)))).join(', ')}`);
  lines.push(
    isSite
      ? 'Натискай людину: 🚫 немає → 👁 бачить → 🎛 керує.'
      : "Натискай людину: як об'єкт → обмежити. Розширити понад доступ до об'єкта не можна."
  );
  if (!users.length) lines.push(q ? 'Нікого не знайдено.' : 'Інших користувачів немає.');
  if (pages > 1) lines.push(`Сторінка ${page + 1} з ${pages}.`);
  return { text: lines.join(NL) + pendingNote(d), kb };
}

const draftView = (env, d) => (d.mode === 'user' ? byUserView(env, d) : byKeyView(env, d));

/* ---------- entry points ---------- */

/** Opens the access editor for a person (also right after approving them). */
export async function openUserEditor(env, adminChat, uid) {
  const d = { mode: 'user', uid, ch: {} };
  await setDraft(env, adminChat, d);
  return byUserView(env, d);
}

/** Search text typed while an editor waits for it. @returns {Promise<boolean>} */
export async function onAccessText(env, msg, user) {
  if (user.role !== 'admin') return false;
  const d = await getDraft(env, msg.chat.id);
  if (!d?.waitQ) return false;
  Object.assign(d, { q: (msg.text || '').trim().slice(0, 40), page: 0, waitQ: false });
  await setDraft(env, msg.chat.id, d);
  const v = await draftView(env, d);
  await send(env, msg.chat.id, v.text, { reply_markup: { inline_keyboard: v.kb } });
  return true;
}

/** "u:…" buttons. */
export async function onAccessCallback(env, cq, me, parts, done) {
  if (me.role !== 'admin') return done('Лише для адміна');
  const chat = me.chat_id;
  const [act, a] = parts;
  const show = async (v) => {
    await edit(env, cq, v.text, v.kb);
    return done();
  };
  const getU = (id) => db(env).then((D) => D.prepare('SELECT * FROM users WHERE chat_id=?').bind(Number(id)).first());

  switch (act) {
    case 'l':
      await dropDraft(env, chat);
      return show(await usersList(env));
    case 'o': {
      const u = await getU(a);
      if (!u) return show(await usersList(env));
      return show(await userCard(env, me, u));
    }
    case 'r': {
      const u = await getU(a);
      if (!u) return show(await usersList(env));
      return show({
        text: `Прибрати ${userLabel(u)}? Людина втратить доступ, кнопки в неї зникнуть.`,
        kb: [
          [
            { text: '🗑 Так, прибрати', callback_data: `r:${u.chat_id}` },
            { text: 'Ні', callback_data: `u:o:${u.chat_id}` },
          ],
        ],
      });
    }
    case 'e': {
      const u = await getU(a);
      if (!u || u.role === 'admin' || u.status !== 'approved') return done('Адмін бачить і керує всім');
      return show(await openUserEditor(env, chat, u.chat_id));
    }
    case 'k': {
      const key = parts.slice(1).join(':');
      const known = key.startsWith('site.')
        ? sitesOf(env).some((s) => siteKey(s) === key)
        : Boolean(deviceById(env, key));
      if (!known) return done('Не знайдено');
      const d = { mode: 'key', key, ch: {}, q: '', page: 0 };
      await setDraft(env, chat, d);
      return show(await byKeyView(env, d));
    }
  }

  const d = await getDraft(env, chat);
  if (!d) return done('Екран застарів, відкрий його ще раз');
  d.waitQ = false;
  switch (act) {
    case 'c': {
      const uid = d.mode === 'user' ? d.uid : Number(a);
      const key = d.mode === 'user' ? parts.slice(1).join(':') : d.key;
      const L = levels(env, await allRows(env), d.ch);
      const r = nextValue(env, L, uid, key);
      if (r.error) return done(r.error);
      d.ch[`${uid}|${key}`] = r.value;
      await setDraft(env, chat, d);
      const v = await draftView(env, d);
      await edit(env, cq, v.text, v.kb);
      return done(r.value === null ? "Як об'єкт" : LEVEL_LABEL[r.value]);
    }
    case 'p':
      d.page = Number(a) || 0;
      await setDraft(env, chat, d);
      return show(await draftView(env, d));
    case 'q':
      d.waitQ = true;
      await setDraft(env, chat, d);
      await send(env, chat, 'Надішли частину імені, @ніку або ID.');
      return done();
    case 'q0':
      Object.assign(d, { q: '', page: 0 });
      await setDraft(env, chat, d);
      return show(await draftView(env, d));
    case 's': {
      const n = Object.keys(d.ch).length;
      await saveDraft(env, d);
      let v;
      if (d.mode === 'user') {
        await dropDraft(env, chat);
        v = await userCard(env, me, await getU(d.uid));
      } else {
        // Stay on the list: the admin may go on with the next person.
        d.ch = {};
        await setDraft(env, chat, d);
        v = await byKeyView(env, d);
      }
      await edit(env, cq, `✅ Збережено.${NL}${NL}${v.text}`, v.kb);
      return done(n ? 'Збережено' : 'Змін не було');
    }
    case 'x':
      if (d.mode === 'user') {
        await dropDraft(env, chat);
        return show(await userCard(env, me, await getU(d.uid)));
      }
      Object.assign(d, { ch: {} });
      await setDraft(env, chat, d);
      return show(await byKeyView(env, d));
    default:
      return done('Невідома дія');
  }
}
