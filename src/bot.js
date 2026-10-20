/**
 * Telegram update handlers: text messages and inline-button callbacks.
 *
 * Access model (2.0): people work in cabinets. /start offers to create one's own cabinet or
 * to come in with an invitation link (/start inv_<code>) from a cabinet's admin. In a cabinet,
 * an admin sees and controls everything; a member gets a level per site (none · sees ·
 * controls), and a device may be limited below its site's level. The very first /start with
 * ACCESS_KEY creates the operator, the admin of the first cabinet. When the operator closes
 * sign-up, /start sends a request to the operators instead, as before 2.0.
 *
 * Callback data: g:<days> outages · dl device list · d:<dev> card · h:<dev> history ·
 * dc:<dev>:on|off control · a:<uid>:<role> approve or change role · r:<uid> reject or revoke ·
 * cb:new create a cabinet · cb:inv how to join one ·
 * u:… people and access (access.js) · s:… settings (settings.js).
 */

import { HOME, ROLES, controllable, deviceById, deviceSite } from './config.js';
import { cabinetAdmins, db, getPerm, getUser, kvSet, removeMember, resetPerms, setMember, usersBy } from './db.js';
import { DK, setDevicePower } from './devices.js';
import { render } from './messages.js';
import {
  onAccessCallback,
  onAccessText,
  openUserEditor,
  takeInvite,
  userCard,
  userLabel,
  usersList,
} from './access.js';
import { onSettingsCallback, onSettingsText, openSettings } from './settings.js';
import { addCabinet, cabinetName, displayName } from './store.js';
import { startUpdate } from './updates.js';
import { deviceCard, deviceHistory, devicesMenu, outagesReport, statusText } from './reports.js';
import { RELEASES_BUTTON, broadcastDevice, edit, mainKeyboard, seesReleases, send, tg } from './telegram.js';
import { releasesView } from './releases.js';
import { chartMenu, sendChart, toggleSummaries } from './charts.js';
import { NL, esc, now } from './util.js';

/** A person may create only this many cabinets of their own. */
const MAX_OWN_CABINETS = 1;

const roleButtons = (uid) => [
  [
    { text: '👤 Користувач', callback_data: `a:${uid}:user` },
    { text: '👑 Адмін', callback_data: `a:${uid}:admin` },
  ],
];

/* ---------- messages ---------- */

/**
 * Whether anyone may create a cabinet. Off until the operator opens it (⚙️ → 🚪 Реєстрація):
 * until then new people ask the operators for access, as before 2.0.
 */
const signupOpen = (env) => env.CFG?.settings?.signup === 'open';

const welcomeKb = {
  inline_keyboard: [
    [{ text: '🏠 Створити свій кабінет', callback_data: 'cb:new' }],
    [{ text: '🔑 Мене запросили', callback_data: 'cb:inv' }],
  ],
};

const WELCOME = [
  '👋 Привіт! Я стежу за світлом через хмару твого інвертора: коли світло зникає, вимикаю техніку, що їсть батарею, а коли повертається — вмикаю назад і пишу, що сталось.',
  '',
  '🏠 <b>Свій кабінет</b> — додаси свій дім чи дачу й запросиш родину.',
  '🔑 <b>Запрошення</b> — якщо хтось уже додав тебе: попроси в нього посилання.',
].join(NL);

