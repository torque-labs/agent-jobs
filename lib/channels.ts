/**
 * Outbound channel delivery for tenant agents — used by scheduled routines
 * (lib/routine-runner.ts) and by interactive channel routes to post a reply to
 * a tenant's enrolled Telegram chats / Slack channels. Uses the per-tenant
 * token if set (white-label), else the shared env token. Respects
 * *_SEND_DISABLED (dry-run → logs).
 *
 * Supports optional image attachments (rendered charts) — sendPhoto on
 * Telegram, files.upload on Slack. The renderer (lib/render-chart.ts) is
 * channel-agnostic; this module is the single place that knows how to push
 * PNG bytes to each platform.
 */
import type { Tenant, TenantChannels } from './types';

export type ChannelAttachment = {
  /** Suggested filename / Slack title. */
  name: string;
  /** PNG bytes. */
  png: Buffer;
};

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

/**
 * Telegram `sendPhoto`: multipart/form-data with `chat_id`, `photo` (PNG bytes
 * as a Blob), optional `caption` (≤ 1024 chars, Markdown). Caller decides
 * whether to bundle text into the caption or post separately.
 *
 * Exported so the live webhook routes (which reply to a single chat) can reuse
 * the primitive — `deliverToTenant` is for the cron/routine fan-out path.
 */
export async function postTelegramPhoto(
  token: string,
  chatId: string,
  png: Buffer,
  filename: string,
  caption?: string,
): Promise<boolean> {
  try {
    const form = new FormData();
    form.set('chat_id', chatId);
    if (caption) {
      form.set('caption', truncate(caption, 1024));
      form.set('parse_mode', 'Markdown');
    }
    form.set('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), filename);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    if (!res.ok) console.error(`[channels] telegram sendPhoto ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.ok;
  } catch (err) {
    console.error('[channels] telegram sendPhoto error:', err instanceof Error ? err.name : 'error');
    return false;
  }
}

async function postSlack(token: string, channel: string, text: string): Promise<boolean> {
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, text: truncate(markdownToSlackMrkdwn(text), 39000) }),
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
 * Convert standard CommonMark to Slack mrkdwn. The agent writes `**bold**`
 * per CommonMark; Slack mrkdwn uses `*bold*`. Conversion is non-greedy and
 * single-line to avoid eating across paragraphs / code fences. We don't
 * convert italic (`*x*` → `_x_`) because the agent rarely uses single-`*`
 * italic and the conversion would clash with the bold output.
 */
export function markdownToSlackMrkdwn(text: string): string {
  return text.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');
}

/**
 * Slack file upload via the v2 three-step flow:
 *   1. files.getUploadURLExternal → upload_url + file_id
 *   2. POST the bytes to upload_url
 *   3. files.completeUploadExternal → share to channel (+initial_comment, +thread_ts)
 *
 * Slack hard-deprecated the legacy single-request files.upload endpoint in
 * late 2025 — calls silently fail (ok:false with method_deprecated) even
 * though the HTTP status is 200. v2 is mandatory.
 *
 * Exported for the live webhook routes (same reason as postTelegramPhoto).
 */
export async function postSlackFile(
  token: string,
  channel: string,
  png: Buffer,
  filename: string,
  initialComment?: string,
  threadTs?: string,
): Promise<boolean> {
  try {
    const step1Body = new URLSearchParams({
      filename,
      length: String(png.byteLength),
    });
    const step1 = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: step1Body,
    });
    const step1Data = (await step1.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      upload_url?: string;
      file_id?: string;
    };
    if (!step1Data.ok || !step1Data.upload_url || !step1Data.file_id) {
      console.error(`[channels] slack files.getUploadURLExternal failed: ${step1Data.error ?? step1.status}`);
      return false;
    }

    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), filename);
    const step2 = await fetch(step1Data.upload_url, { method: 'POST', body: form });
    if (!step2.ok) {
      console.error(`[channels] slack upload-url POST failed: ${step2.status}`);
      return false;
    }

    const step3Body: Record<string, unknown> = {
      files: [{ id: step1Data.file_id, title: filename }],
      channel_id: channel,
    };
    if (initialComment) {
      step3Body.initial_comment = truncate(markdownToSlackMrkdwn(initialComment), 39000);
    }
    if (threadTs) step3Body.thread_ts = threadTs;
    const step3 = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(step3Body),
    });
    const step3Data = (await step3.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!step3Data.ok) {
      console.error(`[channels] slack files.completeUploadExternal failed: ${step3Data.error ?? step3.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[channels] slack upload error:', err instanceof Error ? err.name : 'error');
    return false;
  }
}

/**
 * Post `text` (+ optional `attachments`) to all of a tenant's enrolled
 * chats/channels on `platform`. Attachments are sent first. With exactly one
 * attachment AND text that fits a Telegram caption (≤1024 chars), we bundle
 * them into one sendPhoto (avoids the two-message flash); otherwise we post
 * each attachment, then the text. Returns how many destinations were
 * delivered to (0 in dry-run).
 */
export async function deliverToTenant(
  tenant: Tenant,
  platform: 'telegram' | 'slack',
  text: string,
  attachments: ChannelAttachment[] = [],
): Promise<{ targets: number; delivered: number }> {
  const ch: TenantChannels = tenant.channels ?? {};
  if (platform === 'telegram') {
    const token = ch.telegram?.bot_token ?? process.env.TELEGRAM_BOT_TOKEN;
    const chats = ch.telegram?.allowed_chats ?? [];
    if (!token || chats.length === 0) return { targets: chats.length, delivered: 0 };
    if (process.env.TELEGRAM_SEND_DISABLED === 'true') {
      console.log(
        `[channels] (telegram send disabled) ${tenant.slug} → ${chats.length} chat(s)` +
          (attachments.length > 0 ? ` + ${attachments.length} chart(s)` : ''),
      );
      return { targets: chats.length, delivered: 0 };
    }
    let delivered = 0;
    const oneShot = attachments.length === 1 && text.length <= 1024;
    for (const chatId of chats) {
      let ok = true;
      if (oneShot) {
        ok = await postTelegramPhoto(token, chatId, attachments[0].png, attachments[0].name, text);
      } else {
        for (const a of attachments) {
          if (!(await postTelegramPhoto(token, chatId, a.png, a.name))) ok = false;
        }
        if (text) {
          if (!(await postTelegram(token, chatId, text))) ok = false;
        }
      }
      if (ok) delivered++;
    }
    return { targets: chats.length, delivered };
  }
  const token = ch.slack?.bot_token ?? process.env.SLACK_BOT_TOKEN;
  const channels = ch.slack?.allowed_channels ?? [];
  if (!token || channels.length === 0) return { targets: channels.length, delivered: 0 };
  if (process.env.SLACK_SEND_DISABLED === 'true') {
    console.log(
      `[channels] (slack send disabled) ${tenant.slug} → ${channels.length} channel(s)` +
        (attachments.length > 0 ? ` + ${attachments.length} chart(s)` : ''),
    );
    return { targets: channels.length, delivered: 0 };
  }
  let delivered = 0;
  const oneShot = attachments.length === 1 && Boolean(text);
  for (const c of channels) {
    let ok = true;
    if (oneShot) {
      ok = await postSlackFile(token, c, attachments[0].png, attachments[0].name, text);
    } else {
      for (const a of attachments) {
        if (!(await postSlackFile(token, c, a.png, a.name))) ok = false;
      }
      if (text) {
        if (!(await postSlack(token, c, text))) ok = false;
      }
    }
    if (ok) delivered++;
  }
  return { targets: channels.length, delivered };
}
