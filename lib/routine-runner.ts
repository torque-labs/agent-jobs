/**
 * Execute one scheduled routine: run the tenant's prompt through the scoped
 * agent runtime, then deliver the reply to the tenant's channel. Never throws
 * — records last_status and logs. Called by the cron tick + the "Run now" API.
 */
import { runTenantTurn } from './agent-runtime';
import { deliverToTenant } from './channels';
import { getTenant } from './tenants';
import { getRoutine, markRoutineRun } from './tenant-routines';

export async function runRoutine(routineId: string): Promise<{ ok: boolean; detail: string }> {
  const routine = await getRoutine(routineId).catch(() => null);
  if (!routine) return { ok: false, detail: 'routine not found' };
  if (!routine.enabled) return { ok: false, detail: 'routine disabled' };

  const tenant = await getTenant(routine.tenant_id).catch(() => null);
  if (!tenant) {
    await markRoutineRun(routineId, 'failed: tenant missing').catch(() => {});
    return { ok: false, detail: 'tenant not found' };
  }
  if (tenant.status !== 'active') {
    await markRoutineRun(routineId, `skipped: tenant ${tenant.status}`).catch(() => {});
    return { ok: false, detail: `tenant ${tenant.status}` };
  }

  try {
    const result = await runTenantTurn(tenant.id, routine.prompt, {
      conversationId: `routine:${routineId}`,
      history: [],
    });
    const { targets, delivered } = await deliverToTenant(tenant, routine.channel, result.reply);
    const status =
      process.env[`${routine.channel.toUpperCase()}_SEND_DISABLED`] === 'true'
        ? `ok (dry-run, ${targets} target(s))`
        : `ok (${delivered}/${targets} delivered)`;
    await markRoutineRun(routineId, status).catch(() => {});
    return { ok: true, detail: status };
  } catch (err) {
    const label = err instanceof Error ? err.name : 'error';
    await markRoutineRun(routineId, `failed: ${label}`).catch(() => {});
    console.error(`[routine] ${routineId} failed: ${label}`);
    return { ok: false, detail: label };
  }
}
