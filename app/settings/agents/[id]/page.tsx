import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { getTenant, toPublicTenant } from '@/lib/tenants';
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/settings/agents" className="text-xs text-muted-foreground hover:underline">
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
