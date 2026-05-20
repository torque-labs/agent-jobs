import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatDistanceToNow } from 'date-fns';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getWebhook, listWebhookDeliveries } from '@/lib/db';
import { WebhookActions } from './webhook-actions';

export const dynamic = 'force-dynamic';

function fmtRel(d: Date | null | undefined): string {
  if (!d) return '—';
  return formatDistanceToNow(new Date(d), { addSuffix: true });
}

function statusBadge(status: number | null): React.ReactNode {
  if (status === null) return <Badge variant="secondary" className="text-[10px]">—</Badge>;
  if (status >= 200 && status < 300) {
    return (
      <Badge className="bg-green-500/15 text-green-700 dark:text-green-400 text-[10px]">
        {status}
      </Badge>
    );
  }
  return <Badge variant="destructive" className="text-[10px]">{status}</Badge>;
}

function stateBadge(opts: {
  delivered: boolean;
  deadLettered: boolean;
  pending: boolean;
}): React.ReactNode {
  if (opts.delivered) {
    return (
      <Badge className="bg-green-500/15 text-green-700 dark:text-green-400 text-[10px]">
        delivered
      </Badge>
    );
  }
  if (opts.deadLettered) {
    return <Badge variant="destructive" className="text-[10px]">dead-lettered</Badge>;
  }
  if (opts.pending) {
    return <Badge variant="secondary" className="text-[10px]">pending</Badge>;
  }
  return <Badge variant="outline" className="text-[10px]">unknown</Badge>;
}

export default async function WebhookDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const hook = await getWebhook(id);
  if (!hook) notFound();

  const deliveries = await listWebhookDeliveries(id, 50).catch(() => []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs text-muted-foreground">
            <Link href="/settings/webhooks" className="hover:underline">
              Webhooks
            </Link>{' '}
            / <span className="font-mono">{hook.id.slice(0, 8)}</span>
          </div>
          <h2 className="font-heading text-lg font-semibold">{hook.name}</h2>
          <p className="break-all font-mono text-xs text-muted-foreground">{hook.url}</p>
        </div>
        <WebhookActions id={hook.id} enabled={hook.enabled} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Events</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {hook.events.map((e) => (
                <Badge key={e} variant="secondary" className="text-[10px]">
                  {e}
                </Badge>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">Status</div>
            <div className="mt-1">
              {hook.enabled ? (
                <Badge className="bg-green-500/15 text-green-700 dark:text-green-400 text-[10px]">
                  enabled
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px]">disabled</Badge>
              )}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">Created</div>
            <div>{fmtRel(hook.created_at)}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent deliveries</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempt</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Error</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    No deliveries yet.
                  </TableCell>
                </TableRow>
              ) : (
                deliveries.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {d.event}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {stateBadge({
                        delivered: d.delivered_at !== null,
                        deadLettered: d.dead_lettered_at !== null,
                        pending: d.delivered_at === null && d.dead_lettered_at === null,
                      })}
                    </TableCell>
                    <TableCell>{statusBadge(d.last_status)}</TableCell>
                    <TableCell className="text-xs">{d.attempt}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {fmtRel(d.created_at)}
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate text-xs text-muted-foreground">
                      {d.last_error ?? '—'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
