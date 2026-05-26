/**
 * Per-agent knowledge base — docs / FAQ / playbook entries a CS agent can
 * search to answer product/how-to questions (beyond Torque metrics). Scoped
 * per tenant. Retrieval is Postgres full-text search (core PG, no extensions);
 * embeddings/pgvector are a future upgrade. Exposed to the model as the
 * built-in `search_knowledge` tool (lib/agent-runtime.ts).
 */
import { randomBytes } from 'node:crypto';
import { sql } from './db';

export type KnowledgeEntry = {
  id: string;
  tenant_id: string;
  title: string;
  content: string;
  source_url: string | null;
  created_at: Date;
  updated_at: Date;
};

let _schema: Promise<void> | null = null;

export function ensureKnowledgeSchema(): Promise<void> {
  if (_schema) return _schema;
  _schema = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS tenant_knowledge (
        id          TEXT PRIMARY KEY,
        tenant_id   TEXT NOT NULL,
        title       TEXT NOT NULL,
        content     TEXT NOT NULL,
        source_url  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS tenant_knowledge_tenant_idx ON tenant_knowledge(tenant_id)`;
    // Full-text index over title + content for ranked search.
    await sql`
      CREATE INDEX IF NOT EXISTS tenant_knowledge_fts_idx
        ON tenant_knowledge
        USING gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')))
    `;
  })().catch((err) => {
    _schema = null;
    throw err;
  });
  return _schema;
}

function newId(): string {
  return `kb_${randomBytes(6).toString('hex')}`;
}

export async function createEntry(input: {
  tenant_id: string;
  title: string;
  content: string;
  source_url?: string | null;
}): Promise<KnowledgeEntry> {
  await ensureKnowledgeSchema();
  const rows = await sql<KnowledgeEntry[]>`
    INSERT INTO tenant_knowledge (id, tenant_id, title, content, source_url)
    VALUES (${newId()}, ${input.tenant_id}, ${input.title}, ${input.content}, ${input.source_url ?? null})
    RETURNING *
  `;
  return rows[0];
}

export async function listEntries(tenantId: string): Promise<KnowledgeEntry[]> {
  await ensureKnowledgeSchema();
  return sql<KnowledgeEntry[]>`SELECT * FROM tenant_knowledge WHERE tenant_id = ${tenantId} ORDER BY created_at DESC`;
}

export async function countEntries(tenantId: string): Promise<number> {
  await ensureKnowledgeSchema();
  const rows = await sql<{ n: string }[]>`SELECT count(*) AS n FROM tenant_knowledge WHERE tenant_id = ${tenantId}`;
  return Number(rows[0]?.n ?? 0);
}

export async function updateEntry(
  id: string,
  patch: { title?: string; content?: string },
): Promise<KnowledgeEntry | null> {
  await ensureKnowledgeSchema();
  const updates: Record<string, unknown> = {};
  if (patch.title !== undefined) updates.title = patch.title;
  if (patch.content !== undefined) updates.content = patch.content;
  updates.updated_at = new Date();
  const keys = Object.keys(updates);
  const rows = await sql<KnowledgeEntry[]>`
    UPDATE tenant_knowledge SET ${sql(updates, ...keys)} WHERE id = ${id} RETURNING *
  `;
  return rows[0] ?? null;
}

export async function deleteEntry(id: string): Promise<boolean> {
  await ensureKnowledgeSchema();
  const rows = await sql`DELETE FROM tenant_knowledge WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

/**
 * Search a tenant's KB by term overlap and return a compact text block for the
 * model (`search_knowledge`). We score each entry by how many distinct query
 * terms (3+ chars) it contains and return the top matches — robust for
 * natural-language questions on a small per-tenant KB. (FTS / embeddings are
 * the upgrade path once a tenant has many entries.)
 */
export async function searchKnowledge(tenantId: string, query: string, limit = 5): Promise<string> {
  await ensureKnowledgeSchema();
  const terms = [...new Set((query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []))];
  if (terms.length === 0) return 'No query provided.';

  // Bounded fetch — fine for the current scale (few entries per tenant).
  const rows = await sql<{ title: string; content: string }[]>`
    SELECT title, content FROM tenant_knowledge WHERE tenant_id = ${tenantId} LIMIT 200
  `;
  const scored = rows
    .map((r) => {
      const hay = `${r.title} ${r.content}`.toLowerCase();
      const score = terms.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length === 0) return 'No matching knowledge base entries.';
  return scored
    .map((x) => `## ${x.r.title}\n${x.r.content.slice(0, 2000)}`)
    .join('\n\n---\n\n');
}
