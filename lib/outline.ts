/**
 * Outline (Coolify-hosted) publisher.
 *
 * The TRUMP digest's final `publish` step emits a fenced ```json block with
 * `{ title, collectionId, publish, text }`. The orchestrator parses that
 * manifest and calls `postManifest` here to actually create the document.
 *
 * Failure is surfaced to the caller via thrown Error so the orchestrator can
 * store it on `run.error` without failing the whole run.
 */

export type OutlineManifest = {
  title: string;
  collectionId: string;
  publish?: boolean;
  text: string;
};

export async function postManifest(manifest: OutlineManifest): Promise<string> {
  const base = process.env.OUTLINE_BASE_URL;
  const key = process.env.OUTLINE_API_KEY;
  if (!base) throw new Error('OUTLINE_BASE_URL not configured');
  if (!key) throw new Error('OUTLINE_API_KEY not configured');

  const r = await fetch(`${base.replace(/\/$/, '')}/api/documents.create`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: manifest.title,
      collectionId: manifest.collectionId,
      publish: manifest.publish ?? true,
      text: manifest.text,
    }),
  });

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Outline ${r.status}: ${body.slice(0, 1000)}`);
  }

  const data = (await r.json()) as { data?: { url?: string } };
  const path = data?.data?.url;
  if (!path) {
    throw new Error('Outline response missing data.url');
  }
  return `${base.replace(/\/$/, '')}${path}`;
}

/**
 * Try to extract an Outline manifest from a step output. The publish step
 * is prompted to emit a fenced ```json block but we also accept a raw JSON
 * object as a fallback. Returns null if no manifest is found.
 */
export function parseOutlineManifest(text: string): OutlineManifest | null {
  if (typeof text !== 'string') return null;

  // Prefer a fenced ```json block.
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());

  // Fallback: locate the first { ... } that looks like a manifest.
  const braceStart = text.indexOf('{');
  if (braceStart >= 0) {
    candidates.push(text.slice(braceStart).trim());
  }

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Record<string, unknown>;
      if (
        typeof obj.title === 'string' &&
        typeof obj.collectionId === 'string' &&
        typeof obj.text === 'string'
      ) {
        return {
          title: obj.title,
          collectionId: obj.collectionId,
          publish: typeof obj.publish === 'boolean' ? obj.publish : true,
          text: obj.text,
        };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// --- Comment-driven editor support (Outline as an agent "channel") ----------

function outlineBase(): string {
  const base = process.env.OUTLINE_BASE_URL;
  if (!base) throw new Error('OUTLINE_BASE_URL not configured');
  return base.replace(/\/$/, '');
}

async function outlineApi<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const key = process.env.OUTLINE_API_KEY;
  if (!key) throw new Error('OUTLINE_API_KEY not configured');
  const r = await fetch(`${outlineBase()}/api/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Outline ${endpoint} ${r.status}: ${t.slice(0, 500)}`);
  }
  return (await r.json()) as T;
}

export type OutlineDoc = { id: string; title: string; text: string; url: string };

/** Fetch a document's current markdown body + title. */
export async function getDocument(id: string): Promise<OutlineDoc> {
  const j = await outlineApi<{ data?: Partial<OutlineDoc> }>('documents.info', { id });
  const d = j.data;
  if (!d || typeof d.id !== 'string') throw new Error('documents.info returned no document');
  return { id: d.id, title: d.title ?? '', text: d.text ?? '', url: d.url ?? '' };
}

/** Replace a document's markdown body. Creates a new revision — revertable via
 *  Outline's document history (the undo for apply mode). */
export async function updateDocument(id: string, text: string): Promise<void> {
  await outlineApi('documents.update', { id, text });
}

/** Flatten a ProseMirror comment `data` payload to plain text (inbound parse). */
export function proseMirrorToText(data: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    const node = n as { text?: unknown; content?: unknown };
    if (typeof node.text === 'string') out.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(data);
  return out.join('').trim();
}

/** Wrap plain text as a minimal ProseMirror doc for comments.create (outbound). */
function textToProseMirror(text: string): unknown {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

/** Post a comment (optionally threaded under `parentCommentId`). */
export async function createComment(
  documentId: string,
  text: string,
  parentCommentId?: string,
): Promise<void> {
  const body: Record<string, unknown> = { documentId, data: textToProseMirror(text) };
  if (parentCommentId) body.parentCommentId = parentCommentId;
  await outlineApi('comments.create', body);
}

/** The Outline user id behind OUTLINE_API_KEY — used to ignore the bot's own
 *  comments so it never triggers itself. Cached after first lookup. */
let cachedBotUserId: string | null | undefined;
export async function getBotUserId(): Promise<string | null> {
  if (cachedBotUserId !== undefined) return cachedBotUserId;
  try {
    const j = await outlineApi<{ data?: { user?: { id?: string } } }>('auth.info', {});
    cachedBotUserId = j.data?.user?.id ?? null;
  } catch {
    cachedBotUserId = null;
  }
  return cachedBotUserId;
}
