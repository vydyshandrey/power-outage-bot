/**
 * Telegram update handlers: text messages and inline-button callbacks.
 *
 * Access model: /start sends a request to admins; an admin approves with a role
 * (admin, control, notify) and may fine-tune per-device permissions.
 * The very first /start with ACCESS_KEY creates the first admin.
 *
 * Permissions are set per device and per site (⚡): a site permission decides who sees its
 * status and grid notifications.
 *
 * Callback data: g:<days> outages · dl device list · d:<dev> card · h:<dev> history ·
 * dc:<dev>:on|off control · pd:<uid> perms view · pc:<uid>:<dev> cycle perm ·
 * a:<uid>:<role> approve · r:<uid> reject or revoke.
 */

import { DEVICES, PERMS, PERM_LABEL, ROLES, SITE_PERMS, permTargets } from './config.js';
import { db, getPerm, getUser, kvSet, setDefaultPerms, setPerm, usersBy } from './db.js';
import { boilerPower } from './midea.js';
import { deviceCard, deviceHistory, devicesMenu, outagesReport, statusText } from './reports.js';
import { broadcastDevice, edit, mainKeyboard, send, tg } from './telegram.js';
import { NL, esc, now } from './util.js';

const userLabel = (u) => `${esc(u.name || '')}${u.username ? ` @${esc(u.username)}` : ''} (<code>${u.chat_id}</code>)`;

const roleButtons = (uid) => [
  [
    { text: 'Адмін', callback_data: `a:${uid}:admin` },
    { text: 'Керування', callback_data: `a:${uid}:control` },
    { text: 'Сповіщення', callback_data: `a:${uid}:notify` },
  ],
];

async function permsView(env, target) {
  const kb = [];
  for (const [dev, t] of Object.entries(permTargets(env))) {
    const p = await getPerm(env, target, dev);
    const label = t.kind === 'site' ? (p === 'none' ? '🚫 не бачить' : '👁 бачить статус') : PERM_LABEL[p];
    kb.push([{ text: `${t.icon} ${t.name}: ${label}`, callback_data: `pc:${target.chat_id}:${dev}` }]);
  }
  return {
    text: `📱 Права: ${userLabel(target)}${NL}Натискай, щоб змінити. Пристрої: немає → перегляд → керування. Об'єкти (⚡): хто бачить статус і отримує сповіщення про світло.`,
    kb,
  };
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
    return send(env, id, `Ти вже маєш доступ: ${ROLES[user.role]}.`, { reply_markup: mainKeyboard(user.role) });
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
                { text: '📱 Пристрої', callback_data: `pd:${x.chat_id}` },
                { text: '🗑 Прибрати', callback_data: `r:${x.chat_id}` },
              ],
            ],
          };
    const state = x.status === 'pending' ? '⏳ очікує' : ROLES[x.role];
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
    if (target.role === 'admin') return done('Адмін має доступ до всього');
    const v = await permsView(env, target);
    await send(env, me.chat_id, v.text, { reply_markup: { inline_keyboard: v.kb } });
    return done();
  }
  if (act === 'pc') {
    const t = permTargets(env)[a2];
    if (!t || target.role === 'admin') return done('Не можна');
    const cycle = t.kind === 'site' ? SITE_PERMS : PERMS;
    const cur = await getPerm(env, target, a2);
    const next = cycle[(Math.max(cycle.indexOf(cur), 0) + 1) % cycle.length];
    await setPerm(env, tid, a2, next);
    const v = await permsView(env, target);
    await edit(env, cq, v.text, v.kb);
    return done(t.kind === 'site' ? (next === 'none' ? 'Не бачить' : 'Бачить') : PERM_LABEL[next]);
  }

  let result;
  if (act === 'a' && ROLES[a2]) {
    await D.prepare("UPDATE users SET role=?, status='approved' WHERE chat_id=?").bind(a2, tid).run();
    if (a2 !== 'admin') await setDefaultPerms(env, tid, a2, true);
    await send(env, tid, `✅ Доступ надано: ${ROLES[a2]}.`, { reply_markup: mainKeyboard(a2) });
    const note = a2 !== 'admin' ? `${NL}Права на пристрої скинуто до типових для ролі.` : '';
    result = `✅ ${userLabel(target)} → ${ROLES[a2]}${note}`;
  } else if (act === 'r') {
    await D.prepare("UPDATE users SET status='rejected', role=NULL WHERE chat_id=?").bind(tid).run();
    await D.prepare('DELETE FROM user_devices WHERE chat_id=?').bind(tid).run();
    await send(env, tid, 'Доступ закрито.', { reply_markup: { remove_keyboard: true } });
    result = `🚫 ${userLabel(target)}: доступ закрито`;
  } else {
    return done('Невідома дія');
  }
  await edit(env, cq, result, [[{ text: '📱 Пристрої', callback_data: `pd:${tid}` }]]);
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