async function handleStart(env, msg, user) {
  const id = msg.chat.id;
  const D = await db(env);
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ');
  const username = msg.from?.username || '';
  const arg = (msg.text || '').trim().split(' ').filter(Boolean)[1] || '';
  const operators = await usersBy(env, 'admin');
  const ensureUser = async () => {
    await D.prepare(
      "INSERT INTO users (chat_id,name,username,role,status,created) VALUES (?,?,?,'user','approved',?) ON CONFLICT(chat_id) DO UPDATE SET status='approved'"
    )
      .bind(id, name, username, now())
      .run();
  };

  // The very first start with the access key: the owner of the deployment.
  if (!operators.length && arg && arg === env.ACCESS_KEY) {
    await D.prepare(
      'INSERT INTO users (chat_id,name,username,role,status,created) VALUES (?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET role=excluded.role, status=excluded.status'
    )
      .bind(id, name, username, 'admin', 'approved', now())
      .run();
    await setMember(env, id, HOME, 'admin');
    await D.prepare('UPDATE cabinets SET owner=? WHERE id=? AND owner IS NULL').bind(id, HOME).run();
    return send(env, id, "✅ Ти адмін. Додай об'єкти в ⚙️ Налаштування, а людей запрошуй з 👥 Користувачі.", {
      reply_markup: mainKeyboard('admin', env),
    });
  }

  // An invitation link: straight into that cabinet.
  if (arg.startsWith('inv_')) {
    const cab = await takeInvite(env, arg.slice(4));
    if (!cab) return send(env, id, 'Це запрошення вже використане або застаріле. Попроси нове.');
    await ensureUser();
    const was = (await getUser(env, id)).cabs.some((c) => c.cabinet === cab);
    if (!was) {
      await setMember(env, id, cab, 'user');
      await resetPerms(env, id, cab);
    }
    await kvSet(env, `cab:${id}`, cab);
    const joined = await getUser(env, id);
    for (const a of await cabinetAdmins(env, cab)) {
      if (a.chat_id === id) continue;
      await send(
        env,
        a.chat_id,
        `🙋 ${userLabel(joined)} приєднується до «${esc(cabinetName(env, cab))}» за запрошенням.`,
        {
          reply_markup: { inline_keyboard: [[{ text: '🔐 Налаштувати доступ', callback_data: `u:o:${id}` }]] },
        }
      );
    }
    return send(env, id, `✅ Ти в кабінеті «${esc(cabinetName(env, cab))}». Тисни 📊 Статус.`, {
      reply_markup: mainKeyboard(joined.role, env),
    });
  }

  if (user?.status === 'approved') {
    if (!user.cabs.length) return send(env, id, WELCOME, { reply_markup: welcomeKb });
    return send(env, id, `Ти вже маєш доступ: ${ROLES[user.role] || ROLES.user}.`, {
      reply_markup: mainKeyboard(user.role, env),
    });
  }
  if (user?.status === 'pending') return send(env, id, 'Запит уже надіслано, чекай на схвалення.');
  if (user?.status === 'rejected' && !signupOpen(env)) return;

  if (signupOpen(env)) {
    await ensureUser();
    return send(env, id, WELCOME, { reply_markup: welcomeKb });
  }

  // Sign-up closed: a request to the operators, who add the person to their cabinet.
  await D.prepare(
    "INSERT INTO users (chat_id,name,username,role,status,created) VALUES (?,?,?,NULL,'pending',?) ON CONFLICT(chat_id) DO UPDATE SET status='pending'"
  )
    .bind(id, name, username, now())
    .run();
  const created = await getUser(env, id);
  for (const a of operators) {
    await send(env, a.chat_id, `🙋 Запит на доступ: ${userLabel(created)}`, {
      reply_markup: { inline_keyboard: [...roleButtons(id), [{ text: 'Відхилити', callback_data: `r:${id}` }]] },
    });
  }
  return send(env, id, 'Запит на доступ надіслано адміністратору.');
}

/** Creates a cabinet for a person and starts its setup. */
async function createCabinet(env, user) {
  const first = (user.name || '').split(' ')[0];
  const cab = await addCabinet(env, { name: first ? `Кабінет ${first}` : 'Мій кабінет', owner: user.chat_id });
  await kvSet(env, `cab:${user.chat_id}`, cab);
  await send(
    env,
    user.chat_id,
    [
      `✅ Кабінет «${esc(cabinetName(env, cab))}» створено, ти в ньому адмін.`,
      '',
      "Далі додай об'єкт — дім, квартиру, дачу — і його інвертор. Бот підкаже, що ввести, і перевірить вхід у хмару.",
    ].join(NL),
    { reply_markup: mainKeyboard('admin', env) }
  );
  return send(env, user.chat_id, 'Почнемо?', {
    reply_markup: { inline_keyboard: [[{ text: "➕ Додати об'єкт", callback_data: 's:sa' }]] },
  });
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
      reply_markup: {
        inline_keyboard: [
          [
            { text: '📈 Графік', callback_data: 'cg' },
            { text: '🔌 Відключення за 7 днів', callback_data: 'g:7' },
          ],
        ],
      },
    });
  }
  if (text === '/devices' || text === '🏠 Пристрої') {
    const m = await devicesMenu(env, user);
    return send(env, id, m.text, m.kb.length ? { reply_markup: { inline_keyboard: m.kb } } : {});
  }
  if (['/on', '/off', '🔥 Бойлер ON', '⛔ Бойлер OFF'].includes(text)) {
    // Buttons from v1.0.0 that may still be on someone's keyboard.
    return send(env, id, 'Керування бойлером переїхало в «🏠 Пристрої».', {
      reply_markup: mainKeyboard(user.role, env),
    });
  }
  if ((text === '/changes' || text === RELEASES_BUTTON) && seesReleases(env, user.role)) {
    const v = releasesView(0);
    return send(env, id, v.text, v.kb.length ? { reply_markup: { inline_keyboard: v.kb } } : {});
  }
  if (text === '/new' && !user.cabs.some((c) => c.role === 'admin')) return createCabinet(env, user);
  if ((text === '/users' || text === '👥 Користувачі') && user.role === 'admin') {
    const m = await usersList(env, user.cab);
    return send(env, id, m.text, m.kb.length ? { reply_markup: { inline_keyboard: m.kb } } : {});
  }
  if ((text === '/settings' || text === '⚙️ Налаштування') && user.role === 'admin') return openSettings(env, id, user);
  if (await onAccessText(env, msg, user)) return;
  if (await onSettingsText(env, msg, user)) return;

  if (!user.cabs.length) return send(env, id, WELCOME, { reply_markup: welcomeKb });
  const menu = `Меню внизу: 📊 Статус, 🏠 Пристрої${user.role === 'admin' ? ', 👥 Користувачі, ⚙️ Налаштування' : ''}.`;
  return send(env, id, menu, { reply_markup: mainKeyboard(user.role, env) });
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

