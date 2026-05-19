'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { toast } from 'sonner';

type Props = {
  scopes: readonly string[];
};

export function CreateKeyDialog({ scopes }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set(['jobs:read']));
  const [submitting, setSubmitting] = useState(false);
  const [createdPlain, setCreatedPlain] = useState<string | null>(null);

  function toggleScope(s: string) {
    const next = new Set(selected);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setSelected(next);
  }

  function reset() {
    setName('');
    setSelected(new Set(['jobs:read']));
    setCreatedPlain(null);
    setSubmitting(false);
  }

  async function submit() {
    if (!name.trim()) {
      toast.error('Name required');
      return;
    }
    if (selected.size === 0) {
      toast.error('Pick at least one scope');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/internal/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), scopes: Array.from(selected) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? `Create failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      const body = (await res.json()) as { plain_key: string };
      setCreatedPlain(body.plain_key);
      setSubmitting(false);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  async function copyKey() {
    if (!createdPlain) return;
    try {
      await navigator.clipboard.writeText(createdPlain);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed — select and copy manually');
    }
  }

  function close() {
    setOpen(false);
    setTimeout(reset, 200);
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
        <Button>+ New key</Button>
      </DialogTrigger>
      <DialogContent>
        {createdPlain ? (
          <>
            <DialogHeader>
              <DialogTitle>Save your key now</DialogTitle>
              <DialogDescription>
                This is the only time we&rsquo;ll show the full key. Store it in a secret manager.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Input
                readOnly
                value={createdPlain}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
              />
              <Button type="button" variant="outline" onClick={copyKey}>
                Copy to clipboard
              </Button>
            </div>
            <DialogFooter>
              <Button type="button" onClick={close}>
                I&rsquo;ve saved this
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>
                Pick the narrowest set of scopes this key needs.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="key-name">Name</Label>
                <Input
                  id="key-name"
                  placeholder="e.g. trump-leaderboard-cron"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={submitting}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label>Scopes</Label>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {scopes.map((s) => (
                    <label
                      key={s}
                      className="flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(s)}
                        onChange={() => toggleScope(s)}
                        disabled={submitting}
                      />
                      <span className="font-mono">{s}</span>
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
                {submitting ? 'Creating…' : 'Create key'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
