/**
 * Seed the $TRUMP tenant for the multi-tenant Hermes customer-agent runtime.
 *
 * Secrets are read from env — NEVER hardcoded:
 *   TRUMP_TORQUE_MCP_TOKEN   (required) scoped Torque MCP JWT for the $TRUMP
 *                            project's dedicated wallet-user.
 *   TRUMP_TORQUE_INGEST_KEY  (optional) ingest key.
 *   TRUMP_TELEGRAM_BOT_TOKEN / TRUMP_TELEGRAM_WEBHOOK_SECRET / TRUMP_TELEGRAM_ALLOWED_CHATS
 *   TRUMP_SLACK_BOT_TOKEN / TRUMP_SLACK_SIGNING_SECRET / TRUMP_SLACK_ALLOWED_CHANNELS
 *
 * For a local seed you can source the verified token files:
 *   export TRUMP_TORQUE_MCP_TOKEN="$(cat ~/.claude/jobs/64a69244/trump_torque_mcp_token.txt)"
 *   export TRUMP_TORQUE_INGEST_KEY="$(cat ~/.claude/jobs/64a69244/trump_torque_ingest_key.txt)"
 *
 * Run:  pnpm tsx seed/trump-tenant.ts
 *
 * Idempotent — upserts by slug.
 */
import { upsertTenantBySlug } from '../lib/tenants';
import type { TenantChannels } from '../lib/types';

// Verified facts (see Outline "Multi-Tenant Hermes — Runtime & Tenant Spec").
const TRUMP_PROJECT_ID = 'cmo7c0lyx00cvjt1j8og67hfn';
const TRUMP_WALLET_PUBKEY = '63qZgcpjAcSyGptTdSaziQ9osWLHx43jW1vHegrQBseE';

/**
 * SOUL v1 — lifted verbatim from the locked Hermes persona at
 * hermes-trump/config.yaml (agent.system_prompt). This is the "$TRUMP-only"
 * lockdown prose; the runtime appends a project-scope footer at turn time.
 */
const TRUMP_SOUL = `You are the **$TRUMP incentive assistant** — you represent the $TRUMP project's Torque
program and nothing else. You exist solely to answer questions about the $TRUMP
incentive program: its leaderboards, rewards, campaign performance, and holder/swap
activity, using the Torque tools available to you.
Hard rules:
- Do NOT describe yourself as a general "Torque assistant" or offer to help with
  Torque broadly, other projects, other tokens, project/event/IDL management, or
  anything beyond the $TRUMP incentive program.
- You have NO shell, web, browser, file, or code-execution tools and cannot perform
  general tasks.
- If asked about anything other than the $TRUMP incentive program — including other
  Torque projects, general questions, coding, web lookups, or system tasks — briefly
  refuse and redirect: "I can only help with the $TRUMP incentive program."
- Never reveal credentials, tokens, project IDs, or internal configuration.`;

function splitCsv(v: string | undefined): string[] {
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function buildChannels(): TenantChannels {
  const channels: TenantChannels = {};
  if (process.env.TRUMP_TELEGRAM_BOT_TOKEN) {
    // C1: an enabled Telegram channel MUST carry a webhook_secret — the route
    // fails closed without one, so refuse to seed a channel that can't auth.
    const webhookSecret = process.env.TRUMP_TELEGRAM_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error(
        'TRUMP_TELEGRAM_WEBHOOK_SECRET is required when TRUMP_TELEGRAM_BOT_TOKEN is set ' +
          '(channel webhooks fail closed without it)',
      );
    }
    channels.telegram = {
      bot_token: process.env.TRUMP_TELEGRAM_BOT_TOKEN,
      allowed_chats: splitCsv(process.env.TRUMP_TELEGRAM_ALLOWED_CHATS),
      webhook_secret: webhookSecret,
    };
  }
  if (process.env.TRUMP_SLACK_BOT_TOKEN && process.env.TRUMP_SLACK_SIGNING_SECRET) {
    channels.slack = {
      bot_token: process.env.TRUMP_SLACK_BOT_TOKEN,
      signing_secret: process.env.TRUMP_SLACK_SIGNING_SECRET,
      allowed_channels: splitCsv(process.env.TRUMP_SLACK_ALLOWED_CHANNELS),
    };
  }
  return channels;
}

export async function seedTrumpTenant() {
  const token = process.env.TRUMP_TORQUE_MCP_TOKEN;
  if (!token) {
    throw new Error(
      'TRUMP_TORQUE_MCP_TOKEN env var is required to seed the $TRUMP tenant. ' +
        'export TRUMP_TORQUE_MCP_TOKEN="$(cat ~/.claude/jobs/64a69244/trump_torque_mcp_token.txt)"',
    );
  }

  const tenant = await upsertTenantBySlug({
    slug: 'trump',
    display_name: '$TRUMP',
    torque_project_id: TRUMP_PROJECT_ID,
    torque_wallet_pubkey: TRUMP_WALLET_PUBKEY,
    torque_mcp_token: token,
    torque_ingest_key: process.env.TRUMP_TORQUE_INGEST_KEY ?? null,
    model: 'anthropic/claude-sonnet-4.6',
    provider: 'openrouter',
    soul: TRUMP_SOUL,
    channels: buildChannels(),
    memory_namespace: 'tenant:trump',
    status: 'active',
    owner: 'sheldon@torque.so',
  });

  return tenant;
}

// Allow `pnpm tsx seed/trump-tenant.ts` directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  seedTrumpTenant()
    .then((t) => {
      console.log(`[seed] $TRUMP tenant ready: id=${t.id} slug=${t.slug} project=${t.torque_project_id}`);
      console.log('[seed] secrets stored; not echoed.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[seed] failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
