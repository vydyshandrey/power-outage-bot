/**
 * Texts of the notifications the bot sends by itself. Each has a standard text here;
 * the owner can replace it in the bot (⚙️ Налаштування → ✉️ Повідомлення).
 *
 * In a text, {name} is replaced with a value. A line whose variable has no value this
 * time (for example, how long the light was on, right after installation) is left out.
 * Texts use Telegram HTML: <b>bold</b>, <i>italic</i>, <code>code</code>.
 */

import { NL, esc } from './util.js';

/** Variables and what they mean, for the editor. */
export const VARS = {
  where: "назва об'єкта з крапкою («Майстерня · »); порожньо, якщо об'єкт один",
  object: "назва об'єкта",
  time: 'час події, 14:05',
  duration: 'тривалість, «2 год 15 хв»',
  load: 'споживання, Вт',
  soc: 'заряд батареї, %',
  volt: 'напруга мережі, В',
  device: 'назва пристрою',
  who: 'хто натиснув',
  delay: 'наскільки автоматика запізнилась; порожньо, якщо вчасно',
  source: "хмара інвертора, з назвою об'єкта, якщо їх кілька",
  error: 'текст помилки',
};

/**
 * @type {Record<string, {title: string, text: string, vars: string[], sample: Record<string, string>}>}
 */
export const TEMPLATES = {
  grid_off: {
    title: '🔌 Світло зникло',
    text: `🔌 {where}Світло зникло о {time}.${NL}Світло було {duration}.${NL}🔋 Від інвертора: споживання {load} Вт, батарея {soc}%.`,
    vars: ['where', 'object', 'time', 'duration', 'load', 'soc'],
    sample: { where: '', object: 'Дім', time: '14:05', duration: '6 год 20 хв', load: '410', soc: '90' },
  },
  grid_on: {
    title: "💡 Світло з'явилось",
    text: `💡 {where}Світло з'явилось о {time}, {volt} В.${NL}Світла не було {duration}.`,
    vars: ['where', 'object', 'time', 'duration', 'volt'],
    sample: { where: '', object: 'Дім', time: '16:40', duration: '2 год 35 хв', volt: '231' },
  },
  device_auto_off: {
    title: '⛔ Пристрій вимкнено автоматикою',
    text: `⛔ {device} вимкнено автоматично.${NL}⏱ Через {delay} після зникнення світла.`,
    vars: ['device', 'object', 'delay'],
    sample: { device: 'Бойлер', object: 'Дім', delay: '' },
  },
  device_auto_on: {
    title: '🔥 Пристрій увімкнено автоматикою',
    text: `🔥 {device} увімкнено автоматично.${NL}⏱ Із запізненням {delay}.`,
    vars: ['device', 'object', 'delay'],
    sample: { device: 'Бойлер', object: 'Дім', delay: '' },
  },
  device_off_failed: {
    title: '⚠️ Не вдалося вимкнути',
    text: '⚠️ {device}: не вдалося вимкнути за 10 хв, хмара виробника не відповідає. Вимкни вручну. Бот пробуватиме далі.',
    vars: ['device', 'object'],
    sample: { device: 'Бойлер', object: 'Дім' },
  },
  device_on_failed: {
    title: '⚠️ Не вдалося увімкнути',
    text: '⚠️ {device}: не вдалося увімкнути за 10 хв після повернення світла, хмара виробника не відповідає. Увімкни вручну. Бот пробуватиме далі.',
    vars: ['device', 'object'],
    sample: { device: 'Бойлер', object: 'Дім' },
  },
  manual_on: {
    title: '🔥 Хтось увімкнув',
    text: '🔥 {device} увімкнено: {who}.',
    vars: ['device', 'object', 'who'],
    sample: { device: 'Бойлер', object: 'Дім', who: 'Мама' },
  },
  manual_off: {
    title: '⛔ Хтось вимкнув',
    text: '⛔ {device} вимкнено: {who}.',
    vars: ['device', 'object', 'who'],
    sample: { device: 'Бойлер', object: 'Дім', who: 'Мама' },
  },
  inverter_down: {
    title: '⚠️ Інвертор не відповідає (адмінам)',
    text: `⚠️ {source} не відповідає {duration}. Автоматика на паузі, доки зв'язок не повернеться.${NL}<code>{error}</code>`,
    vars: ['source', 'object', 'duration', 'error'],
    sample: { source: 'Deye', object: 'Дім', duration: '10 хв', error: 'HTTP 500' },
  },
  inverter_up: {
    title: '✅ Інвертор знову відповідає (адмінам)',
    text: "✅ {source} знову відповідає (не було зв'язку {duration}).",
    vars: ['source', 'object', 'duration'],
    sample: { source: 'Deye', object: 'Дім', duration: '25 хв' },
  },
  stale: {
    title: '⚠️ Дані не оновлюються (адмінам)',
    text: '⚠️ Дані {source} не оновлювались {duration}. Автоматика на паузі, доки логер не повернеться.',
    vars: ['source', 'object', 'duration'],
    sample: { source: 'Deye', object: 'Дім', duration: '15 хв' },
  },
  fresh: {
    title: '✅ Дані знову оновлюються (адмінам)',
    text: '✅ Дані {source} знову оновлюються.',
    vars: ['source', 'object'],
    sample: { source: 'Deye', object: 'Дім' },
  },
};

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/** The text in use: the owner's version or the standard one. */
export const templateText = (env, key) => env.CFG?.templates?.[key] ?? TEMPLATES[key].text;

/**
 * Fills a text with values. Values are escaped for HTML; a line with a variable that has
 * no value is dropped; an unknown {name} stays as typed.
 */
export function fill(text, vars) {
  const empty = (k) => k in vars && (vars[k] === null || vars[k] === undefined || vars[k] === '');
  return text
    .split(NL)
    .filter((line) => ![...line.matchAll(PLACEHOLDER)].some((m) => empty(m[1]) && m[1] !== 'where'))
    .map((line) => line.replace(PLACEHOLDER, (m, k) => (k in vars ? esc(vars[k] ?? '') : m)))
    .join(NL);
}

/** @param {string} key key of TEMPLATES */
export const render = (env, key, vars) => fill(templateText(env, key), vars);

/** Variables in a text that this message does not have. */
export function unknownVars(key, text) {
  const allowed = new Set(TEMPLATES[key].vars);
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))].filter((k) => !allowed.has(k));
}
