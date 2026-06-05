'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2Icon, TrashIcon, XIcon } from 'lucide-react';
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
import { getAllModels } from '@/lib/models';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

type Status = 'active' | 'paused' | 'disabled';

const MODELS = getAllModels().filter((m) => m.provider === 'openrouter');

async function patchAgent(id: string, body: unknown): Promise<boolean> {
  const res = await fetch(`/api/internal/agents/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => null);
    toast.error(b?.error ?? `Update failed (${res.status})`);
    return false;
  }
  return true;
}

// ---- Edit model / soul / status / data sources ----
export function AgentControls({
  id,
  model: initModel,
  soul: initSoul,
  status: initStatus,
  ingester: initIngester,
  helius: initHelius,
}: {
  id: string;
  model: string;
  soul: string;
  status: Status;
  ingester: boolean;
  helius: boolean;
}) {
  const router = useRouter();
  const [model, setModel] = useState(initModel);
  const [soul, setSoul] = useState(initSoul);
  const [status, setStatus] = useState<Status>(initStatus);
  const [ingester, setIngester] = useState(initIngester);
  const [helius, setHelius] = useState(initHelius);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const sources: Array<{ type: string; label: string; value: string }> = [];
    if (ingester) sources.push({ type: 'ingester', label: 'Torque Ingester', value: 'enabled' });
    if (helius) sources.push({ type: 'helius', label: 'Helius', value: 'enabled' });
    const ok = await patchAgent(id, {
      model: model.trim(),
      soul: soul.trim(),
      status,
      data_sources: sources,
    });
    setSaving(false);
    if (ok) {
      toast.success('Saved');
      router.refresh();
    }
  }

  return (
    <section className="rounded-lg border p-4">
      <h3 className="mb-3 text-sm font-semibold">Configuration</h3>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="e-model">Model</Label>
            <Select value={model} onValueChange={setModel} disabled={saving}>
              <SelectTrigger id="e-model" className="w-full">
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
            <Label htmlFor="e-status">Status</Label>
            <select
              id="e-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as Status)}
              disabled={saving}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="active">active</option>
              <option value="paused">paused</option>
              <option value="disabled">disabled</option>
            </select>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="e-soul">Soul / system prompt</Label>
          <Textarea
            id="e-soul"
            rows={8}
            value={soul}
            onChange={(e) => setSoul(e.target.value)}
            className="text-xs"
            disabled={saving}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label>Data sources</Label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={ingester}
              onChange={(e) => setIngester(e.target.checked)}
              disabled={saving}
            />
            Torque Ingester (raw on-chain swap data, read-only)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={helius}
              onChange={(e) => setHelius(e.target.checked)}
              disabled={saving}
            />
            Helius (wallet history, holders, fund flow — Solana, read-only)
          </label>
        </div>
        <div>
          <Button type="button" onClick={save} disabled={saving}>
            {saving && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
            Save changes
          </Button>
        </div>
      </div>
    </section>
  );
}

// ---- Enroll / remove Telegram chat-ids + Slack channel-ids ----
function IdList({
  id,
  platform,
  label,
  placeholder,
  initial,
}: {
  id: string;
  platform: 'telegram' | 'slack';
  label: string;
  placeholder: string;
  initial: string[];
}) {
  const router = useRouter();
  const [ids, setIds] = useState<string[]>(initial);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  async function commit(next: string[]) {
    setBusy(true);
    const key = platform === 'telegram' ? 'allowed_chats' : 'allowed_channels';
    const ok = await patchAgent(id, { channels: { [platform]: { [key]: next } } });
    setBusy(false);
    if (ok) {
      setIds(next);
      toast.success('Updated');
      router.refresh();
    }
  }

  function add() {
    const v = draft.trim();
    if (!v) return;
    if (ids.includes(v)) {
      toast.error('Already enrolled');
      return;
    }
    setDraft('');
    void commit([...ids, v]);
  }

  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      {ids.length === 0 ? (
        <p className="text-xs text-muted-foreground">None enrolled.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {ids.map((cid) => (
            <div
              key={cid}
              className="flex items-center justify-between rounded-md border bg-background px-2 py-1.5 text-xs"
            >
              <span className="font-mono">{cid}</span>
              <button
                type="button"
                onClick={() => void commit(ids.filter((x) => x !== cid))}
                disabled={busy}
                className="text-muted-foreground hover:text-destructive"
                aria-label="Remove"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          disabled={busy}
          className="font-mono text-xs"
        />
        <Button type="button" variant="outline" onClick={add} disabled={busy}>
          Add
        </Button>
      </div>
    </div>
  );
}

export function ChannelEnrollment({
  id,
  telegramChats,
  slackChannels,
}: {
  id: string;
  telegramChats: string[];
  slackChannels: string[];
}) {
  return (
    <section className="rounded-lg border p-4">
      <h3 className="mb-1 text-sm font-semibold">Channels</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Enroll the chat / channel ids that route to this agent on the shared bot. A given
        id may belong to only one agent.
      </p>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <IdList
          id={id}
          platform="telegram"
          label="Telegram chat ids"
          placeholder="-1009998887776"
          initial={telegramChats}
        />
        <IdList
          id={id}
          platform="slack"
          label="Slack channel ids"
          placeholder="C0XXXXXXX"
          initial={slackChannels}
        />
      </div>
    </section>
  );
}

// ---- Inline test turn ----
export function TestChat({ id }: { id: string }) {
  const [msg, setMsg] = useState('');
  const [running, setRunning] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [tools, setTools] = useState<string[]>([]);

  async function send() {
    if (!msg.trim()) return;
    setRunning(true);
    setReply(null);
    try {
      const res = await fetch(`/api/internal/agents/${id}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: msg.trim() }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error ?? `Failed (${res.status})`);
        return;
      }
      setReply(body.reply ?? '(no reply)');
      setTools(body.toolsUsed ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="rounded-lg border p-4">
      <h3 className="mb-1 text-sm font-semibold">Test</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Run a turn against this agent (scoped Torque token), without a channel.
      </p>
      <div className="flex flex-col gap-2">
        <Textarea
          rows={2}
          placeholder="Show me the leaderboard"
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          disabled={running}
          className="text-xs"
        />
        <div>
          <Button type="button" onClick={send} disabled={running}>
            {running && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
            {running ? 'Running…' : 'Send'}
          </Button>
        </div>
        {reply !== null && (
          <div className="rounded-md border bg-muted/40 p-3 text-xs">
            <div className="whitespace-pre-wrap">{reply}</div>
            {tools.length > 0 && (
              <div className="mt-2 font-mono text-[11px] text-muted-foreground">
                tools: {tools.join(', ')}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// ---- Delete ----
export function DeleteAgentButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/internal/agents/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        const b = await res.json().catch(() => null);
        throw new Error(b?.error ?? `${res.status}`);
      }
      toast.success('Deleted');
      router.push('/agents');
    } catch (err) {
      toast.error(`Failed: ${(err as Error).message}`);
      setDeleting(false);
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="destructive">
          <TrashIcon data-icon="inline-start" />
          Delete agent
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>
            This removes the agent, its stored Torque token, and channel routing. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" type="button">Cancel</Button>
          </DialogClose>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
