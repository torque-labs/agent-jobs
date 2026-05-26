import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { runTenantTurn } from '@/lib/agent-runtime';
import { getTenantBySlackChannel } from '@/lib/tenants';
import { gateSlack } from '@/lib/mention';
import type { Tenant } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * SHARED Slack Events API webhook — one distributed app serves every customer.
 *
 * Path: /api/channels/slack   (NO tenant slug — distinct from the per-tenant
 * white-label route at /api/channels/slack/[tenant]).
 *
 * Slack specifics that shape this:
 *  - The SIGNING SECRET is app-level: one global `SLACK_SIGNING_SECRET` verifies
 *    events from EVERY workspace the app is installed in (and the one-time
 *    url_verification handshake). Required — fail closed (401) without it.
 *  - The BOT TOKEN is per-workspace-install. So we reply with the resolved
 *    tenant's own `channels.slack.bot_token` (the token from THAT workspace's
 *    install), falling back to a global `SLACK_BOT_TOKEN` for the
 *    single-workspace / many-channels case.
 *
 * Routing: the inbound channel id (globally unique) selects the tenant via
 * getTenantBySlackChannel (enrolled in exactly one tenant's allowed_channels).
 * Unenrolled / ambiguous → ignored. Per-turn isolation boundary unchanged.
 */
export async function POST(req: Request) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.error('[slack/shared] rejected: SLACK_SIGNING_SECRET not configured');
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const rawBody = await req.text();
  const timestamp = req.headers.get('x-slack-request-timestamp') ?? '';
  const signature = req.headers.get('x-slack-signature') ?? '';
  if (!verifySlackSignature(signingSecret, timestamp, rawBody, signature)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let payload: SlackEventPayload;
  try {
    payload = JSON.parse(rawBody) as SlackEventPayload;
  } catch {
    return NextResponse.json({ ok: true });
  }

  // One-time URL verification handshake (only after a valid signature).
  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge });
  }

  const event = payload.event;
  if (
    !event ||
    event.type !== 'message' ||
    event.bot_id ||
    event.subtype ||
    !event.text ||
    !event.channel
  ) {
    return NextResponse.json({ ok: true });
  }

  const tenant = await getTenantBySlackChannel(event.channel).catch(() => null);
  if (!tenant) {
    // Channel not enrolled to any tenant (or ambiguous) — ack, do no work.
    return NextResponse.json({ ok: true });
  }

  // In channels, only respond when the bot is @mentioned (IMs always respond).
  const slackToken = tenant.channels.slack?.bot_token ?? process.env.SLACK_BOT_TOKEN;
  const gate = await gateSlack(event, slackToken ?? '');
  if (!gate.respond) return NextResponse.json({ ok: true });
  event.text = gate.text;

  // Ack within 3s; run the model work + reply detached. (Same M3 dedupe TODO as
  // the per-tenant route: no event_id dedupe / durable enqueue yet.)
  void handleSlackTurn(tenant, event).catch((err) => {
    console.error(`[slack/shared] detached turn failed for tenant ${tenant.slug}:`, err instanceof Error ? err.name : 'error');
  });

  return NextResponse.json({ ok: true });
}

async function handleSlackTurn(tenant: Tenant, event: SlackMessageEvent): Promise<void> {
  try {
    const result = await runTenantTurn(tenant.id, event.text!, {
      // Memory key: channel (+ thread when threaded) so it's stable across
      // messages. The reply still posts in-thread via thread_ts/ts below.
      conversationId: `slack:${event.channel}${event.thread_ts ? ':' + event.thread_ts : ''}`,
      speaker: event.user,
      persist: true,
    });
    await postSlackMessage(tenant, event.channel!, result.reply, event.thread_ts ?? event.ts);
  } catch (err) {
    console.error(`[slack/shared] turn failed for tenant ${tenant.slug}: ${err instanceof Error ? err.name : 'error'}`);
    await postSlackMessage(
      tenant,
      event.channel!,
      'Sorry — I hit an error. Please try again in a moment.',
      event.thread_ts ?? event.ts,
    ).catch(() => {});
  }
}

function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 60 * 5) return false;
  const base = `v0:${timestamp}:${body}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Reply via chat.postMessage with the tenant's workspace token (or global fallback). */
async function postSlackMessage(
  tenant: Tenant,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  const botToken = tenant.channels.slack?.bot_token ?? process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    console.error(`[slack/shared] no bot token for tenant ${tenant.slug} (set channels.slack.bot_token or SLACK_BOT_TOKEN)`);
    return;
  }
  if (process.env.SLACK_SEND_DISABLED === 'true') {
    console.log(`[slack/shared] (send disabled) tenant ${tenant.slug} -> ${channel}: ${text.slice(0, 120)}`);
    return;
  }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!data.ok) {
    console.error(`[slack/shared] chat.postMessage failed for ${tenant.slug}: ${data.error ?? res.status}`);
  }
}

type SlackEventPayload = {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: SlackMessageEvent;
};
type SlackMessageEvent = {
  type?: string;
  channel_type?: string;
  subtype?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  user?: string;
  ts?: string;
  thread_ts?: string;
};
