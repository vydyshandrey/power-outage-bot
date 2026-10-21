/**
 * "🚀 Що нового": the release history as people see it in the bot. Short, user-facing lines;
 * the full technical list is CHANGELOG.md. A test checks that every version in the
 * changelog is here, so the two never drift apart.
 *
 * Callback data: rl:<page>. Shown to admins always, to everyone when the admin turns it on
 * (⚙️ Налаштування → 🚀 Що нового).
 */

import { VERSION } from './config.js';
import { NL, esc } from './util.js';

export const RELEASES = [
  {
    v: '1.10.2',
    date: '2026-10-21',
    lines: ['⏳ Оцінка батареї — із середнього розряду без світла, з діапазоном «~6–9 год»; з АВР не плутається'],
  },
  {
    v: '1.10.1',
    date: '2026-10-21',
    lines: [
      '⏳ Без світла статус показує, на скільки приблизно вистачить батареї',
      '🔋 Ємність батареї об’єкта — у ⚙️ → 🏠 Об’єкти; без неї бот рахує за швидкістю розряду',
    ],
  },
  {
    v: '1.10.0',
    date: '2026-10-20',
    lines: [
      '📊 Підсумки дня з графіком щоранку',
      '📈 Графік за сьогодні й 7 днів зі статусу',
      '🪫 Попередження «сідає батарея»',
    ],
  },
  { v: '1.9.0', date: '2026-10-20', lines: ['🚀 Ця кнопка: історія версій бота'] },
  {
    v: '1.8.0',
    date: '2026-10-20',
    lines: [
      '👥 Компактний список людей і картка кожного',
      '🔐 Доступ чернеткою: «Зберегти» або «Скасувати»',
      "🔍 Доступ з картки об'єкта й пристрою, з пошуком",
    ],
  },
  { v: '1.7.1', date: '2026-10-20', lines: ['⚡ Інвертори в «🏠 Пристрої»: мережа, батарея, споживання'] },
  {
    v: '1.7.0',
    date: '2026-10-20',
    lines: ["⚡ Інвертор тепер пристрій об'єкта, як бойлер", "🔀 Кілька інверторів на об'єкті, вибір головного"],
  },
  { v: '1.6.1', date: '2026-10-20', lines: ['🔤 Імена справа наліво більше не ламають рядки'] },
  {
    v: '1.6.0',
    date: '2026-10-20',
    lines: [
      '⚙️ Усе, крім паролів, налаштовується в Telegram',
      '✉️ Свої тексти сповіщень зі змінними',
      '⬆️ Оновлення однією кнопкою',
    ],
  },
  { v: '1.5.0', date: '2026-10-20', lines: ["🔐 Права ієрархією: об'єкт → його пристрої"] },
  { v: '1.4.1', date: '2026-10-20', lines: ["🧭 Бойлер у статусі під своїм об'єктом"] },
  { v: '1.4.0', date: '2026-10-20', lines: ["🏘 Кілька об'єктів в одному боті: дім, майстерня, дача"] },
  { v: '1.3.0', date: '2026-10-20', lines: ['🔋 Інвертори в застосунку SmartValue (MUST PV18)'] },
  { v: '1.2.0', date: '2026-10-20', lines: ['🔋 Інвертори в SmartESS і WatchPower (DESS Monitor)'] },
  { v: '1.1.5', date: '2026-10-19', lines: ['🧪 Модульний код і автоматичні тести'] },
  { v: '1.1.4', date: '2026-10-19', lines: ['📦 Версія для поширення й інструкція встановлення'] },
  {
    v: '1.1.3',
    date: '2026-10-19',
    lines: ['🤫 Разові збої хмари більше не турбують', '🚚 Розгортання з GitHub автоматично'],
  },
  { v: '1.1.2', date: '2026-10-16', lines: ['🔁 Тихі повтори, якщо хмара бойлера не відповідає'] },
  { v: '1.1.1', date: '2026-10-16', lines: ['🛡 Надійніший зв’язок із хмарою Midea'] },
  {
    v: '1.1.0',
    date: '2026-10-16',
    lines: ['🏠 Меню пристроїв з історією', '⏱ Скільки світла не було, звіт за 7 днів'],
  },
  { v: '1.0.0', date: '2026-10-16', lines: ['🎉 Перший запуск: бойлер сам вимикається без світла'] },
];

const PAGE = 5;
const day = (iso) => iso.split('-').reverse().join('.');

/** 1 реліз · 2 релізи · 5 релізів */
const plural = (n, one, few, many) => {
  const t = n % 10;
  const h = n % 100;
  if (t === 1 && h !== 11) return one;
  if (t >= 2 && t <= 4 && (h < 12 || h > 14)) return few;
  return many;
};

/** "18 релізів за 5 днів, з 16.10.2026" */
function releasesSpan() {
  const first = RELEASES[RELEASES.length - 1];
  const days = Math.round((Date.parse(RELEASES[0].date) - Date.parse(first.date)) / 864e5) + 1;
  const n = RELEASES.length;
  return `${n} ${plural(n, 'реліз', 'релізи', 'релізів')} за ${days} ${plural(days, 'день', 'дні', 'днів')}, з ${day(first.date)}`;
}

/** @param {number} page 0 is the newest */
export function releasesView(page = 0) {
  const pages = Math.ceil(RELEASES.length / PAGE);
  const p = Math.max(0, Math.min(page, pages - 1));
  const lines = ['🚀 <b>Що нового</b>', `Зараз <b>v${esc(VERSION)}</b> · ${releasesSpan()}`];
  for (const r of RELEASES.slice(p * PAGE, p * PAGE + PAGE)) {
    lines.push('', `<b>v${r.v}</b>${r.v === VERSION ? ' ✨' : ''} · ${day(r.date)}`, ...r.lines);
  }
  const nav = [];
  if (p < pages - 1) nav.push({ text: '◀️ Раніше', callback_data: `rl:${p + 1}` });
  if (p > 0) nav.push({ text: 'Новіше ▶️', callback_data: `rl:${p - 1}` });
  return { text: lines.join(NL), kb: nav.length ? [nav] : [] };
}
