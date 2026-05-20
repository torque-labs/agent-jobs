'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { CopyIcon, Loader2Icon, RefreshCcwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

type Props = {
  jobId: string;
  token: string | null;
  enabled: boolean;
};

export function TriggerSection({ jobId, token: initialToken, enabled: initialEnabled }: Props) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(initialToken);
  const [enabled, setEnabled] = useState<boolean>(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState<string>('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setOrigin(window.location.origin);
    }
  }, []);

  const triggerUrl = useMemo(() => {
    if (!token) return '';
    const base = origin || 'https://jobs.coolify.torque.so';
    return `${base}/api/v1/triggers/${token}`;
  }, [origin, token]);

  async function enable() {
    setBusy(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/trigger`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `${res.status}`);
      }
      const body = (await res.json()) as { token: string; enabled: boolean };
      setToken(body.token);
      setEnabled(body.enabled);
      toast.success('Trigger enabled');
      router.refresh();
    } catch (err) {
      toast.error(`Failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    setBusy(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/trigger`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `${res.status}`);
      }
      const body = (await res.json()) as { token: string | null; enabled: boolean };
      setToken(body.token);
      setEnabled(body.enabled);
      toast.success(body.enabled ? 'Enabled' : 'Disabled');
      router.refresh();
    } catch (err) {
      toast.error(`Failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    setBusy(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/trigger`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rotate: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `${res.status}`);
      }
      const body = (await res.json()) as { token: string | null; enabled: boolean };
      setToken(body.token);
      setEnabled(body.enabled);
      toast.success('Token rotated');
      router.refresh();
    } catch (err) {
      toast.error(`Failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!triggerUrl) return;
    try {
      await navigator.clipboard.writeText(triggerUrl);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed — select and copy manually');
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle>Trigger</CardTitle>
        {token ? (
          enabled ? (
            <Badge className="bg-green-500/15 text-green-700 dark:text-green-400 text-[10px]">
              enabled
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px]">disabled</Badge>
          )
        ) : (
          <Badge variant="outline" className="text-[10px]">not configured</Badge>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {token ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="trigger-url" className="text-xs uppercase text-muted-foreground">
                Trigger URL
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="trigger-url"
                  readOnly
                  value={triggerUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="font-mono text-xs"
                />
                <Button type="button" variant="outline" size="icon" onClick={copy}>
                  <CopyIcon />
                  <span className="sr-only">Copy</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                POST any JSON body. Template references like{' '}
                <code className="font-mono">{'{{trigger.body.foo}}'}</code> and{' '}
                <code className="font-mono">{'{{trigger.headers.x-custom}}'}</code>{' '}
                resolve at step time.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={toggle} disabled={busy}>
                {busy && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
                {enabled ? 'Disable trigger' : 'Enable trigger'}
              </Button>
              <Button type="button" variant="outline" onClick={rotate} disabled={busy}>
                <RefreshCcwIcon data-icon="inline-start" />
                Rotate token
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              Enable to receive POST calls and template{' '}
              <code className="font-mono">{'{{trigger.body}}'}</code> /{' '}
              <code className="font-mono">{'{{trigger.headers.*}}'}</code>{' '}
              into step prompts.
            </p>
            <div>
              <Button type="button" onClick={enable} disabled={busy}>
                {busy && <Loader2Icon className="animate-spin" data-icon="inline-start" />}
                Enable trigger
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
