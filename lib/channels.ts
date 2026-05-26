/**
 * Outbound channel delivery for tenant agents — used by scheduled routines
 * (lib/routine-runner.ts) to post a reply to a tenant's enrolled Telegram
 * chats / Slack channels. Uses the per-tenant token if set (white-label),
 * else the shared env token. Respects *_SEND_DISABLED (dry-run → logs).
 */
import type { Tenant, TenantChannels } from './types';

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

async function postTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: truncate(text, 4096), parse_mode: 'Markdown' }),
    });
    if (!res.ok) console.error(`[channels] telegram sendMessage ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.ok;
  } catch (err) {
    console.error('[channels] telegram send error:', err instanceof Error ? err.name : 'error');
    return false;
  }
}

async function postSlack(token: string, channel: string, text: string): Promise<boolean> {
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, text: truncate(text, 39000) }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!data.ok) console.error(`[channels] slack postMessage failed: ${data.error ?? res.status}`);
    return Boolean(data.ok);
  } catch (err) {
    console.error('[channels] slack send error:', err instanceof Error ? err.name : 'error');
    return false;
  }
}

/**
 * Post `text` to all of a tenant's enrolled chats/channels on `platform`.
 * Returns how many destinations were delivered to (0 in dry-run).
 */
export async function deliverToTenant(
  tenant: Tenant,
  platform: 'telegram' | 'slack',
  text: string,
): Promise<{ targets: number; delivered: number }> {
  const ch: TenantChannels = tenant.channels ?? {};
  if (platform === 'telegram') {
    const token = ch.telegram?.bot_token ?? process.env.TELEGRAM_BOT_TOKEN;
    const chats = ch.telegram?.allowed_chats ?? [];
    if (!token || chats.length === 0) return { targets: chats.length, delivered: 0 };
    if (process.env.TELEGRAM_SEND_DISABLED === 'true') {
      console.log(`[channels] (telegram send disabled) ${tenant.slug} → ${chats.length} chat(s): ${text.slice(0, 80)}`);
      return { targets: chats.length, delivered: 0 };
    }
    let delivered = 0;
    for (const chatId of chats) if (await postTelegram(token, chatId, text)) delivered++;
    return { targets: chats.length, delivered };
  }
  const token = ch.slack?.bot_token ?? process.env.SLACK_BOT_TOKEN;
  const channels = ch.slack?.allowed_channels ?? [];
  if (!token || channels.length === 0) return { targets: channels.length, delivered: 0 };
  if (process.env.SLACK_SEND_DISABLED === 'true') {
    console.log(`[channels] (slack send disabled) ${tenant.slug} → ${channels.length} channel(s): ${text.slice(0, 80)}`);
    return { targets: channels.length, delivered: 0 };
  }
  let delivered = 0;
  for (const c of channels) if (await postSlack(token, c, text)) delivered++;
  return { targets: channels.length, delivered };
}
