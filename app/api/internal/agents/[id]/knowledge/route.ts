import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getTenant } from '@/lib/tenants';
import { createEntry, listEntries } from '@/lib/tenant-knowledge';

export const runtime = 'nodejs';

// Either paste content, or give a URL to import (server fetches + strips to text).
const createBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    content: z.string().min(1).optional(),
    url: z.string().url().optional(),
  })
  .refine((b) => b.content || b.url, { message: 'content or url is required' });

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Basic SSRF guard: https only, no localhost / private ranges. */
function safeUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname;
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '0.0.0.0' ||
    h.endsWith('.local') ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  ) {
    return null;
  }
  return u;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(await listEntries(id));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) return NextResponse.json({ error: 'Agent not found' }, { status: 404 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = createBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', issues: parsed.error.issues }, { status: 400 });
  }
  let { title, content } = parsed.data;
  const { url } = parsed.data;
  let sourceUrl: string | null = null;

  if (!content && url) {
    const u = safeUrl(url);
    if (!u) return NextResponse.json({ error: 'URL not allowed (https public hosts only)' }, { status: 400 });
    let html: string;
    try {
      const res = await fetch(u.toString(), { signal: AbortSignal.timeout(15000) });
      if (!res.ok) return NextResponse.json({ error: `Fetch failed (${res.status})` }, { status: 400 });
      html = await res.text();
    } catch {
      return NextResponse.json({ error: 'Could not fetch the URL' }, { status: 400 });
    }
    content = htmlToText(html).slice(0, 50000);
    if (!content) return NextResponse.json({ error: 'No text extracted from the URL' }, { status: 400 });
    sourceUrl = u.toString();
    if (!title) title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || u.hostname;
  }

  if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 });
  if (!content) return NextResponse.json({ error: 'content is required' }, { status: 400 });

  const entry = await createEntry({ tenant_id: id, title, content, source_url: sourceUrl });
  return NextResponse.json(entry, { status: 201 });
}
