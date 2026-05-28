import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { runTenantTurn, type TurnAttachment } from '@/lib/agent-runtime';
import { getTenantByTelegramChat } from '@/lib/tenants';
import { gateTelegram } from '@/lib/mention';
import { claimEvent } from '@/lib/dedupe';
import { postTelegramPhoto } from '@/lib/channels';

export const runtime = 'nodejs';

/**
 * SHARED Telegram bot webhook — one bot serves every customer.
 *
 * Path: /api/channels/telegram   (NO tenant slug — distinct from the
 * per-tenant white-label route at /api/channels/telegram/[tenant]).
 *
 * Routing: the inbound chat id selects the tenant. A customer's group/DM is
 * enrolled in exactly one tenant's `channels.telegram.allowed_chats`
 * (getTenantByTelegramChat). Unenrolled or ambiguous chats are ignored — never
 * guessed. The per-turn isolation boundary is unchanged: the resolved tenant's
 * scoped Torque token is what runTenantTurn uses.
 *
 * Auth: the GLOBAL `TELEGRAM_WEBHOOK_SECRET` echoed by Telegram in
 * `X-Telegram-Bot-Api-Secret-Token` (set when the single webhook is
 * registered). Reply uses the GLOBAL `TELEGRAM_BOT_TOKEN`. If either env is
 * unset, shared mode is off and this route fails closed (401). Set
 * `TELEGRAM_SEND_DISABLED=true` to dry-run (log instead of calling Telegram).
 */
export async function POST(req: Request) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!botToken || !expectedSecret) {
    console.error('[telegram/shared] rejected: TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET not configured');
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  // Fail closed on the shared secret, constant-time (mirrors the per-tenant route).
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

  // Idempotency: skip if we've already processed this update (Telegram
  // re-delivers on a slow ack). Claimed synchronously before any work.
  if (update.update_id !== undefined && !(await claimEvent(`tg:${update.update_id}`))) {
    return NextResponse.json({ ok: true });
  }

  const tenant = await getTenantByTelegramChat(String(chatId)).catch(() => null);
  if (!tenant) {
    // Chat not enrolled to any tenant (or ambiguous) — ack so Telegram stops
    // retrying, and do NO work. We never reply to an unenrolled chat.
    return NextResponse.json({ ok: true });
  }

  // In groups, only respond when the bot is @mentioned or replied to (DMs
  // always respond). Ack + ignore otherwise so we don't answer every message.
  const gate = await gateTelegram(message, botToken, text);
  if (!gate.respond) return NextResponse.json({ ok: true });
  const turnText = gate.text;

  // Ack NOW, run the (slow) turn + reply detached — so a slow turn can't blow
  // Telegram's webhook timeout and trigger a retry. Safe on a persistent server.
  const speaker = message?.from?.first_name;
  void (async () => {
    try {
      const result = await withTyping(botToken, chatId, () =>
        runTenantTurn(tenant.id, turnText, {
          conversationId: `telegram:${chatId}`,
          speaker,
          persist: true,
        }),
      );
      await sendTelegramReply(botToken, tenant.slug, chatId, result.reply, result.attachments);
    } catch (err) {
      console.error(
        `[telegram/shared] turn failed for tenant ${tenant.slug}: ${err instanceof Error ? err.name : 'error'}`,
      );
      await sendTelegramReply(
        botToken,
        tenant.slug,
        chatId,
        'Sorry — I hit an error. Please try again in a moment.',
      ).catch(() => {});
    }
  })();

  return NextResponse.json({ ok: true });
}

/**
 * Send a reply via the shared bot. Dry-run when TELEGRAM_SEND_DISABLED=true.
 *
 * Attachment policy: with exactly one chart AND text ≤ 1024 chars, send it as
 * a single sendPhoto with the text as caption (no two-message flash); else
 * post each chart first, then the long text via sendMessage.
 */
async function sendTelegramReply(
  botToken: string,
  slug: string,
  chatId: number,
  text: string,
  attachments?: TurnAttachment[],
): Promise<void> {
  if (process.env.TELEGRAM_SEND_DISABLED === 'true') {
    console.log(
      `[telegram/shared] (send disabled) tenant ${slug} -> chat ${chatId}` +
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
    console.error(`[telegram/shared] sendMessage ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Show "typing…" while the turn runs: ping sendChatAction now + every ~4s. */
async function withTyping<T>(botToken: string, chatId: number, fn: () => Promise<T>): Promise<T> {
  if (process.env.TELEGRAM_SEND_DISABLED === 'true') return fn();
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
    // best-effort — never let a typing ping fail the turn
  }
}

/** Constant-time secret comparison; false-fast on length mismatch. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

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
