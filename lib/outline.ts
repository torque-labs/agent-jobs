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
