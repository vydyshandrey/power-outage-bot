/**
 * Telegram update handlers: text messages and inline-button callbacks.
 *
 * Access model: /start sends a request to admins. An admin approves the person as an admin
 * (everything) or a user. A user gets a level per site (none · sees · controls), and a device
 * may be limited below its site's level. The very first /start with ACCESS_KEY creates the first admin.
 *
 * Callback data: g:<days> outages · dl device list · d:<dev> card · h:<dev> history ·
 * dc:<dev>:on|off control · a:<uid>:<role> approve or change role · r:<uid> reject or revoke ·
 * u:… people and access (access.js) · s:… settings (settings.js).
 */

import { ROLES, controllable, deviceById, deviceSite } from './config.js';
import { db, getPerm, getUser, kvSet, resetPerms, usersBy } from './db.js';
import { DK, setDevicePower } from './devices.js';
import { render } from './messages.js';
import { onAccessCallback, onAccessText, openUserEditor, userCard, userLabel, usersList } from './access.js';
import { onSettingsCallback, onSettingsText, openSettings } from './settings.js';
import { displayName } from './store.js';
import { startUpdate } from './updates.js';
import { deviceCard, deviceHistory, devicesMenu, outagesReport, statusText } from './reports.js';
import { broadcastDevice, edit, mainKeyboard, send, tg } from './telegram.js';
import { NL, now } from './util.js';

const roleButtons = (uid) => [
  [
    { text: '👤 Користувач', callback_data: `a:${uid}:user` },
    { text: '👑 Адмін', callback_data: `a:${uid}:admin` },
  ],
];

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
  if ((text === '/users' || text === '👥 Користувачі') && user.role === 'admin') {
    const m = await usersList(env);
    return send(env, id, m.text, m.kb.length ? { reply_markup: { inline_keyboard: m.kb } } : {});
  }
  if ((text === '/settings' || text === '⚙️ Налаштування') && user.role === 'admin') return openSettings(env, id);
  if (await onAccessText(env, msg, user)) return;
  if (await onSettingsText(env, msg, user)) return;

  const menu = `Меню внизу: 📊 Статус, 🏠 Пристрої${user.role === 'admin' ? ', 👥 Користувачі, ⚙️ Налаштування' : ''}.`;
  return send(env, id, menu, { reply_markup: mainKeyboard(user.role) });
}

/* ---------- callbacks ---------- */

async function handleDevice(env, cq, me, act, dev, arg, done) {
  const device = deviceById(env, dev);
  if (!device) return done('Невідомий пристрій');
  const perm = await getPerm(env, me, dev);
  if (perm === 'none') return done('Немає доступу до пристрою');

  if (act === 'h') {
    const v = await deviceHistory(env, dev);
    await edit(env, cq, v.text, v.kb);
    return done();
  }
  if (act === 'dc') {
    if (perm !== 'control' || !controllable(device)) return done('Лише перегляд');
    const on = arg === 'on';
    const who = displayName(me);
    try {
      await setDevicePower(env, device, on, who);
      // A manual action cancels pending automation in either direction.
      await kvSet(env, DK(device, 'boiler_auto_off'), '0');
      await kvSet(env, DK(device, 'want_off'), '0');
      const vars = { device: device.name, object: deviceSite(env, dev)?.name || '', who };
      await broadcastDevice(env, dev, render(env, on ? 'manual_on' : 'manual_off', vars));
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

  // Access screens from older messages open today's editor.
  if (act === 'pd' || act === 'pc') {
    if (target.role === 'admin') return done('Адмін бачить і керує всім');
    const v = await openUserEditor(env, me.chat_id, tid);
    await edit(env, cq, v.text, v.kb);
    return done();
  }

  let result;
  if (act === 'a' && ROLES[a2]) {
    const wasUser = target.status === 'approved' && target.role !== 'admin';
    await D.prepare("UPDATE users SET role=?, status='approved' WHERE chat_id=?").bind(a2, tid).run();
    // A newly approved user, or an admin demoted to user, starts from "sees the first site";
    // an existing user keeps the access the admin already set.
    if (a2 === 'user' && !wasUser) await resetPerms(env, tid);
    await send(env, tid, `✅ Доступ надано: ${ROLES[a2]}.`, { reply_markup: mainKeyboard(a2) });
    if (a2 === 'user' && !wasUser) {
      const v = await openUserEditor(env, me.chat_id, tid);
      await edit(env, cq, `✅ ${userLabel(target)} → ${ROLES.user}${NL}${NL}${v.text}`, v.kb);
      return done('Готово');
    }
    const card = await userCard(env, me, await getUser(env, tid));
    await edit(env, cq, `✅ ${ROLES[a2]}.${NL}${NL}${card.text}`, card.kb);
    return done('Готово');
  } else if (act === 'r') {
    await D.prepare("UPDATE users SET status='rejected', role=NULL WHERE chat_id=?").bind(tid).run();
    await D.prepare('DELETE FROM user_devices WHERE chat_id=?').bind(tid).run();
    await send(env, tid, 'Доступ закрито.', { reply_markup: { remove_keyboard: true } });
    result = `🚫 ${userLabel(target)}: доступ закрито`;
  } else {
    return done('Невідома дія');
  }
  await edit(env, cq, result, [[{ text: '⬅️ Користувачі', callback_data: 'u:l' }]]);
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
  if (act === 'u') return onAccessCallback(env, cq, me, String(cq.data).split(':').slice(1), done);
  if (act === 's') return onSettingsCallback(env, cq, me, String(cq.data).split(':').slice(1), done);
  if (act === 'up') {
    if (me.role !== 'admin') return done('Лише для адміна');
    await send(env, me.chat_id, await startUpdate(env));
    return done();
  }
  return handleAdmin(env, cq, me, act, a1, a2, done);
}
