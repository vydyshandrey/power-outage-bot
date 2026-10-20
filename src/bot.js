/**
 * Telegram update handlers: text messages and inline-button callbacks.
 *
 * Access model: /start sends a request to admins. An admin approves the person as an admin
 * (everything) or a user. A user gets a level per site (none · sees · controls), and a device
 * may be limited below its site's level. The very first /start with ACCESS_KEY creates the first admin.
 *
 * Callback data: g:<days> outages · dl device list · d:<dev> card · h:<dev> history ·
 * dc:<dev>:on|off control · pd:<uid> access screen · pc:<uid>:<site.id|dev> next level ·
 * a:<uid>:<role> approve · r:<uid> reject or revoke.
 */

import { DEVICES, LEVELS, LEVEL_LABEL, ROLES, deviceSite, siteKey, siteTree } from './config.js';
import { clearPerm, db, deviceLimit, getPerm, getUser, kvSet, resetPerms, setPerm, usersBy } from './db.js';
import { boilerPower } from './midea.js';
import { deviceCard, deviceHistory, devicesMenu, outagesReport, statusText } from './reports.js';
import { broadcastDevice, edit, mainKeyboard, send, tg } from './telegram.js';
import { NL, esc, now } from './util.js';

const userLabel = (u) => `${esc(u.name || '')}${u.username ? ` @${esc(u.username)}` : ''} (<code>${u.chat_id}</code>)`;

const roleButtons = (uid) => [
  [
    { text: '👤 Користувач', callback_data: `a:${uid}:user` },
    { text: '👑 Адмін', callback_data: `a:${uid}:admin` },
  ],
];

/** "Дім: 🎛 керує · Майстерня: 🚫 немає" */
async function accessSummary(env, u) {
  if (u.role === 'admin') return 'Адмін: бачить і керує всім';
  const parts = [];
  for (const { site, key } of siteTree(env))
    parts.push(`${esc(site.name)}: ${LEVEL_LABEL[await getPerm(env, u, key)]}`);
  return parts.join(' · ');
}

/**
 * Permissions screen: each site with its level, its devices indented under it.
 * A device either follows its site or is limited below it.
 */
async function permsView(env, target) {
  const kb = [];
  for (const { site, key, devices } of siteTree(env)) {
    const level = await getPerm(env, target, key);
    kb.push([{ text: `⚡ ${site.name}: ${LEVEL_LABEL[level]}`, callback_data: `pc:${target.chat_id}:${key}` }]);
    for (const dev of devices) {
      const limit = await deviceLimit(env, target, dev);
      const label = limit ? LEVEL_LABEL[await getPerm(env, target, dev)] : `як ${site.name}`;
      const { icon, name } = DEVICES[dev];
      kb.push([{ text: `      ${icon} ${name}: ${label}`, callback_data: `pc:${target.chat_id}:${dev}` }]);
    }
  }
  return {
    text: [
      `🔐 Доступ: ${userLabel(target)}`,
      '',
      "⚡ Об'єкт: 🚫 немає → 👁 бачить (статус і сповіщення про світло) → 🎛 керує (ще й вмикає пристрої).",
      "Пристрій під об'єктом за замовчуванням має той самий доступ; можна обмежити, але не розширити.",
    ].join(NL),
    kb,
  };
}

/** Next value when an admin taps a line in the permissions screen. */
async function nextPerm(env, target, key) {
  if (key.startsWith('site.')) {
    const cur = await getPerm(env, target, key);
    return { kind: 'site', next: LEVELS[(LEVELS.indexOf(cur) + 1) % LEVELS.length] };
  }
  // Device: follows the site → each level below the site's → back to following the site.
  const siteLevel = await getPerm(env, target, siteKey(deviceSite(env, key)));
  const options = [null, ...LEVELS.slice(0, LEVELS.indexOf(siteLevel)).reverse()];
  const limit = await deviceLimit(env, target, key);
  return { kind: 'device', next: options[(options.indexOf(limit) + 1) % options.length], options };
}

/* ---------- messages ---------- */

