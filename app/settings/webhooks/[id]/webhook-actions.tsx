'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Loader2Icon, TrashIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
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

export function WebhookActions({ id, enabled }: { id: string; enabled: boolean }) {
  const router = useRouter();
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function toggleEnabled() {
    setToggling(true);
    try {
      const res = await fetch(`/api/internal/webhooks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `${res.status}`);
      }
      toast.success(enabled ? 'Disabled' : 'Enabled');
      router.refresh();
    } catch (err) {
      toast.error(`Failed: ${(err as Error).message}`);
    } finally {
      setToggling(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/internal/webhooks/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `${res.status}`);
      }
      toast.success('Deleted');
      router.push('/settings/webhooks');
    } catch (err) {
      toast.error(`Failed: ${(err as Error).message}`);
      setDeleting(false);
    }
  }

  return (
    <div className="flex gap-2">
      <Button
        variant="outline"
        type="button"
        onClick={toggleEnabled}
        disabled={toggling}
      >
        {toggling && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
        {enabled ? 'Disable' : 'Enable'}
      </Button>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="destructive">
            <TrashIcon data-icon="inline-start" />
            Delete
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this webhook?</DialogTitle>
            <DialogDescription>
              Past deliveries will be removed too. This cannot be undone.
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
    </div>
  );
}
