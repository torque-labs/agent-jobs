import { createHmac, timingSafeEqual } from 'node:crypto';
import { runTenantTurn } from '@/lib/agent-runtime';
import { getTenantBySlug } from '@/lib/tenants';
import {
  getDocument,
  updateDocument,
  createComment,
  proseMirrorToText,
  getBotUserId,
} from '@/lib/outline';

export const runtime = 'nodejs';

/**
 * Outline-as-a-channel. A comment containing the trigger word ("@agent") on any
 * Outline doc invokes the editor agent: it reads the doc, grounds any numbers
 * via its Torque/ingester tools, applies the requested edit via documents.update
 * (apply mode — revertable from Outline's revision history), and replies in the
 * comment thread.
 *
 * Authenticity = Outline's HMAC webhook signature (Stripe-style:
 *   `outline-signature: t=<ms>,s=<hex>` over `${t}.${rawBody}`),
 * verified with OUTLINE_WEBHOOK_SECRET. /api/channels/ is already public in the
 * proxy, so the signature IS the auth.
 *
 * Mirrors the Slack/Telegram channel routes: ack fast, run the turn detached.
 */

const TRIGGER = (process.env.OUTLINE_TRIGGER ?? '@agent').toLowerCase();
const EDITOR_SLUG = process.env.OUTLINE_EDITOR_AGENT ?? 'outline-editor';
// Don't apply a rewrite that comes back this much shorter than the original —
// guards against the agent silently dropping content. Falls back to posting the
// proposal as a comment instead.
const MIN_KEEP_RATIO = 0.2;

function verifySignature(secret: string, header: string, rawBody: string): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  ) as { t?: string; s?: string };
  if (!parts.t || !parts.s) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(parts.s);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function ack(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.OUTLINE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[outline] rejected: OUTLINE_WEBHOOK_SECRET not configured');
    return new Response('not configured', { status: 500 });
  }
  const rawBody = await req.text();
  const sig = req.headers.get('outline-signature') ?? '';
  if (!verifySignature(secret, sig, rawBody)) {
    console.error('[outline] rejected: bad signature');
    return new Response('bad signature', { status: 401 });
  }

  let evt: { event?: string; payload?: { id?: string; model?: Record<string, unknown> } };
  try {
    evt = JSON.parse(rawBody);
  } catch {
    return ack();
  }

  // Only comment creations matter; ack everything else (incl. ping/test).
  if (evt.event !== 'comments.create') return ack();

  const comment = evt.payload?.model ?? {};
  const commentId = (comment.id as string) ?? evt.payload?.id ?? '';
  const documentId = comment.documentId as string | undefined;
  const createdById = comment.createdById as string | undefined;
  const text = proseMirrorToText(comment.data);

  if (!documentId || !commentId || !text) return ack();
  // Trigger filter — don't fire on every comment.
  if (!text.toLowerCase().includes(TRIGGER)) return ack();
  // Loop guard — never act on the bot's own comments.
  const botId = await getBotUserId().catch(() => null);
  if (botId && createdById === botId) return ack();

  const tenant = await getTenantBySlug(EDITOR_SLUG).catch(() => null);
  if (!tenant) {
    console.error(`[outline] editor agent "${EDITOR_SLUG}" not found`);
    return ack();
  }

  // Detached — ack fast, run the turn in the background (long-lived Node server).
  void handleOutlineTurn(tenant.id, documentId, commentId, text).catch((err) =>
    console.error('[outline] detached turn failed:', err instanceof Error ? err.message : err),
  );
  return ack();
}

function extractMarkdownBlock(reply: string): string | null {
  const m = reply.match(/```(?:markdown|md)?\s*\n([\s\S]*?)```/i);
  return m ? m[1].trimEnd() : null;
}

async function handleOutlineTurn(
  tenantId: string,
  documentId: string,
  commentId: string,
  instruction: string,
): Promise<void> {
  const doc = await getDocument(documentId);
  const prompt =
    `You are editing an Outline document. Here is the CURRENT document.\n\n` +
    `Title: ${doc.title}\n\n` +
    `\`\`\`markdown\n${doc.text}\n\`\`\`\n\n` +
    `---\nA reviewer left this comment:\n"${instruction}"\n\n` +
    `Apply the requested change. Reply with ONE sentence summarizing what you changed, ` +
    `then the COMPLETE updated document as raw markdown inside a single fenced ` +
    `\`\`\`markdown block. Preserve everything you were not asked to change, verbatim. ` +
    `Ground every number, name, rank, or date in your tools — never invent data; if a ` +
    `tool can't give you a figure, say so in the doc rather than guessing.`;

  let summary = 'updated the document';
  let newText: string | null = null;
  let replyForComment = '';
  try {
    const result = await runTenantTurn(tenantId, prompt, {
      conversationId: `outline:${documentId}`,
      persist: true,
    });
    replyForComment = result.reply ?? '';
    newText = extractMarkdownBlock(replyForComment);
    const before = replyForComment.split('```')[0].trim();
    if (before) summary = before;
  } catch (err) {
    await createComment(
      documentId,
      `⚠️ I hit an error trying to edit this. ${err instanceof Error ? err.message : ''}`,
      commentId,
    ).catch(() => {});
    return;
  }

  // Lossy guard: refuse to apply a rewrite that dropped most of the doc.
  if (!newText || newText.length < doc.text.length * MIN_KEEP_RATIO) {
    await createComment(
      documentId,
      `I didn't auto-apply this (the rewrite looked lossy or wasn't formatted as a full ` +
        `document). Here's what I'd change — apply it manually if it's right:\n\n${replyForComment}`,
      commentId,
    ).catch(() => {});
    return;
  }

  await updateDocument(documentId, newText);
  await createComment(
    documentId,
    `✅ Applied — ${summary}\n\nRevert anytime from this doc's history (⋯ → History).`,
    commentId,
  ).catch(() => {});
}
