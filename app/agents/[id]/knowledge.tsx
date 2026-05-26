'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2Icon, TrashIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export type KnowledgeView = {
  id: string;
  title: string;
  content: string;
  source_url: string | null;
};

export function KnowledgeSection({ id, initial }: { id: string; initial: KnowledgeView[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mode, setMode] = useState<'paste' | 'url'>('paste');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);

  async function add() {
    const body =
      mode === 'paste'
        ? { title: title.trim(), content: content.trim() }
        : { title: title.trim() || undefined, url: url.trim() };
    if (mode === 'paste' && (!title.trim() || !content.trim())) {
      toast.error('Title and content are required');
      return;
    }
    if (mode === 'url' && !url.trim()) {
      toast.error('URL is required');
      return;
    }
    setAdding(true);
    try {
      const res = await fetch(`/api/internal/agents/${id}/knowledge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        toast.error(b?.error ?? `Add failed (${res.status})`);
        return;
      }
      toast.success('Knowledge added');
      setTitle('');
      setContent('');
      setUrl('');
      router.refresh();
    } finally {
      setAdding(false);
    }
  }

  async function remove(entry: KnowledgeView) {
    setBusyId(entry.id);
    try {
      const res = await fetch(`/api/internal/agents/${id}/knowledge/${entry.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        toast.error('Delete failed');
        return;
      }
      toast.success('Deleted');
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="rounded-lg border p-4">
      <h3 className="mb-1 text-sm font-semibold">Knowledge base</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Docs / FAQ / playbook the agent can search (the `search_knowledge` tool) to answer
        product &amp; how-to questions beyond Torque metrics. Full-text search; scoped to this agent.
      </p>

      {initial.length > 0 && (
        <div className="mb-4 flex flex-col gap-2">
          {initial.map((e) => (
            <div key={e.id} className="flex items-start gap-3 rounded-md border bg-background px-3 py-2 text-xs">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{e.title}</div>
                <div className="truncate text-muted-foreground">{e.content.slice(0, 160)}</div>
                {e.source_url && (
                  <div className="truncate text-[11px] text-muted-foreground">↪ {e.source_url}</div>
                )}
              </div>
              <button
                type="button"
                disabled={busyId === e.id}
                onClick={() => remove(e)}
                className="text-muted-foreground hover:text-destructive"
                aria-label="Delete entry"
              >
                {busyId === e.id ? <Loader2Icon className="size-4 animate-spin" /> : <TrashIcon className="size-4" />}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-md border border-dashed p-3">
        <div className="flex gap-1 text-xs">
          <button
            type="button"
            onClick={() => setMode('paste')}
            className={`rounded-md px-2 py-1 ${mode === 'paste' ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
          >
            Paste text
          </button>
          <button
            type="button"
            onClick={() => setMode('url')}
            className={`rounded-md px-2 py-1 ${mode === 'url' ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
          >
            Import URL
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Title {mode === 'url' && '(optional — derived from page)'}</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={adding} placeholder="e.g. How rewards are claimed" />
        </div>

        {mode === 'paste' ? (
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Content</Label>
            <Textarea rows={4} value={content} onChange={(e) => setContent(e.target.value)} disabled={adding} className="text-xs" placeholder="Paste the FAQ / doc text…" />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">URL (https, public)</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} disabled={adding} className="font-mono text-xs" placeholder="https://docs.example.com/faq" />
            <p className="text-[11px] text-muted-foreground">We fetch the page once and store its text.</p>
          </div>
        )}

        <div>
          <Button type="button" onClick={add} disabled={adding}>
            {adding && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
            Add to knowledge base
          </Button>
        </div>
      </div>
    </section>
  );
}
