'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2Icon, PlayIcon, TrashIcon } from 'lucide-react';
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

export type RoutineView = {
  id: string;
  name: string;
  cron: string;
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

function buildCron(freq: string, weekday: string, time: string): string {
  const [h, m] = time.split(':');
  const HH = Number(h);
  const MM = Number(m);
  if (freq === 'weekly') return `${MM} ${HH} * * ${weekday}`;
  return `${MM} ${HH} * * *`;
}

export function RoutinesSection({ id, initial }: { id: string; initial: RoutineView[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  // create form state
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [channel, setChannel] = useState<'telegram' | 'slack'>('telegram');
  const [freq, setFreq] = useState('daily');
  const [weekday, setWeekday] = useState('1');
  const [time, setTime] = useState('09:00');
  const [advanced, setAdvanced] = useState(false);
  const [rawCron, setRawCron] = useState('0 9 * * *');
  const [creating, setCreating] = useState(false);

  async function create() {
    if (!name.trim() || !prompt.trim()) {
      toast.error('Name and prompt are required');
      return;
    }
    const cron = advanced ? rawCron.trim() : buildCron(freq, weekday, time);
    setCreating(true);
    try {
      const res = await fetch(`/api/internal/agents/${id}/routines`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), prompt: prompt.trim(), channel, cron }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => null);
        toast.error(b?.error ?? `Create failed (${res.status})`);
        return;
      }
      toast.success('Routine created');
      setName('');
      setPrompt('');
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

      {/* existing routines */}
      {initial.length > 0 && (
        <div className="mb-4 flex flex-col gap-2">
          {initial.map((r) => (
            <div key={r.id} className="flex items-center gap-3 rounded-md border bg-background px-3 py-2 text-xs">
              <div className="flex-1">
                <div className="font-medium">
                  {r.name} <span className="text-muted-foreground">· {r.channel}</span>
                </div>
                <div className="text-muted-foreground">
                  {humanCron(r.cron)}
                  {r.last_status ? ` · last: ${r.last_status}` : ''}
                </div>
              </div>
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

      {/* create form */}
      <div className="flex flex-col gap-3 rounded-md border border-dashed p-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="r-name" className="text-xs">Name</Label>
            <Input id="r-name" placeholder="Daily digest" value={name} onChange={(e) => setName(e.target.value)} disabled={creating} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Channel</Label>
            <Select value={channel} onValueChange={(v) => setChannel(v as 'telegram' | 'slack')} disabled={creating}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="telegram">Telegram</SelectItem>
                <SelectItem value="slack">Slack</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {advanced ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="r-cron" className="text-xs">Cron (UTC)</Label>
            <Input id="r-cron" value={rawCron} onChange={(e) => setRawCron(e.target.value)} disabled={creating} className="font-mono text-xs" />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Frequency</Label>
              <Select value={freq} onValueChange={setFreq} disabled={creating}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {freq === 'weekly' && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">Day</Label>
                <Select value={weekday} onValueChange={setWeekday} disabled={creating}>
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
              <Label htmlFor="r-time" className="text-xs">Time (UTC)</Label>
              <Input id="r-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={creating} />
            </div>
          </div>
        )}

        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} disabled={creating} />
          Advanced: raw cron
        </label>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="r-prompt" className="text-xs">Prompt</Label>
          <Textarea
            id="r-prompt"
            rows={3}
            placeholder="Post a concise daily digest: the current leaderboard top 10 and any campaign changes since yesterday."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={creating}
            className="text-xs"
          />
        </div>

        <div>
          <Button type="button" onClick={create} disabled={creating}>
            {creating && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
            Add routine
          </Button>
        </div>
      </div>
    </section>
  );
}
