import { randomUUID } from 'node:crypto';
import {
  getRunFeedbackByJob,
  getRunFeedbackByRun,
  insertRunFeedback,
} from './db';
import type { RunFeedback } from './types';

/**
 * Workstream G — run feedback service.
 *
 * Thin wrapper around the DB helpers so the API routes (and orchestrator's
 * use_feedback injection path) don't need to know about row IDs or shapes.
 * Feedback is append-only — no edit / delete in v1, on the theory that
 * historical signal is more useful than a clean slate.
 */

export type CreateFeedbackArgs = {
  runId: string;
  jobId: string;
  rating: 'good' | 'bad' | 'neutral';
  comment?: string;
  createdBy?: string | null;
};

export async function createFeedback(args: CreateFeedbackArgs): Promise<RunFeedback> {
  return insertRunFeedback({
    id: randomUUID(),
    run_id: args.runId,
    job_id: args.jobId,
    rating: args.rating,
    comment: args.comment ?? '',
    created_by: args.createdBy ?? null,
  });
}

export async function listFeedbackForJob(
  jobId: string,
  limit = 20,
): Promise<RunFeedback[]> {
  return getRunFeedbackByJob(jobId, limit);
}

export async function listFeedbackForRun(runId: string): Promise<RunFeedback[]> {
  return getRunFeedbackByRun(runId);
}

/**
 * Build the system-prompt section the orchestrator prepends when a step has
 * `use_feedback: true`. Returns empty string if there's no useful feedback
 * yet (or only empty comments), so the prompt stays clean for cold-start jobs.
 *
 * Truncates each comment to keep this section bounded — a long rant by the
 * user shouldn't blow the model's context budget. Most feedback in practice
 * is a sentence or two.
 */
export function renderFeedbackPromptSection(items: RunFeedback[]): string {
  const usable = items.filter((i) => (i.comment ?? '').trim().length > 0);
  if (usable.length === 0) return '';

  const lines = usable.map((i) => {
    const tag = i.rating.toUpperCase();
    const trimmed = i.comment.replace(/\s+/g, ' ').trim();
    const cap = trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
    return `- [${tag}] "${cap}"`;
  });

  return [
    '## Prior feedback on this job (most recent runs)',
    '',
    ...lines,
    '',
    'Take this feedback into account.',
  ].join('\n');
}
