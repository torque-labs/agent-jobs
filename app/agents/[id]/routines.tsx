'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2Icon, PlayIcon, TrashIcon, PencilIcon, EyeIcon } from 'lucide-react';
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

export type RoutineView = {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  channel: 'telegram' | 'slack';
  enabled: boolean;
  last_run_at: string | null;
  last_status: string | null;
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function humanCron(cron: string): string {
  const m = cron.match(/^(\d+) (\d+) \* \* (\*|[0-6])$/);
  if (!m) return `${cron} (UTC)`;
  const mm = m[1].padStart(2, '0');
  const hh = m[2].padStart(2, '0');
  if (m[3] === '*') return `Daily at ${hh}:${mm} UTC`;
  return `Weekly on ${DAYS[Number(m[3])]} at ${hh}:${mm} UTC`;
}

type FormState = {
  name: string;
  channel: 'telegram' | 'slack';
  freq: string;
  weekday: string;
  time: string;
  advanced: boolean;
  rawCron: string;
  prompt: string;
};

function emptyForm(): FormState {
  return {
    name: '',
    channel: 'telegram',
    freq: 'daily',
    weekday: '1',
    time: '09:00',
    advanced: false,
    rawCron: '0 9 * * *',
    prompt: '',
  };
}

function formFromRoutine(r: RoutineView): FormState {
  const m = r.cron.match(/^(\d+) (\d+) \* \* (\*|[0-6])$/);
  if (m) {
    const time = `${m[2].padStart(2, '0')}:${m[1].padStart(2, '0')}`;
    return {
      name: r.name,
      channel: r.channel,
      prompt: r.prompt,
      freq: m[3] === '*' ? 'daily' : 'weekly',
      weekday: m[3] === '*' ? '1' : m[3],
      time,
      advanced: false,
      rawCron: r.cron,
    };
  }
  return {
    name: r.name,
    channel: r.channel,
    prompt: r.prompt,
    freq: 'daily',
    weekday: '1',
    time: '09:00',
    advanced: true,
    rawCron: r.cron,
  };
}

function cronOf(f: FormState): string {
  if (f.advanced) return f.rawCron.trim();
  const [h, m] = f.time.split(':');
  const HH = Number(h);
  const MM = Number(m);
  return f.freq === 'weekly' ? `${MM} ${HH} * * ${f.weekday}` : `${MM} ${HH} * * *`;
}

/** Shared field set for create + edit, with an inline "Preview output" runner. */
function RoutineFields({
  tenantId,
  value,
  onChange,
  disabled,
}: {
  tenantId: string;
  value: FormState;
  onChange: (patch: Partial<FormState>) => void;
  disabled: boolean;
}) {
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  async function previewOutput() {
    if (!value.prompt.trim()) {
      toast.error('Add a prompt to preview');
      return;
    }
    setPreviewing(true);
    setPreview(null);
    try {
      const res = await fetch(`/api/internal/agents/${tenantId}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: value.prompt.trim() }),
      });
      const b = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(b?.error ?? `Preview failed (${res.status})`);
        return;
      }
      setPreview(b.reply ?? '(no output)');
    } finally {
      setPreviewing(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Name</Label>
          <Input
            placeholder="Daily digest"
            value={value.name}
            onChange={(e) => onChange({ name: e.target.value })}
            disabled={disabled}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Channel</Label>
          <Select
            value={value.channel}
            onValueChange={(v) => onChange({ channel: v as 'telegram' | 'slack' })}
            disabled={disabled}
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="telegram">Telegram</SelectItem>
              <SelectItem value="slack">Slack</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {value.advanced ? (
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Cron (UTC)</Label>
          <Input
            value={value.rawCron}
            onChange={(e) => onChange({ rawCron: e.target.value })}
            disabled={disabled}
            className="font-mono text-xs"
          />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Frequency</Label>
            <Select value={value.freq} onValueChange={(v) => onChange({ freq: v })} disabled={disabled}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">Daily</SelectItem>
                <SelectItem value="weekly">Weekly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {value.freq === 'weekly' && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Day</Label>
              <Select value={value.weekday} onValueChange={(v) => onChange({ weekday: v })} disabled={disabled}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DAYS.map((d, i) => (
                    <SelectItem key={d} value={String(i)}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Time (UTC)</Label>
            <Input type="time" value={value.time} onChange={(e) => onChange({ time: e.target.value })} disabled={disabled} />
          </div>
        </div>
      )}

      <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          checked={value.advanced}
          onChange={(e) => onChange({ advanced: e.target.checked })}
          disabled={disabled}
        />
        Advanced: raw cron
      </label>

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs">Prompt</Label>
        <Textarea
          rows={3}
          placeholder="Post a concise daily digest: the current leaderboard top 10 and any campaign changes since yesterday."
          value={value.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          disabled={disabled}
          className="text-xs"
        />
      </div>

      <div>
        <Button type="button" variant="outline" size="sm" onClick={previewOutput} disabled={disabled || previewing}>
          {previewing ? <Loader2Icon className="animate-spin" data-icon="inline-start" /> : <EyeIcon data-icon="inline-start" />}
          Preview output
        </Button>
      </div>
      {preview !== null && (
        <div className="rounded-md border bg-muted/40 p-3 text-xs whitespace-pre-wrap">
          {preview}
          <div className="mt-2 text-[11px] text-muted-foreground">
            Preview only — not posted to the channel.
          </div>
        </div>
      )}
    </div>
  );
}

function EditRoutineDialog({ tenantId, routine }: { tenantId: string; routine: RoutineView }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<FormState>(() => formFromRoutine(routine));

  function patch(p: Partial<FormState>) {
    setForm((f) => ({ ...f, ...p }));
  }

  async function save() {
    if (!form.name.trim() || !form.prompt.trim()) {
      toast.error('Name and prompt are required');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/internal/agents/${tenantId}/routines/${routine.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          channel: form.channel,
          cron: cronOf(form),
          prompt: form.prompt.trim(),
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        toast.error(b?.error ?? `Save failed (${res.status})`);
        return;
      }
      toast.success('Routine updated');
      setOpen(false);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setForm(formFromRoutine(routine)); // reset to current on open
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <PencilIcon data-icon="inline-start" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit routine</DialogTitle>
        </DialogHeader>
        <RoutineFields tenantId={tenantId} value={form} onChange={patch} disabled={saving} />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={saving}>
            {saving && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RoutinesSection({ id, initial }: { id: string; initial: RoutineView[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [creating, setCreating] = useState(false);

  function patch(p: Partial<FormState>) {
    setForm((f) => ({ ...f, ...p }));
  }

  async function create() {
    if (!form.name.trim() || !form.prompt.trim()) {
      toast.error('Name and prompt are required');
      return;
    }
    setCreating(true);
    try {
      const res = await fetch(`/api/internal/agents/${id}/routines`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          prompt: form.prompt.trim(),
          channel: form.channel,
          cron: cronOf(form),
        }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        toast.error(b?.error ?? `Create failed (${res.status})`);
        return;
      }
      toast.success('Routine created');
      setForm(emptyForm());
      router.refresh();
    } finally {
      setCreating(false);
    }
  }

  async function toggle(r: RoutineView) {
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/internal/agents/${id}/routines/${r.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !r.enabled }),
      });
      if (!res.ok) {
        toast.error('Update failed');
        return;
      }
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function runNow(r: RoutineView) {
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/internal/agents/${id}/routines/${r.id}/run`, { method: 'POST' });
      const b = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(b?.detail ? `Failed: ${b.detail}` : `Failed (${res.status})`);
        return;
      }
      toast.success(`Ran: ${b?.detail ?? 'ok'}`);
      router.refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(r: RoutineView) {
    setBusyId(r.id);
    try {
      const res = await fetch(`/api/internal/agents/${id}/routines/${r.id}`, { method: 'DELETE' });
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
      <h3 className="mb-1 text-sm font-semibold">Routines</h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Scheduled prompts (e.g. a daily digest). At the scheduled time the agent runs the
        prompt with its own tools and posts the reply to the chosen channel.{' '}
        <span className="font-medium">All schedules are UTC.</span>
      </p>

      {initial.length > 0 && (
        <div className="mb-4 flex flex-col gap-2">
          {initial.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border bg-background px-3 py-2 text-xs">
              <div className="min-w-[180px] flex-1">
                <div className="font-medium">
                  {r.name} <span className="text-muted-foreground">· {r.channel}</span>
                  {!r.enabled && <span className="ml-2 text-muted-foreground">(disabled)</span>}
                </div>
                <div className="text-muted-foreground">
                  {humanCron(r.cron)}
                  {r.last_status ? ` · last: ${r.last_status}` : ''}
                </div>
              </div>
              <EditRoutineDialog tenantId={id} routine={r} />
              <Button variant="outline" size="sm" disabled={busyId === r.id} onClick={() => runNow(r)}>
                {busyId === r.id ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
                Run now
              </Button>
              <Button variant="outline" size="sm" disabled={busyId === r.id} onClick={() => toggle(r)}>
                {r.enabled ? 'Disable' : 'Enable'}
              </Button>
              <button
                type="button"
                disabled={busyId === r.id}
                onClick={() => remove(r)}
                className="text-muted-foreground hover:text-destructive"
                aria-label="Delete routine"
              >
                <TrashIcon className="size-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-md border border-dashed p-3">
        <RoutineFields tenantId={id} value={form} onChange={patch} disabled={creating} />
        <div className="mt-3">
          <Button type="button" onClick={create} disabled={creating}>
            {creating && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
            Add routine
          </Button>
        </div>
      </div>
    </section>
  );
}