async function handleStart(env, msg, user) {
  const id = msg.chat.id;
  const D = await db(env);
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ');
  const username = msg.from?.username || '';
  const arg = (msg.text || '').trim().split(' ').filter(Boolean)[1] || '';
  const admins = await usersBy(env, 'admin');

  if (!admins.length && arg && arg === env.ACCESS_KEY) {
    await D.prepare(
      'INSERT INTO users (chat_id,name,username,role,status,created) VALUES (?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET role=excluded.role, status=excluded.status'
    )
      .bind(id, name, username, 'admin', 'approved', now())
      .run();
    return send(env, id, '✅ Ти адмін. Нові користувачі надсилатимуть запит на доступ, а схвалювати їх будеш ти.', {
      reply_markup: mainKeyboard('admin'),
    });
  }
  if (user?.status === 'approved') {
    return send(env, id, `Ти вже маєш доступ: ${ROLES[user.role] || ROLES.user}.`, {
      reply_markup: mainKeyboard(user.role),
    });
  }
  if (user?.status === 'pending') return send(env, id, 'Запит уже надіслано, чекай на схвалення.');
  if (user?.status === 'rejected') return;

  await D.prepare('INSERT INTO users (chat_id,name,username,role,status,created) VALUES (?,?,?,?,?,?)')
    .bind(id, name, username, null, 'pending', now())
    .run();
  const created = await getUser(env, id);
  for (const a of admins) {
    await send(env, a.chat_id, `🙋 Запит на доступ: ${userLabel(created)}`, {
      reply_markup: { inline_keyboard: [...roleButtons(id), [{ text: 'Відхилити', callback_data: `r:${id}` }]] },
    });
  }
  return send(env, id, 'Запит на доступ надіслано адміністратору.');
}

async function listUsers(env, adminId) {
  const { results } = await (
    await db(env)
  )
    .prepare("SELECT * FROM users WHERE status IN ('approved','pending') ORDER BY created")
    .all();
  if (!results.length) return send(env, adminId, 'Користувачів немає.');
  for (const x of results) {
    const kb =
      x.chat_id === adminId
        ? undefined
        : {
            inline_keyboard: [
              ...roleButtons(x.chat_id),
              [
                { text: '🔐 Доступ', callback_data: `pd:${x.chat_id}` },
                { text: '🗑 Прибрати', callback_data: `r:${x.chat_id}` },
              ],
            ],
          };
    const state = x.status === 'pending' ? '⏳ очікує' : await accessSummary(env, x);
    await send(env, adminId, `${userLabel(x)}${NL}${state}`, kb ? { reply_markup: kb } : {});
  }
}

/** @param {import('./config.js').Env} env */
export async function onMessage(env, msg) {
  if (msg.chat?.type !== 'private') return;
  const id = msg.chat.id;
  const text = (msg.text || '').trim();
  const user = await getUser(env, id);

  if (text.startsWith('/start')) return handleStart(env, msg, user);
  if (user?.status !== 'approved') return;

  if (text === '/status' || text === '📊 Статус') {
    return send(env, id, await statusText(env, user), {
      reply_markup: { inline_keyboard: [[{ text: '🔌 Відключення за 7 днів', callback_data: 'g:7' }]] },
    });
  }
  if (text === '/devices' || text === '🏠 Пристрої') {
    const m = await devicesMenu(env, user);
    return send(env, id, m.text, m.kb.length ? { reply_markup: { inline_keyboard: m.kb } } : {});
  }
  if (['/on', '/off', '🔥 Бойлер ON', '⛔ Бойлер OFF'].includes(text)) {
    // Buttons from v1.0.0 that may still be on someone's keyboard.
    return send(env, id, 'Керування бойлером переїхало в «🏠 Пристрої».', { reply_markup: mainKeyboard(user.role) });
  }
  if ((text === '/users' || text === '👥 Користувачі') && user.role === 'admin') return listUsers(env, id);

  const menu = `Меню внизу: 📊 Статус, 🏠 Пристрої${user.role === 'admin' ? ', 👥 Користувачі' : ''}.`;
  return send(env, id, menu, { reply_markup: mainKeyboard(user.role) });
}

/* ---------- callbacks ---------- */

