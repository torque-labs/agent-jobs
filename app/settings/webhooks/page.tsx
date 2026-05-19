import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listWebhooks, listWebhookDeliveries } from '@/lib/db';
import { WEBHOOK_EVENTS } from '@/lib/events';
import type { Webhook } from '@/lib/types';
import { CreateWebhookDialog } from './create-webhook-dialog';

export const dynamic = 'force-dynamic';

type WebhookWithLast = Omit<Webhook, 'secret'> & { last_delivery_at: Date | null };

async function loadWebhooks(): Promise<WebhookWithLast[]> {
  try {
    const hooks = await listWebhooks();
    // Fetch last delivery per hook (small N, fine to do serially in v1).
    const enriched = await Promise.all(
      hooks.map(async (h) => {
        let last: Date | null = null;
        try {
          const recent = await listWebhookDeliveries(h.id, 1);
          last = recent[0]?.created_at ?? null;
        } catch {
          last = null;
        }
        const { secret: _s, ...rest } = h;
        return { ...rest, last_delivery_at: last };
      }),
    );
    return enriched;
  } catch (err) {
    console.error('[settings/webhooks] listWebhooks failed:', err);
    return [];
  }
}

function fmtRel(d: Date | null): string {
  if (!d) return '—';
  return formatDistanceToNow(new Date(d), { addSuffix: true });
}

export default async function WebhooksPage() {
  const hooks = await loadWebhooks();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-heading text-lg font-semibold">Webhooks</h2>
          <p className="text-sm text-muted-foreground">
            Outbound HTTP delivery on run events. HMAC-signed, retried 4× with backoff.
          </p>
        </div>
        <CreateWebhookDialog events={WEBHOOK_EVENTS} />
      </div>

      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>Events</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>Last delivery</TableHead>
              <TableHead className="w-12 text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {hooks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No webhooks yet.
                </TableCell>
              </TableRow>
            ) : (
              hooks.map((h) => (
                <TableRow key={h.id}>
                  <TableCell className="font-medium">
                    <Link href={`/settings/webhooks/${h.id}`} className="hover:underline">
                      {h.name}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-[260px] truncate font-mono text-xs text-muted-foreground">
                    {h.url}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {h.events.map((e) => (
                        <Badge key={e} variant="secondary" className="text-[10px]">
                          {e}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {h.enabled ? (
                      <Badge className="bg-green-500/15 text-green-700 dark:text-green-400 text-[10px]">
                        enabled
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">disabled</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {fmtRel(h.last_delivery_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/settings/webhooks/${h.id}`}
                      className="text-xs text-muted-foreground hover:underline"
                    >
                      View
                    </Link>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
