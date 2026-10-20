/**
 * Updates by button. A few times a day the bot checks the public project for a newer
 * version and tells admins what changed. The "⬆️ Оновити" button starts the "Оновлення"
 * workflow in the owner's own GitHub copy, which brings the new code, runs the tests and
 * lets Cloudflare deploy it. The owner's data and settings live in the database and stay.
 */

import { VERSION } from './config.js';
import { kvGet, kvSet } from './db.js';
import { broadcast } from './telegram.js';
import { NL, esc, now } from './util.js';

/** The public project every copy is made from. */
export const UPSTREAM = 'vydyshandrey/power-outage-bot';
const RAW = `https://raw.githubusercontent.com/${UPSTREAM}/main`;
const CHECK_EVERY_SEC = 6 * 3600;

/** 1 if a is newer than b, -1 if older, 0 if equal ("1.10.0" > "1.9.3"). */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

/** Changelog sections newer than the running version, trimmed for a Telegram message. */
export function changesSince(changelog, current) {
  const parts = changelog.split(/\n(?=## \[)/).filter((p) => p.startsWith('## ['));
  const newer = parts.filter((p) => compareVersions(p.slice(4, p.indexOf(']')), current) > 0);
  const text = newer
    .map((p) =>
      p
        .replace(/^## \[([^\]]+)\][^\n]*/, '<b>v$1</b>')
        .replace(/^### (.*)$/gm, '<i>$1</i>')
        .replace(/`([^`]+)`/g, '$1')
    )
    .join(NL + NL);
  return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  return res.text();
}

/** The newest published version and what changed since ours. */
export async function latestRelease() {
  const version = JSON.parse(await fetchText(`${RAW}/package.json`)).version;
  const notes =
    compareVersions(version, VERSION) > 0 ? changesSince(await fetchText(`${RAW}/CHANGELOG.md`), VERSION) : '';
  return { version, notes };
}

/** Message and button about an available update. */
export async function updateOffer() {
  const { version, notes } = await latestRelease();
  if (compareVersions(version, VERSION) <= 0)
    return { version, text: `✅ Встановлено останню версію, v${VERSION}.`, kb: [] };
  return {
    version,
    text: [
      `🆕 Вийшла v${esc(version)} (у вас v${VERSION}).`,
      '',
      notes,
      '',
      'Ваші налаштування й дані збережуться.',
    ].join(NL),
    kb: [[{ text: '⬆️ Оновити', callback_data: 'up:go' }]],
  };
}

/** Called from the periodic check: tells admins once about each new version. */
export async function checkUpdates(env) {
  if (now() - (Number(await kvGet(env, 'upd.checked')) || 0) < CHECK_EVERY_SEC) return;
  await kvSet(env, 'upd.checked', now());
  const offer = await updateOffer();
  if (!offer.kb.length || (await kvGet(env, 'upd.offered')) === offer.version) return;
  await kvSet(env, 'upd.offered', offer.version);
  await broadcast(env, offer.text, 'admin', { reply_markup: { inline_keyboard: offer.kb } });
}

/**
 * What "⬆️ Оновити" does. With a GitHub token the bot starts the workflow itself;
 * without one it gives the link where the owner presses "Run workflow".
 * @returns {Promise<string>} message for the admin
 */
export async function startUpdate(env) {
  const repo = env.CFG?.settings?.repo;
  if (!repo) {
    return 'Щоб оновлюватись кнопкою, вкажи свою копію проєкту на GitHub: ⚙️ Налаштування → 🔗 Репозиторій.';
  }
  const page = `https://github.com/${repo}/actions/workflows/update.yml`;
  if (env.GH_TOKEN) {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/update.yml/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'power-outage-bot',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (res.status === 204) {
      return `⏳ Оновлення запущено. За кілька хвилин бот перезапуститься і напише, що оновився.${NL}Хід: ${page}`;
    }
    return `Не вдалося запустити оновлення (GitHub: ${res.status}). Запусти вручну: ${page} → Run workflow.`;
  }
  return `Відкрий ${page} і натисни Run workflow → Run workflow. За кілька хвилин бот оновиться і напише про це.`;
}
