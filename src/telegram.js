/** Telegram Bot API: transport, keyboards and fan-out notifications. */

import { getPerm, usersBy } from './db.js';

/**
 * Calls a Bot API method.
 * @param {import('./config.js').Env} env
 * @param {string} method
 * @param {object} body
 */
export async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

/** Persistent reply keyboard; admins get the users button. */
export const mainKeyboard = (role) => ({
  keyboard:
    role === 'admin'
      ? [[{ text: '📊 Статус' }, { text: '🏠 Пристрої' }], [{ text: '👥 Користувачі' }]]
      : [[{ text: '📊 Статус' }, { text: '🏠 Пристрої' }]],
  resize_keyboard: true,
});

export function send(env, chatId, text, extra = {}) {
  return tg(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

/** Replaces the message a callback button belongs to. */
export function edit(env, callbackQuery, text, inlineKeyboard) {
  return tg(env, 'editMessageText', {
    chat_id: callbackQuery.message.chat.id,
    message_id: callbackQuery.message.message_id,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: inlineKeyboard ? { inline_keyboard: inlineKeyboard } : undefined,
  });
}

/** Sends to every approved user with at least `minRole`. One failure does not stop the rest. */
export async function broadcast(env, text, minRole = 'user', extra) {
  for (const u of await usersBy(env, minRole)) {
    try {
      await send(env, u.chat_id, text, typeof extra === 'function' ? extra(u) : extra);
    } catch {
      /* continue with the next recipient */
    }
  }
}

/** Sends a site or device notification to everyone who can at least see it. */
export async function broadcastDevice(env, dev, text) {
  for (const u of await usersBy(env, 'user')) {
    if ((await getPerm(env, u, dev)) === 'none') continue;
    try {
      await send(env, u.chat_id, text);
    } catch {
      /* continue with the next recipient */
    }
  }
}
