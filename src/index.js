/**
 * home-bot — Cloudflare Worker entry point.
 *
 * Routes:
 *   POST /tg                       Telegram webhook (verified by secret header)
 *   POST /notify?k=NOTIFY_KEY      service message to admins, e.g. from an assistant or a script
 *   GET  /tick?t=TICK_KEY          run the check (for an external scheduler)
 *   GET  /setup?key=ACCESS_KEY     register the webhook and bot commands
 *   GET  /discover?key=ACCESS_KEY  diagnostics: what the configured accounts see
 *   GET  /tick?key=ACCESS_KEY      run the check manually and show the state
 * The cron trigger (wrangler.toml) runs the same check as /tick.
 */

import { VERSION } from './config.js';
import { reportError, tick } from './automation.js';
import { onCallback, onMessage } from './bot.js';
import { kvGet } from './db.js';
import { discover } from './discover.js';
import { broadcast, tg } from './telegram.js';
import { loadConfig } from './store.js';
import { NL, esc, hash } from './util.js';

const forbidden = () => new Response('forbidden', { status: 403 });

/** Webhook secret derived from ACCESS_KEY, so there is one secret less to manage. */
const webhookSecret = async (env) => (await hash('SHA-256', `tg:${env.ACCESS_KEY}`)).slice(0, 48);

async function handleWebhook(req, env, ctx) {
  if (req.headers.get('x-telegram-bot-api-secret-token') !== (await webhookSecret(env))) return forbidden();
  const update = await req.json();
  // Answer Telegram immediately; process in the background.
  ctx.waitUntil(
    (async () => {
      try {
        if (update.message) await onMessage(env, update.message);
        else if (update.callback_query) await onCallback(env, update.callback_query);
      } catch (e) {
        await reportError(env, 'Bot', e);
      }
    })()
  );
  return new Response('ok');
}

async function handleNotify(req, env, url) {
  if (!env.NOTIFY_KEY || url.searchParams.get('k') !== env.NOTIFY_KEY) return forbidden();
  const { text } = await req.json().catch(() => ({}));
  if (!text) return new Response('no text', { status: 400 });
  const from = esc(env.NOTIFY_NAME || 'Сервіс');
  await broadcast(env, `🤖 <b>${from}</b>${NL}${esc(String(text).slice(0, 3500))}`, 'admin');
  return Response.json({ ok: true });
}

async function handleSetup(env, url) {
  const webhook = await tg(env, 'setWebhook', {
    url: `${url.origin}/tg`,
    secret_token: await webhookSecret(env),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  const commands = await tg(env, 'setMyCommands', {
    commands: [
      { command: 'status', description: 'Світло, батарея, пристрої' },
      { command: 'devices', description: 'Пристрої і керування' },
      { command: 'users', description: 'Користувачі (адмін)' },
      { command: 'settings', description: 'Налаштування (адмін)' },
    ],
  });
  const me = await tg(env, 'getMe', {});
  return Response.json({ version: VERSION, webhook, commands: commands.ok, bot: me.result?.username });
}

/** Per-invocation environment: secrets, the configuration from the database, request diagnostics. */
async function prepare(env, colo = '') {
  const e = { ...env, COLO: colo };
  await loadConfig(e);
  return e;
}

export default {
  /** @param {Request} req @param {import('./config.js').Env} rawEnv @param {ExecutionContext} ctx */
  async fetch(req, rawEnv, ctx) {
    const env = await prepare(rawEnv, req.cf?.colo);
    const url = new URL(req.url);

    if (url.pathname === '/tg' && req.method === 'POST') return handleWebhook(req, env, ctx);
    if (url.pathname === '/notify' && req.method === 'POST') return handleNotify(req, env, url);
    if (url.pathname === '/tick' && env.TICK_KEY && url.searchParams.get('t') === env.TICK_KEY) {
      await tick(env);
      return Response.json({ ok: true });
    }

    if (url.searchParams.get('key') !== env.ACCESS_KEY) return forbidden();

    if (url.pathname === '/setup') return handleSetup(env, url);
    if (url.pathname === '/discover') {
      return Response.json(await discover(env), { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/tick') {
      await tick(env);
      return Response.json({
        ok: true,
        version: VERSION,
        grid: await kvGet(env, 'grid'),
        auto_off: await kvGet(env, 'boiler_auto_off'),
      });
    }
    return Response.json({ version: VERSION, endpoints: ['/setup', '/tick', '/discover'] });
  },

  /** @param {ScheduledController} _event @param {import('./config.js').Env} rawEnv @param {ExecutionContext} ctx */
  async scheduled(_event, rawEnv, ctx) {
    ctx.waitUntil(prepare(rawEnv).then(tick));
  },
};
