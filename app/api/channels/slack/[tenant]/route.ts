import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { runTenantTurn } from '@/lib/agent-runtime';
import { getTenantForSlack } from '@/lib/tenants';
import type { Tenant } from '@/lib/types';

export const runtime = 'nodejs';

/**
 * Slack Events API webhook for a tenant's private Slack app.
 *
 * Path: /api/channels/slack/<tenant-slug>
 *
 * PUBLIC at the proxy layer — authenticity is established by the tenant's Slack
 * signing secret (HMAC over the raw body). TODO at deploy time: add
 * `/api/channels/` to proxy.ts PUBLIC_PREFIXES.
 *
 * Slack requires a response within 3 seconds, so we:
 *   1. Verify the signature over the RAW body.
 *   2. Answer the one-time url_verification challenge synchronously.
 *   3. For message events: ack 200 IMMEDIATELY, then run the (slower) model
 *      turn + reply in a detached promise (chat.postMessage).
 */
export async function POST(req: Request, { params }: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await params;
  const tenant = await getTenantForSlack(slug).catch(() => null);
  if (!tenant) return NextResponse.json({ ok: true });

  // C1: fail CLOSED. A Slack-enabled tenant MUST have a signing_secret. If it's
  // missing, reject 401 and do NOT parse or act on the body — including the
  // url_verification handshake, which must also be signed.
  const signingSecret = tenant.channels.slack?.signing_secret;
  if (!signingSecret) {
    console.error(`[slack/${slug}] rejected: tenant has no signing_secret configured`);
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const rawBody = await req.text();

  // --- Signature verification over the raw body (mandatory, incl. handshake). ---
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

  // --- One-time URL verification handshake (only after a valid signature). ---
  if (payload.type === 'url_verification') {
    return NextResponse.json({ challenge: payload.challenge });
  }

  const event = payload.event;
  // Only handle user messages; ignore bot echoes / subtype edits / our own posts.
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

  // M2: empty allow-list must NOT mean allow-all. Require an explicit
  // non-empty allowed_channels unless the tenant opts into allow_all.
  const sl = tenant.channels.slack;
  const allowed = sl?.allowed_channels ?? [];
  const allowAll = sl?.allow_all === true;
  if (!allowAll && allowed.length === 0) {
    console.error(`[slack/${slug}] rejected: no allowed_channels and allow_all not set`);
    return NextResponse.json({ ok: true });
  }
  if (!allowAll && !allowed.includes(event.channel)) {
    return NextResponse.json({ ok: true });
  }

  // --- Ack within 3s; do the model work + reply detached. ---
  // M3 (KNOWN LIMITATION — TODO): this fires the turn in a detached promise
  // after the 200 ack with NO event dedupe. On serverless that risks the reply
  // being dropped when the function is frozen post-response, and Slack's
  // at-least-once retries (it re-POSTs on any non-2xx OR ~3s timeout) can
  // double-invoke the agent. agent-jobs has a durable runs/queue subsystem
  // (lib/orchestrator.ts, the `runs` table) but it is keyed to Jobs, not to
  // ad-hoc channel turns, so there is no drop-in enqueue path here yet. Proper
  // fix: persist inbound Slack events keyed on the Slack `event_id` (dedupe),
  // enqueue durably, and process out-of-band so the reply survives freeze and
  // retries are idempotent. Left as a TODO rather than half-built to avoid a
  // false sense of durability. The Slack `event_id` (payload.event_id) is the
  // natural idempotency key for that work.
  void handleSlackTurn(tenant, event).catch((err) => {
    console.error(`[slack/${slug}] detached turn failed:`, err);
  });

  return NextResponse.json({ ok: true });
}

async function handleSlackTurn(tenant: Tenant, event: SlackMessageEvent): Promise<void> {
  try {
    const result = await runTenantTurn(tenant.id, event.text!, {
      conversationId: `slack:${event.channel}${event.thread_ts ? ':' + event.thread_ts : ''}`,
      speaker: event.user,
      persist: true,
    });
    await postSlackMessage(tenant, event.channel!, result.reply, event.thread_ts ?? event.ts);
  } catch (err) {
    console.error(`[slack/${tenant.slug}] turn failed:`, err);
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
  // Reject stale requests (>5 min) to blunt replay attacks.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 60 * 5) return false;
  const base = `v0:${timestamp}:${body}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Reply via Slack chat.postMessage.
 *
 * NETWORK: hits slack.com. Stubbed-safe: if SLACK_SEND_DISABLED is set we log
 * instead of calling out.
 */
async function postSlackMessage(
  tenant: Tenant,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  const botToken = tenant.channels.slack?.bot_token;
  if (!botToken) return;
  if (process.env.SLACK_SEND_DISABLED === 'true') {
    console.log(`[slack/${tenant.slug}] (send disabled) → ${channel}: ${text.slice(0, 120)}`);
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
    console.error(`[slack/${tenant.slug}] chat.postMessage failed: ${data.error ?? res.status}`);
  }
}

// Minimal Slack Events API shapes — only the fields we read.
type SlackEventPayload = {
  type?: string;
  challenge?: string;
  /** Slack's per-delivery id; idempotency key for the M3 dedupe TODO. */
  event_id?: string;
  event?: SlackMessageEvent;
};
type SlackMessageEvent = {
  type?: string;
  subtype?: string;
  bot_id?: string;
  text?: string;
  channel?: string;
  user?: string;
  ts?: string;
  thread_ts?: string;
};
