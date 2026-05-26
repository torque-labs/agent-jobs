import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { runTenantTurn } from '@/lib/agent-runtime';
import { getTenantForTelegram } from '@/lib/tenants';
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

  const tgToken = tenant.channels.telegram?.bot_token;
  try {
    const result = await withTyping(tgToken, chatId, () =>
      runTenantTurn(tenant.id, text, {
        conversationId: `telegram:${chatId}`,
        speaker: message?.from?.first_name,
        persist: true,
      }),
    );
    await sendTelegramMessage(tenant, chatId, result.reply);
  } catch (err) {
    console.error(`[telegram/${slug}] turn failed:`, err);
    await sendTelegramMessage(
      tenant,
      chatId,
      'Sorry — I hit an error. Please try again in a moment.',
    ).catch(() => {});
  }

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
async function sendTelegramMessage(tenant: Tenant, chatId: number, text: string): Promise<void> {
  const botToken = tenant.channels.telegram?.bot_token;
  if (!botToken) return;
  if (process.env.TELEGRAM_SEND_DISABLED === 'true') {
    console.log(`[telegram/${tenant.slug}] (send disabled) → chat ${chatId}: ${text.slice(0, 120)}`);
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
  if (!res.ok) {
    console.error(`[telegram/${tenant.slug}] sendMessage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Show "typing…" while the turn runs: ping sendChatAction now + every ~4s. */
async function withTyping<T>(botToken: string | undefined, chatId: number, fn: () => Promise<T>): Promise<T> {
  if (!botToken || process.env.TELEGRAM_SEND_DISABLED === 'true') return fn();
  void sendChatAction(botToken, chatId);
  const iv = setInterval(() => void sendChatAction(botToken, chatId), 4000);
  try {
    return await fn();
  } finally {
    clearInterval(iv);
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
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};
type TelegramMessage = {
  text?: string;
  chat?: { id: number };
  from?: { first_name?: string };
};
