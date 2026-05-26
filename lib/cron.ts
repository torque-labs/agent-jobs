import { schedule, validate, type ScheduledTask } from 'node-cron';
import { getJob, listJobs } from './db';
import { executeJob } from './orchestrator';
import { sweepWebhookDeliveries } from './webhook-delivery';
import { runRoutine } from './routine-runner';
import { getRoutine, listEnabledRoutines, type Routine } from './tenant-routines';
import type { Job } from './types';

/**
 * In-process registry of active cron handles, keyed by job id. This is
 * process-local — if you run multiple Node instances, each one will hold its
 * own schedule (and each will fire). For v1 we run a single custom server
 * process, so that's fine.
 */
const REGISTRY = new Map<string, ScheduledTask>();

/**
 * Called once during boot from `server.ts`. Loads all jobs from the DB and
 * registers a cron handle for each one that's enabled and has a cron string.
 * Safe to call multiple times — re-registers (stops + starts) cleanly.
 */
export async function initCron(): Promise<void> {
  let jobs: Job[];
  try {
    jobs = await listJobs();
  } catch (err) {
    console.error('[cron] initCron: failed to load jobs from DB:', err);
    return;
  }

  let registered = 0;
  let skipped = 0;
  for (const job of jobs) {
    if (!job.enabled || !job.cron) {
      skipped++;
      continue;
    }
    try {
      registerCronForJob(job);
      registered++;
    } catch (err) {
      console.error(`[cron] failed to register job ${job.id} (${job.name}):`, err);
    }
  }
  console.log(`[cron] initCron: registered ${registered}, skipped ${skipped}`);

  // Per-agent scheduled routines (cron interpreted in UTC).
  try {
    const routines = await listEnabledRoutines();
    let rreg = 0;
    for (const r of routines) {
      try {
        registerCronForRoutine(r);
        rreg++;
      } catch (err) {
        console.error(`[cron] failed to register routine ${r.id} (${r.name}):`, err);
      }
    }
    console.log(`[cron] initCron: registered ${rreg} routine(s)`);
  } catch (err) {
    console.error('[cron] initCron: failed to load routines from DB:', err);
  }

  // Workstream D — webhook delivery sweeper. Runs every 30s on a separate
  // registry slot so an operator can't accidentally unregister it via a Job
  // edit (the namespace key is reserved with the `__system:` prefix).
  registerWebhookSweeper();
}

const WEBHOOK_SWEEPER_KEY = '__system:webhook-sweeper';

function registerWebhookSweeper(): void {
  // Replace any prior handle (idempotent across reloads).
  const existing = REGISTRY.get(WEBHOOK_SWEEPER_KEY);
  if (existing) {
    try {
      existing.stop();
    } catch (err) {
      console.error('[cron] error stopping prior webhook sweeper:', err);
    }
    REGISTRY.delete(WEBHOOK_SWEEPER_KEY);
  }

  try {
    const task = schedule(
      '*/30 * * * * *',
      async () => {
        try {
          await sweepWebhookDeliveries();
        } catch (err) {
          console.error('[cron] webhook sweeper tick failed:', err);
        }
      },
      { name: WEBHOOK_SWEEPER_KEY, noOverlap: true },
    );
    REGISTRY.set(WEBHOOK_SWEEPER_KEY, task);
    console.log('[cron] webhook sweeper registered (*/30s)');
  } catch (err) {
    console.error('[cron] failed to register webhook sweeper:', err);
  }
}

/**
 * Schedule (or re-schedule) a single job. If a handle already exists for this
 * id it is stopped and replaced. If the cron expression is invalid we log and
 * skip — we never throw, so a bad cron string can't take down the server.
 */
export function registerCronForJob(job: Job): void {
  // Always unregister first so we never leak handles.
  unregisterCron(job.id);

  if (!job.enabled) {
    return;
  }
  if (!job.cron) {
    return;
  }

  if (!validate(job.cron)) {
    console.error(`[cron] job ${job.id} (${job.name}) has invalid cron expression: ${job.cron}`);
    return;
  }

  let task: ScheduledTask;
  try {
    task = schedule(
      job.cron,
      async () => {
        try {
          await executeJob(job.id, 'cron');
        } catch (err) {
          // executeJob is supposed to be no-throw, but belt-and-suspenders:
          // a thrown error inside a cron tick must NEVER crash the process.
          console.error(`[cron] job ${job.id} tick threw:`, err);
        }
      },
      { name: `job:${job.id}`, noOverlap: true },
    );
  } catch (err) {
    console.error(`[cron] schedule() threw for job ${job.id}:`, err);
    return;
  }

  REGISTRY.set(job.id, task);
}

/**
 * Re-fetch the job row from the DB and re-register its cron handle. Called by
 * the PATCH route so schedule changes take effect immediately. If the job has
 * been deleted (returns null), we just unregister.
 */
export async function reloadCronForJob(id: string): Promise<void> {
  try {
    const job = await getJob(id);
    if (!job) {
      unregisterCron(id);
      return;
    }
    registerCronForJob(job);
  } catch (err) {
    console.error(`[cron] reloadCronForJob(${id}) failed:`, err);
  }
}

/**
 * Schedule (or re-schedule) a per-agent routine. Cron is interpreted in UTC.
 * Keyed under `routine:<id>` so it never collides with a job handle. Invalid
 * cron is logged + skipped, never thrown.
 */
export function registerCronForRoutine(routine: Routine): void {
  const key = `routine:${routine.id}`;
  unregisterCron(key);

  if (!routine.enabled) return;
  if (!validate(routine.cron)) {
    console.error(`[cron] routine ${routine.id} (${routine.name}) has invalid cron: ${routine.cron}`);
    return;
  }

  let task: ScheduledTask;
  try {
    task = schedule(
      routine.cron,
      async () => {
        try {
          await runRoutine(routine.id);
        } catch (err) {
          console.error(`[cron] routine ${routine.id} tick threw:`, err);
        }
      },
      { name: key, noOverlap: true, timezone: 'UTC' },
    );
  } catch (err) {
    console.error(`[cron] schedule() threw for routine ${routine.id}:`, err);
    return;
  }
  REGISTRY.set(key, task);
}

/** Re-fetch a routine and re-register its cron handle (called by the API). */
export async function reloadCronForRoutine(id: string): Promise<void> {
  try {
    const routine = await getRoutine(id);
    if (!routine) {
      unregisterCron(`routine:${id}`);
      return;
    }
    registerCronForRoutine(routine);
  } catch (err) {
    console.error(`[cron] reloadCronForRoutine(${id}) failed:`, err);
  }
}

/**
 * Stop and remove the cron handle for a job, if any. No-op if not registered.
 */
export function unregisterCron(id: string): void {
  const existing = REGISTRY.get(id);
  if (!existing) return;
  try {
    const stopResult = existing.stop();
    // stop() may return a Promise; let it run to completion in background.
    if (stopResult && typeof (stopResult as Promise<void>).catch === 'function') {
      (stopResult as Promise<void>).catch((err) => {
        console.error(`[cron] error stopping job ${id}:`, err);
      });
    }
  } catch (err) {
    console.error(`[cron] error stopping job ${id}:`, err);
  }
  REGISTRY.delete(id);
}
