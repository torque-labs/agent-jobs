'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

type Props = {
  events: readonly string[];
};

export function CreateWebhookDialog({ events }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set(['run.completed']));
  const [submitting, setSubmitting] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  function reset() {
    setName('');
    setUrl('');
    setSelected(new Set(['run.completed']));
    setCreatedSecret(null);
    setSubmitting(false);
  }

  function close() {
    setOpen(false);
    setTimeout(reset, 200);
  }

  function toggle(e: string) {
    const next = new Set(selected);
    if (next.has(e)) next.delete(e);
    else next.add(e);
    setSelected(next);
  }

  async function submit() {
    if (!name.trim()) {
      toast.error('Name required');
      return;
    }
    if (!url.trim()) {
      toast.error('URL required');
      return;
    }
    if (selected.size === 0) {
      toast.error('Pick at least one event');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/internal/webhooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          url: url.trim(),
          events: Array.from(selected),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? `Create failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      const body = (await res.json()) as { secret: string };
      setCreatedSecret(body.secret);
      setSubmitting(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  async function copySecret() {
    if (!createdSecret) return;
    try {
      await navigator.clipboard.writeText(createdSecret);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed — select and copy manually');
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
        <Button>+ New webhook</Button>
      </DialogTrigger>
      <DialogContent>
        {createdSecret ? (
          <>
            <DialogHeader>
              <DialogTitle>Save your signing secret</DialogTitle>
              <DialogDescription>
                This is the only time we&rsquo;ll show the full secret. Use it to verify the{' '}
                <code className="font-mono text-[11px]">X-AgentJobs-Signature</code> header (HMAC-SHA256 of the body).
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Input
                readOnly
                value={createdSecret}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
              />
              <Button type="button" variant="outline" onClick={copySecret}>
                Copy to clipboard
              </Button>
            </div>
            <DialogFooter>
              <Button type="button" onClick={close}>I&rsquo;ve saved this</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create webhook</DialogTitle>
              <DialogDescription>
                Pick the events to subscribe to. We&rsquo;ll POST a signed JSON payload
                to your URL with up to 4 retry attempts (30s, 5m, 30m, 3h backoff).
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="hook-name">Name</Label>
                <Input
                  id="hook-name"
                  placeholder="e.g. trump-digest-completed-slack"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="hook-url">URL</Label>
                <Input
                  id="hook-url"
                  placeholder="https://webhook.site/abc-123"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>Events</Label>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {events.map((e) => (
                    <label
                      key={e}
                      className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(e)}
                        onChange={() => toggle(e)}
                        disabled={submitting}
                      />
                      <span className="font-mono">{e}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close} disabled={submitting}>
                Cancel
              </Button>
              <Button type="button" onClick={submit} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create webhook'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
