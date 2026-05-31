'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2Icon, TrashIcon, PencilIcon, ChevronDownIcon, ChevronRightIcon, XIcon } from 'lucide-react';
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

type ExpandedState = 'collapsed' | 'preview' | 'edit';

function EntryRow({
  agentId,
  entry,
  busyId,
  setBusyId,
  onMutate,
}: {
  agentId: string;
  entry: KnowledgeView;
  busyId: string | null;
  setBusyId: (id: string | null) => void;
  onMutate: () => void;
}) {
  const [state, setState] = useState<ExpandedState>('collapsed');
  const [editTitle, setEditTitle] = useState(entry.title);
  const [editContent, setEditContent] = useState(entry.content);

  async function save() {
    if (!editTitle.trim() || !editContent.trim()) {
      toast.error('Title and content are required');
      return;
    }
    setBusyId(entry.id);
    try {
      const res = await fetch(`/api/internal/agents/${agentId}/knowledge/${entry.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: editTitle.trim(), content: editContent.trim() }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        toast.error(b?.error ?? `Save failed (${res.status})`);
        return;
      }
      toast.success('Updated');
      setState('preview');
      onMutate();
    } finally {
      setBusyId(null);
    }
  }

  async function remove() {
    setBusyId(entry.id);
    try {
      const res = await fetch(`/api/internal/agents/${agentId}/knowledge/${entry.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        toast.error('Delete failed');
        return;
      }
      toast.success('Deleted');
      onMutate();
    } finally {
      setBusyId(null);
    }
  }

  function startEdit() {
    setEditTitle(entry.title);
    setEditContent(entry.content);
    setState('edit');
  }

  function cancelEdit() {
    setEditTitle(entry.title);
    setEditContent(entry.content);
    setState('preview');
  }

  const charCount = entry.content.length;
  const isBusy = busyId === entry.id;

  return (
    <div className="rounded-md border bg-background">
      {/* Header row — clickable to expand */}
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setState((s) => (s === 'collapsed' ? 'preview' : 'collapsed'))}
          className="mt-0.5 text-muted-foreground hover:text-foreground"
          aria-label={state === 'collapsed' ? 'Expand' : 'Collapse'}
        >
          {state === 'collapsed' ? (
            <ChevronRightIcon className="size-4" />
          ) : (
            <ChevronDownIcon className="size-4" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => setState((s) => (s === 'collapsed' ? 'preview' : 'collapsed'))}
            className="block w-full text-left text-xs font-medium"
          >
            {entry.title}
          </button>
          {state === 'collapsed' && (
            <div className="truncate text-xs text-muted-foreground">{entry.content.slice(0, 160)}</div>
          )}
          <div className="mt-0.5 flex gap-2 text-[10px] text-muted-foreground">
            <span>{charCount.toLocaleString()} chars</span>
            {entry.source_url && (
              <>
                <span>·</span>
                <span className="truncate">↪ {entry.source_url}</span>
              </>
            )}
          </div>
        </div>
        <div className="flex gap-1">
          {state !== 'edit' && (
            <button
              type="button"
              onClick={startEdit}
              disabled={isBusy}
              className="text-muted-foreground hover:text-foreground"
              aria-label="Edit entry"
            >
              <PencilIcon className="size-4" />
            </button>
          )}
          <button
            type="button"
            onClick={remove}
            disabled={isBusy}
            className="text-muted-foreground hover:text-destructive"
            aria-label="Delete entry"
          >
            {isBusy ? <Loader2Icon className="size-4 animate-spin" /> : <TrashIcon className="size-4" />}
          </button>
        </div>
      </div>

      {/* Preview body */}
      {state === 'preview' && (
        <div className="border-t px-3 py-2">
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-foreground/90">
            {entry.content}
          </pre>
        </div>
      )}

      {/* Edit form */}
      {state === 'edit' && (
        <div className="flex flex-col gap-2 border-t px-3 py-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Title</Label>
            <Input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              disabled={isBusy}
              className="text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Content</Label>
            <Textarea
              rows={14}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              disabled={isBusy}
              className="font-mono text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              {editContent.length.toLocaleString()} chars
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={save} disabled={isBusy}>
              {isBusy && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
              Save
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={cancelEdit} disabled={isBusy}>
              <XIcon className="size-4" /> Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

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
            <EntryRow
              key={e.id}
              agentId={id}
              entry={e}
              busyId={busyId}
              setBusyId={setBusyId}
              onMutate={() => router.refresh()}
            />
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
            <Textarea
              rows={12}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={adding}
              className="font-mono text-xs"
              placeholder="Paste the FAQ / doc text…"
            />
            <p className="text-[10px] text-muted-foreground">
              {content.length.toLocaleString()} chars
            </p>
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