/** Approve, change a role in the current cabinet, or take a person out of it. */
async function handleAdmin(env, cq, me, act, a1, a2, done) {
  if (me.role !== 'admin') return done('Немає прав');
  const tid = Number(a1);
  if (tid === me.chat_id) return done('Себе змінювати не можна');
  const target = await getUser(env, tid);
  if (!target) return done('Користувача не знайдено');
  const D = await db(env);
  const cab = me.cab;
  const member = target.cabs.find((c) => c.cabinet === cab);
  const pending = target.status === 'pending';
  if (!member && !(pending && me.op)) return done('Людина не в цьому кабінеті');

  // Access screens from older messages open today's editor.
  if (act === 'pd' || act === 'pc') {
    if (member?.role === 'admin') return done('Адмін бачить і керує всім');
    const v = await openUserEditor(env, me.chat_id, tid, cab);
    await edit(env, cq, v.text, v.kb);
    return done();
  }

  if (act === 'a' && ROLES[a2]) {
    const wasUser = member?.role === 'user';
    if (pending) await D.prepare("UPDATE users SET role='user', status='approved' WHERE chat_id=?").bind(tid).run();
    await setMember(env, tid, cab, a2);
    // A new member, or an admin demoted to member, starts from "sees the first site";
    // an existing member keeps the access the admin already set.
    if (a2 === 'user' && !wasUser) await resetPerms(env, tid, cab);
    const updated = await getUser(env, tid);
    await send(env, tid, `✅ «${esc(cabinetName(env, cab))}»: ${ROLES[a2]}.`, {
      reply_markup: mainKeyboard(updated.role, env),
    });
    if (a2 === 'user' && !wasUser) {
      const v = await openUserEditor(env, me.chat_id, tid, cab);
      await edit(env, cq, `✅ ${userLabel(target)} → ${ROLES.user}${NL}${NL}${v.text}`, v.kb);
      return done('Готово');
    }
    const card = await userCard(env, me, { ...updated, role: a2 });
    await edit(env, cq, `✅ ${ROLES[a2]}.${NL}${NL}${card.text}`, card.kb);
    return done('Готово');
  }
  if (act === 'r') {
    let result;
    if (pending) {
      await D.prepare("UPDATE users SET status='rejected', role=NULL WHERE chat_id=?").bind(tid).run();
      result = `🚫 ${userLabel(target)}: запит відхилено`;
    } else {
      await removeMember(env, tid, cab);
      const left = await getUser(env, tid);
      await send(env, tid, `Тебе прибрали з кабінету «${esc(cabinetName(env, cab))}».`, {
        reply_markup: left.cabs.length ? mainKeyboard(left.role, env) : { remove_keyboard: true },
      });
      result = `🚫 ${userLabel(target)} більше не в «${esc(cabinetName(env, cab))}»`;
    }
    await edit(env, cq, result, [[{ text: '⬅️ Користувачі', callback_data: 'u:l' }]]);
    return done('Готово');
  }
  return done('Невідома дія');
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
  if (act === 'cb') {
    if (a1 === 'inv') {
      await send(
        env,
        me.chat_id,
        'Попроси того, хто вже користується ботом, надіслати запрошення: 👥 Користувачі → ➕ Запросити людину. Відкрий посилання й натисни «Старт».'
      );
      return done();
    }
    if (a1 === 'new') {
      if (!signupOpen(env) && !me.op) return done('Реєстрацію закрито');
      if (me.cabs.filter((c) => c.role === 'admin').length >= MAX_OWN_CABINETS) return done('У тебе вже є кабінет');
      await createCabinet(env, me);
      return done();
    }
  }
  if (act === 'cg') {
    const v = await chartMenu(env, me);
    await send(env, me.chat_id, v.text, { reply_markup: { inline_keyboard: v.kb } });
    return done();
  }
  if (act === 'ch') {
    await done('Малюю графік…');
    if (!(await sendChart(env, me, a1, a2))) await send(env, me.chat_id, "Немає доступу до цього об'єкта.");
    return;
  }
  if (act === 'ns') {
    const off = await toggleSummaries(env, me.chat_id);
    return done(off ? 'Підсумки дня вимкнено. Увімкнути: 📊 Статус → 📈 Графік.' : 'Підсумки дня знову надходитимуть.');
  }
  if (act === 'rl') {
    if (!seesReleases(env, me.role)) return done('Немає доступу');
    const v = releasesView(Number(a1) || 0);
    await edit(env, cq, v.text, v.kb);
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
    if (!me.op) return done('Лише для власника бота');
    await send(env, me.chat_id, await startUpdate(env));
    return done();
  }
  return handleAdmin(env, cq, me, act, a1, a2, done);
}
