/**
 * Fine-grained API key issuance + verification.
 *
 * Plain key format: `ak_live_<32 hex chars>` (40 chars total).
 * We store SHA-256(plainKey) and the first 12 chars of plainKey as `key_prefix`
 * so operators can recognise a key in the UI without exposing the secret.
 *
 * The schema is created lazily on first use (separate from lib/db.ts's
 * `initSchema()` so multiple workstreams can land in parallel without merge
 * conflicts on that function). All callers should `await ensureApiKeySchema()`
 * before touching the table — the helpers in this file do it for you.
 */
import { randomBytes, createHash } from 'node:crypto';
import { sql } from './db';
import type { ApiKey } from './types';

let _schemaPromise: Promise<void> | null = null;

export function ensureApiKeySchema(): Promise<void> {
  if (_schemaPromise) return _schemaPromise;
  _schemaPromise = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS api_keys (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        key_hash      TEXT NOT NULL UNIQUE,
        key_prefix    TEXT NOT NULL,
        scopes        JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_by    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at  TIMESTAMPTZ,
        revoked_at    TIMESTAMPTZ
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS api_keys_key_hash_idx ON api_keys(key_hash)`;
  })().catch((err) => {
    _schemaPromise = null;
    throw err;
  });
  return _schemaPromise;
}

type ApiKeyRow = {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  scopes: string[];
  created_by: string | null;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

function mapRow(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    scopes: row.scopes ?? [],
    created_by: row.created_by,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

function sha256(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

function newKeyId(): string {
  // 12 hex chars — collision-safe at our scale and short enough for log lines.
  return `apikey_${randomBytes(6).toString('hex')}`;
}

function generatePlainKey(): string {
  return `ak_live_${randomBytes(16).toString('hex')}`;
}

export type CreateApiKeyResult = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  plain_key: string;       // ONLY returned at creation time — never retrievable again
  created_at: Date;
};

/**
 * Create a new API key. The plain key is only ever returned from this call;
 * the database stores SHA-256 hash + visible prefix.
 */
export async function createApiKey(
  name: string,
  scopes: string[],
  createdBy: string | null,
): Promise<CreateApiKeyResult> {
  await ensureApiKeySchema();
  const id = newKeyId();
  const plain = generatePlainKey();
  const hash = sha256(plain);
  const prefix = plain.slice(0, 12);
  const rows = await sql<ApiKeyRow[]>`
    INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, created_by)
    VALUES (
      ${id},
      ${name},
      ${hash},
      ${prefix},
      ${sql.json(scopes)},
      ${createdBy}
    )
    RETURNING *
  `;
  const row = rows[0];
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    scopes: row.scopes ?? [],
    plain_key: plain,
    created_at: row.created_at,
  };
}

/**
 * Idempotently ensure an API key with the given plain value + scopes exists.
 * Used once at boot from BOOTSTRAP_ADMIN_KEY so the first key can be provisioned
 * via env (no manual DB access). Never logs or returns the plain key.
 */
export async function ensureBootstrapKey(plain: string, scopes: string[]): Promise<boolean> {
  await ensureApiKeySchema();
  const hash = sha256(plain);
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM api_keys WHERE key_hash = ${hash} AND revoked_at IS NULL LIMIT 1
  `;
  if (existing[0]) {
    // already provisioned — keep scopes in sync with the configured set
    await sql`UPDATE api_keys SET scopes = ${sql.json(scopes)} WHERE id = ${existing[0].id}`;
    return false;
  }
  await sql`
    INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, created_by)
    VALUES (${newKeyId()}, ${'bootstrap'}, ${hash}, ${plain.slice(0, 12)}, ${sql.json(scopes)}, ${'bootstrap'})
  `;
  return true;
}

export type VerifiedApiKey = {
  id: string;
  scopes: string[];
};

/**
 * Look up a Bearer key. Returns the key's id + scopes if it exists and isn't
 * revoked, otherwise null. Schedules an async `last_used_at` bump so we never
 * block the request on the write.
 */
export async function verifyApiKey(plain: string): Promise<VerifiedApiKey | null> {
  if (!plain || !plain.startsWith('ak_live_')) return null;
  await ensureApiKeySchema();
  const hash = sha256(plain);
  const rows = await sql<ApiKeyRow[]>`
    SELECT * FROM api_keys WHERE key_hash = ${hash} AND revoked_at IS NULL LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  // Fire-and-forget last_used_at update — don't await.
  void sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.id}`.catch(() => {
    // Logging here would spam on every request if the table were missing;
    // since we just ran ensureApiKeySchema we trust the row exists.
  });
  return { id: row.id, scopes: row.scopes ?? [] };
}

export async function revokeApiKey(id: string): Promise<boolean> {
  await ensureApiKeySchema();
  const rows = await sql`
    UPDATE api_keys SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL RETURNING id
  `;
  return rows.length > 0;
}

export async function listApiKeys(): Promise<ApiKey[]> {
  await ensureApiKeySchema();
  const rows = await sql<ApiKeyRow[]>`SELECT * FROM api_keys ORDER BY created_at DESC`;
  return rows.map(mapRow);
}

export async function getApiKey(id: string): Promise<ApiKey | null> {
  await ensureApiKeySchema();
  const rows = await sql<ApiKeyRow[]>`SELECT * FROM api_keys WHERE id = ${id} LIMIT 1`;
  return rows[0] ? mapRow(rows[0]) : null;
}
