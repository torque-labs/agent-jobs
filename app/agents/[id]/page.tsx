import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { getTenant, toPublicTenant } from '@/lib/tenants';
import { getUsageSummary } from '@/lib/tenant-usage';
import { listRoutinesForTenant } from '@/lib/tenant-routines';
import { listEntries } from '@/lib/tenant-knowledge';
import { RoutinesSection, type RoutineView } from './routines';
import { KnowledgeSection, type KnowledgeView } from './knowledge';
import {
  AgentControls,
  ChannelEnrollment,
  DeleteAgentButton,
  TestChat,
} from './agent-actions';

export const dynamic = 'force-dynamic';

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenant(id);
  if (!tenant) notFound();
  const t = toPublicTenant(tenant);
  const ingester = (t.data_sources ?? []).some((d) => d.type === 'ingester');
  const usage = await getUsageSummary(t.id).catch(() => ({ turns: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0 }));
  const fmtUsd = (n: number) => (n === 0 ? '$0.00' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
  const routines: RoutineView[] = (await listRoutinesForTenant(t.id).catch(() => [])).map((r) => ({
    id: r.id,
    name: r.name,
    cron: r.cron,
    prompt: r.prompt,
    channel: r.channel,
    enabled: r.enabled,
    last_run_at: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
    last_status: r.last_status,
  }));
  const knowledge: KnowledgeView[] = (await listEntries(t.id).catch(() => [])).map((e) => ({
    id: e.id,
    title: e.title,
    content: e.content,
    source_url: e.source_url,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/agents" className="text-xs text-muted-foreground hover:underline">
            ← Agents
          </Link>
          <h2 className="font-heading text-lg font-semibold">
            {t.display_name}{' '}
            <span className="font-mono text-sm font-normal text-muted-foreground">{t.slug}</span>
          </h2>
        </div>
        <Badge variant={t.status === 'active' ? 'default' : 'secondary'}>{t.status}</Badge>
      </div>

      <section className="rounded-lg border p-4">
        <h3 className="mb-3 text-sm font-semibold">Torque binding (read-only)</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Project id</dt>
          <dd className="font-mono">{t.torque_project_id}</dd>
          <dt className="text-muted-foreground">Wallet / user</dt>
          <dd className="font-mono">{t.torque_wallet_pubkey}</dd>
          <dt className="text-muted-foreground">Memory namespace</dt>
          <dd className="font-mono">{t.memory_namespace}</dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd>{new Date(t.created_at).toLocaleString()}</dd>
        </dl>
        <p className="mt-3 text-[11px] text-muted-foreground">
          The scoped Torque token is the isolation boundary and can&rsquo;t be edited here —
          to change the project or token, delete and recreate.
        </p>
      </section>

      <section className="rounded-lg border p-4">
        <h3 className="mb-3 text-sm font-semibold">Usage (all-time, estimated)</h3>
        <dl className="grid grid-cols-4 gap-4 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Turns</dt>
            <dd className="font-mono">{usage.turns.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Tokens in</dt>
            <dd className="font-mono">{usage.tokens_in.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Tokens out</dt>
            <dd className="font-mono">{usage.tokens_out.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Est. cost</dt>
            <dd className="font-mono">{fmtUsd(usage.cost_usd)}</dd>
          </div>
        </dl>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Estimated from per-model pricing (lib/models.ts) × recorded token counts.
        </p>
      </section>

      <AgentControls
        id={t.id}
        model={t.model}
        soul={t.soul}
        status={t.status}
        ingester={ingester}
      />

      <ChannelEnrollment
        id={t.id}
        telegramChats={t.channels.telegram?.allowed_chats ?? []}
        slackChannels={t.channels.slack?.allowed_channels ?? []}
      />

      <RoutinesSection id={t.id} initial={routines} />

      <KnowledgeSection id={t.id} initial={knowledge} />

      <TestChat id={t.id} />

      <section className="rounded-lg border border-destructive/30 p-4">
        <h3 className="mb-1 text-sm font-semibold text-destructive">Danger zone</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          Deleting removes the agent and its stored token + channel routing.
        </p>
        <DeleteAgentButton id={t.id} name={t.display_name} />
      </section>
    </div>
  );
}
