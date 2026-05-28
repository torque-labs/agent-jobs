import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { runTenantTurn, type TurnAttachment } from '@/lib/agent-runtime';
import { getTenantForTelegram } from '@/lib/tenants';
import { gateTelegram } from '@/lib/mention';
import { claimEvent } from '@/lib/dedupe';
import { postTelegramPhoto } from '@/lib/channels';
import type { Tenant } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * Telegram webhook for a tenant's private bot.
 *
 * Path: /api/channels/telegram/<tenant-slug>
 *
 * This route is PUBLIC at the proxy layer (the path is not under /api/v1 and
 * carries no session) — authenticity is established by the per-tenant secret
 * token Telegram echoes in `X-Telegram-Bot-Api-Secret-Token` (set when the
 * webhook is registered via setWebhook). TODO at deploy time: add
 * `/api/channels/` to proxy.ts PUBLIC_PREFIXES so it isn't gated by the
 * Supabase/basic-auth layers.
 *
 * Flow:
 *   1. Resolve tenant by slug; verify the secret token.
 *   2. Enforce allowed_chats.
 *   3. runTenantTurn (scoped Torque MCP).
 *   4. Reply on-channel via the Bot API sendMessage.
 *
 * Telegram retries on non-2xx, so we always ack 200 and do the (best-effort)
 * model work + reply inline; total turn budget is well under Telegram's
 * retry window for typical questions.
 */
export async function POST(req: Request, { params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const tenant = await getTenantForTelegram(slug).catch(() => null);
  if (!tenant) {
    // Don't leak which slugs exist — generic ack.
    return NextResponse.json({ ok: true });
  }

  // C1: fail CLOSED. A Telegram-enabled tenant MUST have a webhook_secret; if
  // it is missing or the echoed token doesn't match, reject 401 and never parse
  // or act on the body. (M1) Compare in constant time, like the Slack route.
  const expectedSecret = tenant.channels.telegram?.webhook_secret;
  if (!expectedSecret) {
    console.error(`[telegram/${slug}] rejected: tenant has no webhook_secret configured`);
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const provided = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (!secretsMatch(provided, expectedSecret)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: true });
  }

  const message = update.message ?? update.edited_message;
  const chatId = message?.chat?.id;
  const text = message?.text;
  if (chatId === undefined || !text) {
    // Non-text update (sticker, join event, etc.) — ack and ignore.
    return NextResponse.json({ ok: true });
  }

  // M2: an empty allow-list must NOT mean allow-all. Require an explicit
  // non-empty allowed_chats unless the tenant opts into allow_all. Otherwise
  // refuse the turn (ack 200 so Telegram stops retrying, but do no work).
  const tg = tenant.channels.telegram;
  const allowed = tg?.allowed_chats ?? [];
  const allowAll = tg?.allow_all === true;
  if (!allowAll && allowed.length === 0) {
    console.error(`[telegram/${slug}] rejected: no allowed_chats and allow_all not set`);
    return NextResponse.json({ ok: true });
  }
  if (!allowAll && !allowed.includes(String(chatId))) {
    // Not an allowed chat — silently ignore (ack so Telegram stops retrying).
    return NextResponse.json({ ok: true });
  }

  if (update.update_id !== undefined && !(await claimEvent(`tg:${update.update_id}`))) {
    return NextResponse.json({ ok: true });
  }

  const tgToken = tenant.channels.telegram?.bot_token;
  const gate = await gateTelegram(message, tgToken ?? '', text);
  if (!gate.respond) return NextResponse.json({ ok: true });
  const turnText = gate.text;
  const speaker = message?.from?.first_name;
  // Ack now; run the turn + reply detached (slow turn must not blow the timeout).
  void (async () => {
    try {
      const result = await withTyping(tgToken, chatId, () =>
        runTenantTurn(tenant.id, turnText, {
          conversationId: `telegram:${chatId}`,
          speaker,
          persist: true,
        }),
      );
      await sendTelegramReply(tenant, chatId, result.reply, result.attachments);
    } catch (err) {
      console.error(`[telegram/${slug}] turn failed:`, err instanceof Error ? err.name : 'error');
      await sendTelegramReply(
        tenant,
        chatId,
        'Sorry — I hit an error. Please try again in a moment.',
      ).catch(() => {});
    }
  })();

  return NextResponse.json({ ok: true });
}

/**
 * Send a reply via the Telegram Bot API.
 *
 * NETWORK: hits api.telegram.org. In this foundation pass it is exercised only
 * against test bots; do not point a tenant's real bot_token at this until the
 * branch is reviewed. Stubbed-safe: if TELEGRAM_SEND_DISABLED is set we log
 * instead of calling out (used in local/dry-run testing).
 */
async function sendTelegramReply(
  tenant: Tenant,
  chatId: number,
  text: string,
  attachments?: TurnAttachment[],
): Promise<void> {
  const botToken = tenant.channels.telegram?.bot_token;
  if (!botToken) return;
  if (process.env.TELEGRAM_SEND_DISABLED === 'true') {
    console.log(
      `[telegram/${tenant.slug}] (send disabled) → chat ${chatId}` +
        (attachments?.length ? ` + ${attachments.length} chart(s)` : '') +
        `: ${text.slice(0, 120)}`,
    );
    return;
  }
  const charts = attachments ?? [];
  const chatStr = String(chatId);
  if (charts.length === 1 && text.length <= 1024) {
    await postTelegramPhoto(botToken, chatStr, charts[0].png, charts[0].name, text);
    return;
  }
  for (const a of charts) {
    await postTelegramPhoto(botToken, chatStr, a.png, a.name);
  }
  if (!text) return;
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
  if (!res.ok) {
    console.error(`[telegram/${tenant.slug}] sendMessage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/**
 * Show "typing…" while the turn runs (ping sendChatAction now + every ~4s) and
 * fire a one-shot "still working" heartbeat at HEARTBEAT_MS for the slow-tool
 * case (ingester SQL / ask_torque). Typing alone is easy to miss on mobile.
 */
const TYPING_HEARTBEAT_MS = 18_000;

async function withTyping<T>(botToken: string | undefined, chatId: number, fn: () => Promise<T>): Promise<T> {
  if (!botToken || process.env.TELEGRAM_SEND_DISABLED === 'true') return fn();
  void sendChatAction(botToken, chatId);
  const iv = setInterval(() => void sendChatAction(botToken, chatId), 4000);
  const heartbeat = setTimeout(() => {
    void sendHeartbeat(botToken, chatId);
  }, TYPING_HEARTBEAT_MS);
  try {
    return await fn();
  } finally {
    clearInterval(iv);
    clearTimeout(heartbeat);
  }
}

async function sendHeartbeat(botToken: string, chatId: number): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '🔎 still working on this — heavier queries can take a few minutes…',
      }),
    });
  } catch {
    // best-effort
  }
}

async function sendChatAction(botToken: string, chatId: number): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });
  } catch {
    // best-effort
  }
}

/**
 * Constant-time secret comparison (M1). A plain `!==` leaks length/prefix
 * timing; mirror the Slack route's timingSafeEqual approach. Returns false
 * fast when lengths differ (timingSafeEqual throws on length mismatch).
 */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Minimal Telegram update shape — only the fields we read.
type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};
type TelegramMessage = {
  text?: string;
  chat?: { id: number; type?: string };
  from?: { first_name?: string };
  reply_to_message?: { from?: { id?: number } };
};
