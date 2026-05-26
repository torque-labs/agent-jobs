/**
 * Tenant store for the multi-tenant Hermes customer-agent runtime.
 *
 * Each tenant = one Torque customer with a private conversational agent. The
 * isolation boundary is the `torque_mcp_token` column: a scoped Torque MCP JWT
 * minted from a wallet that administers ONLY that customer's project. When a
 * turn runs (lib/agent-runtime.ts) we hand that token to an ephemeral Torque
 * MCP subprocess so the agent can physically only see that one project.
 *
 * Secret handling mirrors lib/api-keys.ts: secrets live in TEXT columns (same
 * as webhooks.secret today — agent-jobs stores integration secrets at rest in
 * Postgres rather than with an app-level KMS) and are NEVER returned from the
 * `Public*` mappers. Callers that actually need a secret call the explicit
 * `get*Secret` helpers, which are only invoked server-side from the runtime
 * and channel webhooks.
 *
 * Schema is bootstrapped lazily here (separate from lib/db.ts initSchema) so
 * this workstream can land without touching that shared function.
 */
import { randomBytes } from 'node:crypto';
import { sql } from './db';
import type {
  PublicTenant,
  PublicTenantChannels,
  Tenant,
  TenantChannels,
  TenantDataSource,
} from './types';

let _schemaPromise: Promise<void> | null = null;

