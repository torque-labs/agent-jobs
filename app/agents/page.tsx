import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { listTenants, toPublicTenant } from '@/lib/tenants';
import { getUsageSummaries, type UsageSummary } from '@/lib/tenant-usage';
import type { PublicTenant } from '@/lib/types';
import { CreateAgentDialog } from './create-agent-dialog';

export const dynamic = 'force-dynamic';

async function loadAgents(): Promise<PublicTenant[]> {
  try {
    const tenants = await listTenants();
    return tenants.map(toPublicTenant);
  } catch (err) {
    console.error('[settings/agents] listTenants failed:', err);
    return [];
  }
}

function statusVariant(status: string): 'default' | 'secondary' | 'outline' {
  if (status === 'active') return 'default';
  if (status === 'paused') return 'secondary';
  return 'outline';
}

function hasIngester(t: PublicTenant): boolean {
  return (t.data_sources ?? []).some((d) => d.type === 'ingester');
}

function channelSummary(t: PublicTenant): string {
  const tg = t.channels.telegram?.allowed_chats.length ?? 0;
  const sl = t.channels.slack?.allowed_channels.length ?? 0;
  const parts: string[] = [];
  if (tg) parts.push(`TG ${tg}`);
  if (sl) parts.push(`Slack ${sl}`);
  return parts.length ? parts.join(' · ') : '—';
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0.00';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export default async function AgentsPage() {
  const agents = await loadAgents();
  const usage: Record<string, UsageSummary> = await getUsageSummaries().catch(() => ({}));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-heading text-lg font-semibold">Agents</h2>
          <p className="text-sm text-muted-foreground">
            Per-customer confined agents. Each is scoped to one Torque project by its
            (write-only) Torque token; messages route to it by Telegram chat / Slack channel.
          </p>
        </div>
        <CreateAgentDialog />
      </div>

      {agents.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No agents yet. Create one to get started.
        </div>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Slug</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Channels</TableHead>
                <TableHead>Data</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Est. cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((a) => (
                <TableRow key={a.id} className="cursor-pointer">
                  <TableCell className="font-mono text-xs">
                    <Link href={`/agents/${a.id}`} className="hover:underline">
                      {a.slug}
                    </Link>
                  </TableCell>
                  <TableCell>{a.display_name}</TableCell>
                  <TableCell className="font-mono text-[11px] text-muted-foreground">
                    {a.torque_project_id.slice(0, 10)}…
                  </TableCell>
                  <TableCell className="font-mono text-[11px]">{a.model}</TableCell>
                  <TableCell className="text-xs">{channelSummary(a)}</TableCell>
                  <TableCell>
                    {hasIngester(a) ? <Badge variant="outline">ingester</Badge> : '—'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(a.status)}>{a.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {fmtUsd(usage[a.id]?.cost_usd ?? 0)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