async function handleDevice(env, cq, me, act, dev, arg, done) {
  if (!DEVICES[dev]) return done('Невідомий пристрій');
  const perm = await getPerm(env, me, dev);
  if (perm === 'none') return done('Немає доступу до пристрою');

  if (act === 'h') {
    const v = await deviceHistory(env, dev);
    await edit(env, cq, v.text, v.kb);
    return done();
  }
  if (act === 'dc') {
    if (perm !== 'control') return done('Лише перегляд');
    const on = arg === 'on';
    const who = me.name || me.username || String(me.chat_id);
    try {
      await boilerPower(env, on, who);
      // A manual action cancels pending automation in either direction.
      await kvSet(env, 'boiler_auto_off', '0');
      await kvSet(env, 'want_off', '0');
      await broadcastDevice(env, dev, `${on ? '🔥 Бойлер увімкнено' : '⛔ Бойлер вимкнено'}: ${esc(who)}.`);
    } catch (e) {
      return done(`Не вдалося: ${e.message}`.slice(0, 190));
    }
  }
  const card = await deviceCard(env, me, dev);
  await edit(env, cq, card.text, card.kb);
  return done();
}

async function handleAdmin(env, cq, me, act, a1, a2, done) {
  if (me.role !== 'admin') return done('Немає прав');
  const tid = Number(a1);
  if (tid === me.chat_id) return done('Себе змінювати не можна');
  const target = await getUser(env, tid);
  if (!target) return done('Користувача не знайдено');
  const D = await db(env);

  if (act === 'pd') {
    if (target.role === 'admin') return done('Адмін бачить і керує всім');
    const v = await permsView(env, target);
    await send(env, me.chat_id, v.text, { reply_markup: { inline_keyboard: v.kb } });
    return done();
  }
  if (act === 'pc') {
    const known = a2.startsWith('site.') ? siteTree(env).some((n) => n.key === a2) : Boolean(DEVICES[a2]);
    if (!known || target.role === 'admin') return done('Не можна');
    const { kind, next, options } = await nextPerm(env, target, a2);
    if (kind === 'device' && options.length === 1) return done("Спершу відкрий доступ до об'єкта");
    if (next === null) await clearPerm(env, tid, a2);
    else await setPerm(env, tid, a2, next);
    const v = await permsView(env, target);
    await edit(env, cq, v.text, v.kb);
    return done(next === null ? "Як об'єкт" : LEVEL_LABEL[next]);
  }

  let result;
  if (act === 'a' && ROLES[a2]) {
    const wasUser = target.status === 'approved' && target.role !== 'admin';
    await D.prepare("UPDATE users SET role=?, status='approved' WHERE chat_id=?").bind(a2, tid).run();
    // A newly approved user, or an admin demoted to user, starts from "sees the first site";
    // an existing user keeps the access the admin already set.
    if (a2 === 'user' && !wasUser) await resetPerms(env, tid);
    await send(env, tid, `✅ Доступ надано: ${ROLES[a2]}.`, { reply_markup: mainKeyboard(a2) });
    if (a2 === 'user') {
      const v = await permsView(env, await getUser(env, tid));
      await edit(env, cq, `✅ ${userLabel(target)} → ${ROLES.user}${NL}${NL}${v.text}`, v.kb);
      return done('Готово');
    }
    result = `✅ ${userLabel(target)} → ${ROLES[a2]}`;
  } else if (act === 'r') {
    await D.prepare("UPDATE users SET status='rejected', role=NULL WHERE chat_id=?").bind(tid).run();
    await D.prepare('DELETE FROM user_devices WHERE chat_id=?').bind(tid).run();
    await send(env, tid, 'Доступ закрито.', { reply_markup: { remove_keyboard: true } });
    result = `🚫 ${userLabel(target)}: доступ закрито`;
  } else {
    return done('Невідома дія');
  }
  await edit(env, cq, result, act === 'r' ? undefined : [[{ text: '🔐 Доступ', callback_data: `pd:${tid}` }]]);
  return done('Готово');
}

/** @param {import('./config.js').Env} env */
export async function onCallback(env, cq) {
  const me = await getUser(env, cq.from.id);
  const done = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text });
  if (me?.status !== 'approved') return done('Немає доступу');
  const [act, a1, a2] = String(cq.data || '').split(':');

  if (act === 'g') {
    await send(env, me.chat_id, await outagesReport(env, me, Number(a1) || 7));
    return done();
  }
  if (act === 'dl') {
    const m = await devicesMenu(env, me);
    await edit(env, cq, m.text, m.kb);
    return done();
  }
  if (act === 'd' || act === 'h' || act === 'dc') return handleDevice(env, cq, me, act, a1, a2, done);
  return handleAdmin(env, cq, me, act, a1, a2, done);
}
