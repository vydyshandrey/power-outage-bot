# power-outage-bot — автоматичне керування технікою під час відключень світла

[![CI](https://github.com/vydyshandrey/power-outage-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/vydyshandrey/power-outage-bot/actions/workflows/ci.yml)

Світло зникло — бот вимикає бойлер, обігрівач та іншу техніку, що швидко розряджає батарею інвертора. Тоді заряду вистачає на світло, холодильник та інтернет. Світло повернулось — бот чекає 5 хвилин стабільної мережі, вмикає все назад і надсилає статус.

**Що вміє:**

- **Вимикає.** Коли світло зникає, вимикає пристрої, що «їдять» батарею.
- **Вмикає.** Коли світло стабільно повернулось, вмикає їх назад.
- **Повідомляє.** Пише в Telegram лише по ділу. Якщо знадобишся ти, скаже, що натиснути.
- **Показує статус.** Одна кнопка: чи є світло, скільки в батареї, що ввімкнено.
- **Дає керувати.** Вмикай і вимикай пристрої з телефона, де б ти не був. Історія показує, хто, коли й що вмикав.
- **Твоє слово головне.** Вимкнув щось сам — бот не ввімкне без тебе.
- **Кожному свої права.** Хтось лише бачить статус, хтось керує окремими пристроями.
- **Кілька об'єктів.** Дім, майстерня, дача — в одному боті, кожен зі своїм інвертором. Адмін вирішує, хто який об'єкт бачить.

**Без абонплати й без обладнання вдома.** Бот працює в хмарі Cloudflare на безкоштовному тарифі й спілкується з хмарами виробників так само, як їхні застосунки.

**Вже працює з:**

| Що        | Моделі                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Інвертори | Deye з доступом через DeyeCloud                                                                                              |
| Інвертори | з Wi-Fi-модулем, які працюють через SmartESS, WatchPower та інші застосунки DESS Monitor (MUST, Anenji, PowMr, Axpert тощо)¹ |
| Інвертори | із застосунком SmartValue (наприклад, MUST PV18 з модулем WFBLE.DTU.PlugPro)¹                                                |
| Пристрої  | бойлери Midea, якими керують через застосунок SmartHome                                                                      |

¹ Перевірено на тестах з імітацією хмари; перше встановлення на живому обладнанні ще попереду.

Список моделей оновлюється за потребою. Без керованих пристроїв бот працює як сповіщення про світло й статус.

---

## Як встановити

### Варіант 1. З ШІ-асистентом (найпростіше)

Відкрий Claude, ChatGPT чи іншого асистента й встав цей текст:

> Допоможи мені розгорнути проєкт https://github.com/vydyshandrey/power-outage-bot для мого дому. Спершу прочитай у ньому файл AGENTS.md і дій строго за ним. Я не програміст: пояснюй простими словами й кажи, що саме мені натиснути. Паролі й токени я вводитиму сам, а не в чат.

Асистент проведе тебе кроками й перевірить результат. Якщо він має доступ до браузера або терміналу (Claude з браузером, Claude Code, ChatGPT у режимі агента), більшість роботи зробить сам. Тобі лишиться зареєструватися в сервісах, ввести паролі й натиснути «дозволити».

### Варіант 2. Самостійно

Покрокова інструкція — у файлі [AGENTS.md](AGENTS.md). Вона однакова для людини й для ШІ. Займає близько години, більша частина якої йде на реєстрації.

---

## Як влаштовано

```
Інвертор Deye ──► хмара DeyeCloud ──┐
                                     ├──► home-bot (Cloudflare, кожні 2 хв) ──► Telegram
Бойлер Midea ◄── хмара Midea ◄──────┘                │
                                                     └──► база подій і користувачів (D1)
```

### Структура коду

| Файл                                               | Відповідає за                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/index.js`                                     | вхідна точка: маршрути HTTP, вебхук Telegram, розклад                        |
| `src/automation.js`                                | перевірка кожні 2 хв: стан мережі, вимкнення й увімкнення бойлера, ескалації |
| `src/bot.js`                                       | повідомлення й кнопки в Telegram, доступ до об'єктів і пристроїв             |
| `src/reports.js`                                   | статус, картка пристрою, історія, звіт про відключення                       |
| `src/inverter.js`                                  | джерело даних інвертора для кожного об'єкта (`INVERTER` або `SITES`)         |
| `src/deye.js`, `src/dess.js`, `src/valueclouds.js` | клієнти хмар Deye, DESS Monitor і ValueClouds (SmartValue)                   |
| `src/midea.js`                                     | клієнт хмари Midea                                                           |
| `src/db.js`                                        | сховище D1: стан, користувачі, права, журнал подій                           |
| `src/config.js`                                    | пороги й параметри в одному місці                                            |
| `test/`                                            | 46 сценаріїв на імітації хмар і Telegram, без мережі                         |

Налаштування дому зберігаються в `wrangler.toml` (тип і номер інвертора, бойлер, часовий пояс). Паролі й токени — лише в секретах Cloudflare, у коді їх немає.

### Для розробки

```
npm install
npm run check    # ESLint + Prettier + тести
npm run dev      # локальний запуск (wrangler dev)
```

Кожна зміна в `main` проходить ту саму перевірку в GitHub Actions. Історія версій — у [CHANGELOG.md](CHANGELOG.md).

**Чесні обмеження:**

- Дані в хмарах інверторів оновлюються раз на кілька хвилин, тому реакція на зміну світла — кілька хвилин.
- API DESS Monitor і ValueClouds неофіційні: запити зроблено за відкритими інтеграціями [ha-dessmonitor](https://github.com/andreas-glaser/ha-dessmonitor) і [ha-mutatrack](https://github.com/vtechs-ja/ha-mutatrack).
- Доступ до Midea неофіційний: так працюють і відкриті бібліотеки для Home Assistant. Хмара Midea інколи збоїть, бот це переживає повторами.

---

**English summary.** A free, serverless Telegram bot (Cloudflare Workers + D1) for power outages. When the grid goes down it switches off appliances that drain the inverter battery; when power has been stable for 5 minutes it switches them back on and reports the status. It shows status on a button, lets you control devices from the phone, never overrides a manual switch-off, and has per-user, per-device permissions. Works today with Deye inverters (DeyeCloud), inverters on the DESS Monitor / ShineMonitor cloud (SmartESS, WatchPower and rebranded apps: MUST, Anenji, PowMr, Axpert), inverters in the SmartValue app (ValueClouds) and Midea water heaters (SmartHome); more models are added as needed. Deploy it manually or ask an AI assistant to follow [AGENTS.md](AGENTS.md).

Автор: Андрій Видиш. Ліцензія: [MIT](LICENSE).
