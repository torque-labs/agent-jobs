'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';

export function CreateAgentDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [token, setToken] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [soul, setSoul] = useState('');
  const [ingester, setIngester] = useState(false);

  function reset() {
    setSlug('');
    setDisplayName('');
    setProjectId('');
    setToken('');
    setModel(DEFAULT_MODEL);
    setSoul('');
    setIngester(false);
    setSubmitting(false);
  }

  function close() {
    setOpen(false);
    setTimeout(reset, 200);
  }

  async function submit() {
    if (!slug.trim() || !displayName.trim() || !projectId.trim() || !token.trim() || !soul.trim()) {
      toast.error('Slug, name, project id, token, and soul are all required');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/internal/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: slug.trim(),
          display_name: displayName.trim(),
          torque_project_id: projectId.trim(),
          torque_mcp_token: token.trim(),
          model: model.trim() || DEFAULT_MODEL,
          soul: soul.trim(),
          data_sources: ingester
            ? [{ type: 'ingester', label: 'Torque Ingester', value: 'enabled' }]
            : null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        // Surfaces the scope-check reason, e.g. "token administers no projects".
        toast.error(body?.error ?? `Create failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      toast.success('Agent created');
      router.refresh();
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setTimeout(reset, 200);
      }}
    >
      <DialogTrigger asChild>
        <Button>+ New agent</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create agent</DialogTitle>
          <DialogDescription>
            The Torque token is the isolation boundary — it must be scoped to exactly the
            project below. We verify that server-side before saving (this can take a few seconds).
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="a-slug">Slug</Label>
              <Input
                id="a-slug"
                placeholder="mplx-s1"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="a-name">Display name</Label>
              <Input
                id="a-name"
                placeholder="MPLX S1"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={submitting}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="a-project">Torque project id</Label>
            <Input
              id="a-project"
              placeholder="cmmcg6rpt04xgip1iz1paltfv"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={submitting}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="a-token">Torque MCP token (scoped to this project)</Label>
            <Input
              id="a-token"
              type="password"
              placeholder="eyJhbGciOi…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={submitting}
              className="font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              Write-only — stored server-side, never shown again.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="a-model">Model</Label>
            <Input
              id="a-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={submitting}
              className="font-mono text-xs"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="a-soul">Soul / system prompt</Label>
            <Textarea
              id="a-soul"
              rows={6}
              placeholder="You are the … incentive assistant — you represent … and nothing else."
              value={soul}
              onChange={(e) => setSoul(e.target.value)}
              disabled={submitting}
              className="text-xs"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={ingester}
              onChange={(e) => setIngester(e.target.checked)}
              disabled={submitting}
            />
            Enable Torque Ingester (raw on-chain swap data, read-only)
          </label>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={submitting}>
            {submitting ? 'Verifying & creating…' : 'Create agent'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
