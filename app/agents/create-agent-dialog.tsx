'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { getAllModels } from '@/lib/models';
import { AGENT_TEMPLATES, getTemplate, renderSoul } from '@/lib/agent-templates';

const MODELS = getAllModels().filter((m) => m.provider === 'openrouter');
const DEFAULT_TEMPLATE = 'cs-agent';

export function CreateAgentDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE);
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [token, setToken] = useState('');
  const [model, setModel] = useState(getTemplate(DEFAULT_TEMPLATE)?.model ?? 'anthropic/claude-sonnet-4.6');
  const [soul, setSoul] = useState(renderSoul(getTemplate(DEFAULT_TEMPLATE)!, ''));
  const [soulDirty, setSoulDirty] = useState(false);
  const [ingester, setIngester] = useState(false);

  function reset() {
    const tpl = getTemplate(DEFAULT_TEMPLATE)!;
    setTemplateId(DEFAULT_TEMPLATE);
    setSlug('');
    setDisplayName('');
    setProjectId('');
    setToken('');
    setModel(tpl.model);
    setSoul(renderSoul(tpl, ''));
    setSoulDirty(false);
    setIngester(false);
    setSubmitting(false);
  }

  function close() {
    setOpen(false);
    setTimeout(reset, 200);
  }

  function applyTemplate(id: string) {
    setTemplateId(id);
    const tpl = getTemplate(id);
    if (!tpl) return;
    setModel(tpl.model);
    setSoul(renderSoul(tpl, displayName));
    setSoulDirty(false);
  }

  function onDisplayNameChange(v: string) {
    setDisplayName(v);
    // Keep the soul in sync with the name until the operator hand-edits it.
    if (!soulDirty) {
      const tpl = getTemplate(templateId);
      if (tpl && tpl.id !== 'blank') setSoul(renderSoul(tpl, v));
    }
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
          model: model.trim(),
          soul: soul.trim(),
          data_sources: ingester
            ? [{ type: 'ingester', label: 'Torque Ingester', value: 'enabled' }]
            : null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? `Create failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      const created = (await res.json()) as { id: string };

      // Auto-create the template's default routines (inert until channels enrolled).
      const tpl = getTemplate(templateId);
      const routines = tpl?.defaultRoutines ?? [];
      let routineFails = 0;
      for (const r of routines) {
        const rr = await fetch(`/api/internal/agents/${created.id}/routines`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(r),
        }).catch(() => null);
        if (!rr || !rr.ok) routineFails++;
      }

      if (routineFails > 0) {
        toast.warning(`Agent created; ${routineFails} default routine(s) failed — add them manually.`);
      } else {
        toast.success(routines.length ? `Agent created with ${routines.length} routine(s)` : 'Agent created');
      }
      router.refresh();
      close();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  const tpl = getTemplate(templateId);

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
            Pick a template to preset the persona + model, then add the project + scoped
            token. The token must be scoped to exactly this project — verified server-side.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="a-template">Template</Label>
            <Select value={templateId} onValueChange={applyTemplate} disabled={submitting}>
              <SelectTrigger id="a-template" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AGENT_TEMPLATES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {tpl?.description && (
              <p className="text-[11px] text-muted-foreground">{tpl.description}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="a-slug">Slug</Label>
              <Input id="a-slug" placeholder="mplx-s1" value={slug} onChange={(e) => setSlug(e.target.value)} disabled={submitting} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="a-name">Display name</Label>
              <Input id="a-name" placeholder="MPLX S1" value={displayName} onChange={(e) => onDisplayNameChange(e.target.value)} disabled={submitting} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="a-project">Torque project id</Label>
            <Input id="a-project" placeholder="cmmcg6rpt04xgip1iz1paltfv" value={projectId} onChange={(e) => setProjectId(e.target.value)} disabled={submitting} className="font-mono text-xs" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="a-token">Torque MCP token (scoped to this project)</Label>
            <Input id="a-token" type="password" placeholder="eyJhbGciOi…" value={token} onChange={(e) => setToken(e.target.value)} disabled={submitting} className="font-mono text-xs" />
            <p className="text-[11px] text-muted-foreground">Write-only — stored server-side, never shown again.</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="a-model">Model</Label>
            <Select value={model} onValueChange={setModel} disabled={submitting}>
              <SelectTrigger id="a-model" className="w-full">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {MODELS.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="a-soul">Soul / system prompt</Label>
            <Textarea
              id="a-soul"
              rows={7}
              placeholder="You are the … incentive assistant — you represent … and nothing else."
              value={soul}
              onChange={(e) => {
                setSoul(e.target.value);
                setSoulDirty(true);
              }}
              disabled={submitting}
              className="text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              {soulDirty ? 'Edited manually.' : 'Auto-filled from the template + display name.'}
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={ingester} onChange={(e) => setIngester(e.target.checked)} disabled={submitting} />
            Enable Torque Ingester (raw on-chain swap data, read-only)
          </label>
          {(tpl?.defaultRoutines?.length ?? 0) > 0 && (
            <p className="text-[11px] text-muted-foreground">
              This template adds {tpl!.defaultRoutines!.length} default routine(s) (e.g. a daily digest) — inert until you enroll a channel.
            </p>
          )}
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
