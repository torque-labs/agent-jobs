import {
  clearPendingApproval,
  getRun,
  setPendingApproval,
  setRunError,
  updateRunStatus,
  updateStepRun,
} from './db';
import type { Run } from './types';

/**
 * Workstream H — approval gate.
 *
 * Two-phase pause/resume for runs that include a step with
 * `approval_required: true`. The orchestrator calls `requestApproval` after
 * such a step completes; the API's /approve or /reject route then unblocks
 * (or kills) the run.
 *
 * Resume itself lives in `lib/orchestrator.resumeJob` to keep the orchestrator
 * as the single owner of step execution. This module only manipulates the
 * `runs.pending_approval` JSONB + status transitions.
 */

export async function requestApproval(
  runId: string,
  stepName: string,
  output: string,
): Promise<Run | null> {
  return setPendingApproval(runId, {
    step_name: stepName,
    output,
    requested_at: new Date().toISOString(),
  });
}

/**
 * Mark a run as approved. If `edit` is provided, it overwrites the paused
 * step's `output` on the step_runs row so resume uses the edited text as the
 * step's context entry. Status flips back to 'running' so the orchestrator
 * can pick it up; clearing pending_approval is the resume signal.
 *
 * Returns null if the run doesn't exist or wasn't actually awaiting approval.
 */
export async function approveRun(
  runId: string,
  edit?: string,
): Promise<Run | null> {
  const current = await getRun(runId);
  if (!current) return null;
  if (current.status !== 'awaiting_approval' || !current.pending_approval) {
    // Idempotent-ish: if it's already past the gate, return what we have.
    return current;
  }

  // If the user edited the output, persist the new text on the step_run row.
  // The orchestrator's resumeJob will rebuild ctx from step_runs, so this is
  // the load-bearing write.
  if (edit !== undefined && edit !== current.pending_approval.output) {
    await updateStepRun(runId, current.pending_approval.step_name, {
      output: edit,
    });
  }

  return clearPendingApproval(runId, { resumeRunning: true });
}

/**
 * Reject a paused run. We set the run-level error to the reason, flip status
 * to 'failed', stamp ended_at, and clear pending_approval so the UI no longer
 * shows the approval panel. The orchestrator will NOT resume — rejection is a
 * terminal state in v1.
 */
export async function rejectRun(
  runId: string,
  reason: string,
): Promise<Run | null> {
  const current = await getRun(runId);
  if (!current) return null;
  if (current.status !== 'awaiting_approval') {
    // Same idempotency call as approve — don't clobber a terminal state.
    return current;
  }
  await setRunError(runId, `Rejected by reviewer: ${reason}`);
  await clearPendingApproval(runId);
  return updateRunStatus(runId, 'failed', { ended_at: new Date() });
}
