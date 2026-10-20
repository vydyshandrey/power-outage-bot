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
- **Усе налаштовується в Telegram.** Об'єкти, пристрої, назви, тексти повідомлень. Нові версії — кнопкою.

**Без абонплати й без обладнання вдома.** Бот працює в хмарі Cloudflare на безкоштовному тарифі й спілкується з хмарами виробників так само, як їхні застосунки.

**Вже працює з:**

| Що        | Моделі                                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Інвертори | Deye з доступом через DeyeCloud                                                                                              |
| Інвертори | з Wi-Fi-модулем, які працюють через SmartESS, WatchPower та інші застосунки DESS Monitor (MUST, Anenji, PowMr, Axpert тощо)¹ |
| Інвертори | із застосунком SmartValue (наприклад, MUST PV18 з модулем WFBLE.DTU.PlugPro)                                                 |
| Пристрої  | бойлери Midea, якими керують через застосунок SmartHome                                                                      |

¹ Перевірено на тестах з імітацією хмари; перше встановлення на живому обладнанні ще попереду. SmartValue працює на живому інверторі MUST PV18.

Список моделей оновлюється за потребою. Без керованих пристроїв бот працює як сповіщення про світло й статус.

---

**Інструкції:** [як користуватися](docs/user-guide.md) · [як встановити покроково](docs/install-guide.md).

---

## Як встановити

Близько 20 хвилин, без програмування. Покроково: [docs/install-guide.md](docs/install-guide.md).

1. Створи бота в Telegram (@BotFather).
2. Натисни кнопку — Cloudflare скопіює проєкт і створить базу, спитає токен бота й ключ адміна:

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/vydyshandrey/power-outage-bot)

3. Напиши боту `/start <ключ>` і налаштуй усе в **⚙️ Налаштування**: об'єкти, інвертори, бойлери, назви, тексти повідомлень. Бот сам підкаже, які паролі від хмар додати в Cloudflare.

Нові версії приходять у бот повідомленням з кнопкою **⬆️ Оновити**; налаштування й дані зберігаються.

**З ШІ-асистентом.** Відкрий Claude, ChatGPT чи іншого асистента й встав цей текст:

> Допоможи мені розгорнути проєкт https://github.com/vydyshandrey/power-outage-bot для мого дому. Спершу прочитай у ньому файл AGENTS.md і дій строго за ним. Я не програміст: пояснюй простими словами й кажи, що саме мені натиснути. Паролі й токени я вводитиму сам, а не в чат.

---

## Як влаштовано

```
Інвертори (Deye, SmartESS, SmartValue) ──► їхні хмари ──┐
                                                        ├──► бот (Cloudflare, кожні 2 хв) ──► Telegram
Пристрої (бойлери Midea) ◄── хмара Midea ◄──────────────┘          │
                                                                   └──► база D1: налаштування, люди, історія
```

### Структура коду

| Файл                                               | Відповідає за                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/index.js`                                     | вхідна точка: маршрути HTTP, вебхук Telegram, розклад                          |
| `src/automation.js`                                | перевірка кожні 2 хв: стан мережі, вимкнення й увімкнення пристроїв, ескалації |
| `src/bot.js`                                       | повідомлення й кнопки в Telegram, доступ до об'єктів і пристроїв               |
| `src/settings.js`                                  | ⚙️ Налаштування в боті: об'єкти, пристрої, тексти, імена, оновлення            |
| `src/messages.js`                                  | тексти сповіщень зі змінними; стандартні й змінені власником                   |
| `src/store.js`                                     | налаштування в базі: читання й зміна                                           |
| `src/reports.js`                                   | статус, картка пристрою, історія, звіт про відключення                         |
| `src/inverter.js`                                  | хмари інверторів, акаунти й секрети до них                                     |
| `src/deye.js`, `src/dess.js`, `src/valueclouds.js` | клієнти хмар Deye, DESS Monitor і ValueClouds (SmartValue)                     |
| `src/devices.js`, `src/midea.js`                   | драйвери пристроїв і клієнт хмари Midea                                        |
| `src/updates.js`, `scripts/apply-update.mjs`       | перевірка нових версій і оновлення копії кнопкою                               |
| `src/db.js`                                        | сховище D1, права, журнал, міграції                                            |
| `src/config.js`                                    | пороги й параметри в одному місці                                              |
| `test/`                                            | 67 сценаріїв на імітації хмар, GitHub і Telegram, без мережі                   |

Налаштування дому зберігаються в базі й змінюються в боті. Паролі й токени — лише в секретах Cloudflare, у коді їх немає. У `wrangler.toml` — тільки технічне: назва воркера, база, розклад.

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

**English summary.** A free, serverless Telegram bot (Cloudflare Workers + D1) for power outages. When the grid goes down it switches off appliances that drain the inverter battery; when power has been stable for 5 minutes it switches them back on and reports the status. It shows status on a button, lets you control devices from the phone, never overrides a manual switch-off, has per-site and per-device permissions, and is set up entirely in Telegram, including message texts; updates come as a button. Works today with Deye inverters (DeyeCloud), inverters on the DESS Monitor / ShineMonitor cloud (SmartESS, WatchPower and rebranded apps: MUST, Anenji, PowMr, Axpert), inverters in the SmartValue app (ValueClouds) and Midea water heaters (SmartHome); more models are added as needed. Deploy with the Deploy to Cloudflare button or ask an AI assistant to follow [AGENTS.md](AGENTS.md).

Автор: Андрій Видиш. Ліцензія: [MIT](LICENSE).