export function ensureTenantSchema(): Promise<void> {
  if (_schemaPromise) return _schemaPromise;
  _schemaPromise = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS tenants (
        id                   TEXT PRIMARY KEY,
        slug                 TEXT NOT NULL UNIQUE,
        display_name         TEXT NOT NULL,
        torque_project_id    TEXT NOT NULL,
        torque_wallet_pubkey TEXT NOT NULL,
        torque_mcp_token     TEXT NOT NULL,
        torque_ingest_key    TEXT,
        model                TEXT NOT NULL DEFAULT 'anthropic/claude-sonnet-4.6',
        provider             TEXT NOT NULL DEFAULT 'openrouter',
        soul                 TEXT NOT NULL DEFAULT '',
        channels             JSONB NOT NULL DEFAULT '{}'::jsonb,
        memory_namespace     TEXT NOT NULL,
        data_sources         JSONB,
        status               TEXT NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active','paused','disabled')),
        owner                TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS tenants_slug_idx ON tenants(slug)`;
    await sql`
      CREATE INDEX IF NOT EXISTS tenants_torque_project_idx
        ON tenants(torque_project_id)
    `;
  })().catch((err) => {
    _schemaPromise = null;
    throw err;
  });
  return _schemaPromise;
}

// ---------- Row mapping ----------

type TenantRow = {
  id: string;
  slug: string;
  display_name: string;
  torque_project_id: string;
  torque_wallet_pubkey: string;
  torque_mcp_token: string;
  torque_ingest_key: string | null;
  model: string;
  provider: string;
  soul: string;
  channels: TenantChannels | null;
  memory_namespace: string;
  data_sources: TenantDataSource[] | null;
  status: Tenant['status'];
  owner: string | null;
  created_at: Date;
  updated_at: Date;
};

function mapRow(row: TenantRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.display_name,
    torque_project_id: row.torque_project_id,
    torque_wallet_pubkey: row.torque_wallet_pubkey,
    torque_mcp_token: row.torque_mcp_token,
    torque_ingest_key: row.torque_ingest_key,
    model: row.model,
    provider: row.provider,
    soul: row.soul ?? '',
    channels: row.channels ?? {},
    memory_namespace: row.memory_namespace,
    data_sources: row.data_sources ?? null,
    status: row.status,
    owner: row.owner,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Strip every secret so a tenant is safe to return over the API. */
export function toPublicTenant(t: Tenant): PublicTenant {
  const channels: PublicTenantChannels = {};
  if (t.channels.telegram) {
    channels.telegram = {
      allowed_chats: t.channels.telegram.allowed_chats ?? [],
      configured: Boolean(t.channels.telegram.bot_token),
    };
  }
  if (t.channels.slack) {
    channels.slack = {
      allowed_channels: t.channels.slack.allowed_channels ?? [],
      configured: Boolean(t.channels.slack.bot_token && t.channels.slack.signing_secret),
    };
  }
  return {
    id: t.id,
    slug: t.slug,
    display_name: t.display_name,
    torque_project_id: t.torque_project_id,
    torque_wallet_pubkey: t.torque_wallet_pubkey,
    model: t.model,
    provider: t.provider,
    soul: t.soul,
    memory_namespace: t.memory_namespace,
    data_sources: t.data_sources,
    status: t.status,
    owner: t.owner,
    created_at: t.created_at,
    updated_at: t.updated_at,
    channels,
    has_torque_ingest_key: Boolean(t.torque_ingest_key),
  };
}

function newTenantId(): string {
  return `tenant_${randomBytes(6).toString('hex')}`;
}

// ---------- CRUD ----------

export type CreateTenantInput = {
  id?: string;
  slug: string;
  display_name: string;
  torque_project_id: string;
  torque_wallet_pubkey: string;
  torque_mcp_token: string;
  torque_ingest_key?: string | null;
  model?: string;
  provider?: string;
  soul: string;
  channels?: TenantChannels;
  memory_namespace?: string;
  data_sources?: TenantDataSource[] | null;
  status?: Tenant['status'];
  owner?: string | null;
};

export async function createTenant(input: CreateTenantInput): Promise<Tenant> {
  await ensureTenantSchema();
  const id = input.id ?? newTenantId();
  const memoryNamespace = input.memory_namespace ?? `tenant:${input.slug}`;
  const rows = await sql<TenantRow[]>`
    INSERT INTO tenants (
      id, slug, display_name, torque_project_id, torque_wallet_pubkey,
      torque_mcp_token, torque_ingest_key, model, provider, soul,
      channels, memory_namespace, data_sources, status, owner
    )
    VALUES (
      ${id},
      ${input.slug},
      ${input.display_name},
      ${input.torque_project_id},
      ${input.torque_wallet_pubkey},
      ${input.torque_mcp_token},
      ${input.torque_ingest_key ?? null},
      ${input.model ?? 'anthropic/claude-sonnet-4.6'},
      ${input.provider ?? 'openrouter'},
      ${input.soul},
      ${sql.json(input.channels ?? {})},
      ${memoryNamespace},
      ${input.data_sources ? sql.json(input.data_sources) : null},
      ${input.status ?? 'active'},
      ${input.owner ?? null}
    )
    RETURNING *
  `;
  return mapRow(rows[0]);
}

/**
 * Idempotent upsert keyed on slug — used by the seed so re-running it refreshes
 * secrets/config without duplicating the row.
 */
export async function upsertTenantBySlug(input: CreateTenantInput): Promise<Tenant> {
  await ensureTenantSchema();
  const existing = await getTenantBySlug(input.slug);
  if (!existing) return createTenant(input);
  const updated = await updateTenant(existing.id, {
    display_name: input.display_name,
    torque_project_id: input.torque_project_id,
    torque_wallet_pubkey: input.torque_wallet_pubkey,
    torque_mcp_token: input.torque_mcp_token,
    torque_ingest_key: input.torque_ingest_key ?? null,
    model: input.model,
    provider: input.provider,
    soul: input.soul,
    channels: input.channels,
    data_sources: input.data_sources ?? null,
    status: input.status,
    owner: input.owner ?? null,
  });
  return updated ?? existing;
}

export async function getTenant(id: string): Promise<Tenant | null> {
  await ensureTenantSchema();
  const rows = await sql<TenantRow[]>`SELECT * FROM tenants WHERE id = ${id} LIMIT 1`;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getTenantBySlug(slug: string): Promise<Tenant | null> {
  await ensureTenantSchema();
  const rows = await sql<TenantRow[]>`SELECT * FROM tenants WHERE slug = ${slug} LIMIT 1`;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function listTenants(): Promise<Tenant[]> {
  await ensureTenantSchema();
  const rows = await sql<TenantRow[]>`SELECT * FROM tenants ORDER BY created_at DESC`;
  return rows.map(mapRow);
}

export type UpdateTenantInput = Partial<{
  display_name: string;
  torque_project_id: string;
  torque_wallet_pubkey: string;
  torque_mcp_token: string;
  torque_ingest_key: string | null;
  model: string;
  provider: string;
  soul: string;
  channels: TenantChannels;
  memory_namespace: string;
  data_sources: TenantDataSource[] | null;
  status: Tenant['status'];
  owner: string | null;
}>;

export async function updateTenant(
  id: string,
  patch: UpdateTenantInput,
): Promise<Tenant | null> {
  await ensureTenantSchema();
  const updates: Record<string, unknown> = {};
  if (patch.display_name !== undefined) updates.display_name = patch.display_name;
  if (patch.torque_project_id !== undefined) updates.torque_project_id = patch.torque_project_id;
  if (patch.torque_wallet_pubkey !== undefined) updates.torque_wallet_pubkey = patch.torque_wallet_pubkey;
  if (patch.torque_mcp_token !== undefined) updates.torque_mcp_token = patch.torque_mcp_token;
  if (patch.torque_ingest_key !== undefined) updates.torque_ingest_key = patch.torque_ingest_key;
  if (patch.model !== undefined) updates.model = patch.model;
  if (patch.provider !== undefined) updates.provider = patch.provider;
  if (patch.soul !== undefined) updates.soul = patch.soul;
  if (patch.channels !== undefined) updates.channels = sql.json(patch.channels);
  if (patch.memory_namespace !== undefined) updates.memory_namespace = patch.memory_namespace;
  if (patch.data_sources !== undefined) {
    updates.data_sources = patch.data_sources ? sql.json(patch.data_sources) : null;
  }
  if (patch.status !== undefined) updates.status = patch.status;
  if (patch.owner !== undefined) updates.owner = patch.owner;
  updates.updated_at = new Date();

  const keys = Object.keys(updates);
  if (keys.length === 1) return getTenant(id); // only updated_at

  const rows = await sql<TenantRow[]>`
    UPDATE tenants SET ${sql(updates, ...keys)}
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function deleteTenant(id: string): Promise<boolean> {
  await ensureTenantSchema();
  const rows = await sql`DELETE FROM tenants WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

// ---------- Channel routing lookups ----------
//
// Channel webhooks resolve an inbound message to a tenant by slug (the route's
// [tenant] segment). These helpers fetch the full row (secrets included) for
// the runtime + signature verification — they are server-only.

/** Telegram-routed tenants only. */
export async function getTenantForTelegram(slug: string): Promise<Tenant | null> {
  const t = await getTenantBySlug(slug);
  if (!t || !t.channels.telegram?.bot_token) return null;
  return t;
}

/**
 * Shared-bot routing: resolve the tenant that owns a Telegram chat id. The
 * chat id (a customer's group/DM) is enrolled in exactly one tenant's
 * channels.telegram.allowed_chats. Fails closed: no match → null; an ambiguous
 * mapping (same chat in >1 tenant) → null + log, never a guess. `allow_all` is
 * intentionally ignored here — in shared mode a tenant routes ONLY by the chat
 * ids explicitly enrolled to it.
 */
export async function getTenantByTelegramChat(chatId: string): Promise<Tenant | null> {
  await ensureTenantSchema();
  const rows = await sql<TenantRow[]>`SELECT * FROM tenants WHERE status = 'active'`;
  const matches = rows
    .map(mapRow)
    .filter((t) => (t.channels.telegram?.allowed_chats ?? []).includes(chatId));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.error(`[tenants] telegram chat ${chatId} maps to ${matches.length} tenants; refusing (ambiguous)`);
    return null;
  }
  return matches[0];
}

/** Slack-routed tenants only. */
export async function getTenantForSlack(slug: string): Promise<Tenant | null> {
  const t = await getTenantBySlug(slug);
  if (!t || !t.channels.slack?.bot_token) return null;
  return t;
}

/**
 * Shared-app routing: resolve the tenant that owns a Slack channel id. Slack
 * channel ids are globally unique, so (like the Telegram chat id) the channel
 * is the routing key — enrolled in exactly one tenant's
 * channels.slack.allowed_channels. Fails closed: no match → null; ambiguous
 * (channel in >1 tenant) → null + log. allow_all is ignored for shared routing.
 */
export async function getTenantBySlackChannel(channelId: string): Promise<Tenant | null> {
  await ensureTenantSchema();
  const rows = await sql<TenantRow[]>`SELECT * FROM tenants WHERE status = 'active'`;
  const matches = rows
    .map(mapRow)
    .filter((t) => (t.channels.slack?.allowed_channels ?? []).includes(channelId));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.error(`[tenants] slack channel ${channelId} maps to ${matches.length} tenants; refusing (ambiguous)`);
    return null;
  }
  return matches[0];
}
