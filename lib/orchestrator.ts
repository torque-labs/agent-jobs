import { randomUUID } from 'node:crypto';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import {
  createRun,
  getJob,
  getRun,
  setRunError,
  setRunFinalOutput,
  updateRunStatus,
  updateStepRun,
} from './db';
import { requestApproval } from './approval';
import { emit } from './events';
import { listFeedbackForJob, renderFeedbackPromptSection } from './feedback';
import { selectClient } from './hermes';
import { callTool, findToolByExposedName, listAllTools, type McpToolDef } from './mcp';
import { parseOutlineManifest, postManifest } from './outline';
import { referencedSteps, substitute, type TriggerContext } from './templating';
import type { Job, Run, StepDefinition, StepRun } from './types';

const MAX_TOOL_LOOP_ITERATIONS = 25;
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_RETRIES = 1;

type StepContext = Record<string, { output: string | null }>;

export type ExecuteJobOptions = {
  /** Optional run id (so HTTP routes can mint the id before kickoff). */
  presetRunId?: string;
  /** Trigger context for runs invoked via /api/v1/triggers/[token]. */
  triggerBody?: unknown;
  triggerRawBody?: string;
  triggerHeaders?: Record<string, string>;
};

/**
 * Run a job end-to-end: load it, persist a Run row, execute each step in
 * order with retries + multi-turn tool-use loops, and update the Run record
 * after each transition so the UI can poll.
 *
 * Never throws — always resolves to a Run reflecting the final outcome.
 */
export async function executeJob(
  jobId: string,
  triggeredBy: 'cron' | 'manual' | 'chat' | 'trigger',
  presetRunIdOrOpts?: string | ExecuteJobOptions,
): Promise<Run> {
  // Back-compat: accept either a bare runId string (existing callers) or a
  // full options bag (new trigger path).
  const opts: ExecuteJobOptions = typeof presetRunIdOrOpts === 'string'
    ? { presetRunId: presetRunIdOrOpts }
    : (presetRunIdOrOpts ?? {});
  const runId = opts.presetRunId ?? randomUUID();
  const triggerCtx: TriggerContext | undefined = opts.triggerHeaders !== undefined ||
    opts.triggerBody !== undefined ||
    opts.triggerRawBody !== undefined
    ? {
        body: opts.triggerBody ?? null,
        rawBody: opts.triggerRawBody ?? '',
        headers: opts.triggerHeaders ?? {},
      }
    : undefined;
  let run: Run;

  try {
    const job = await getJob(jobId);
    if (!job) {
      const failed = await safeCreateFailedRun(runId, jobId, triggeredBy, `Job ${jobId} not found`);
      return failed;
    }

    const initialStepRuns: StepRun[] = job.steps.map((s) => ({
      step_name: s.name,
      status: 'pending',
      output: null,
      tokens: null,
      cost_usd: null,
      started_at: null,
      ended_at: null,
      error: null,
    }));

    run = await createRun({
      id: runId,
      job_id: jobId,
      status: 'running',
      triggered_by: triggeredBy,
      started_at: new Date(),
      step_runs: initialStepRuns,
    });

    safeEmit('run.started', {
      run_id: runId,
      job_id: jobId,
      triggered_by: triggeredBy,
      started_at: run.started_at,
    });

    const seenNames = new Set<string>();
    for (const step of job.steps) {
      const refs = referencedSteps(step.user_template);
      for (const ref of refs) {
        if (!seenNames.has(ref)) {
          const msg = `Step "${step.name}" references {{steps.${ref}.output}} but that step has not run yet (must be a prior step).`;
          await updateStepRun(runId, step.name, {
            status: 'failed',
            error: msg,
            ended_at: new Date().toISOString(),
          });
          await setRunError(runId, msg);
          const failed = await updateRunStatus(runId, 'failed', { ended_at: new Date() });
          return failed ?? run;
        }
      }
      seenNames.add(step.name);
    }

    const ctx: StepContext = {};
    const stepResult = await runStepsFrom(job, runId, 0, ctx, triggerCtx);
    if (stepResult.kind === 'cancelled') return stepResult.run;
    if (stepResult.kind === 'awaiting_approval') return stepResult.run ?? run;
    if (stepResult.kind === 'failed') {
      const failedRun = stepResult.run ?? run;
      safeEmit('run.failed', {
        run_id: runId,
        job_id: jobId,
        error: failedRun.error,
        ended_at: failedRun.ended_at,
      });
      return failedRun;
    }

    // Final cancellation gate — if cancelled after last step but before we
    // flipped to done, honour the cancel.
    const finalCheck = await getRun(runId).catch(() => null);
    if (finalCheck?.status === 'cancelled') {
      return finalCheck;
    }

    // Auto-publish: if the last step output matches an Outline publish
    // manifest, POST it and replace the final_output with a friendly link.
    let finalOutput = stepResult.lastOutput;
    if (finalOutput !== null) {
      const manifest = parseOutlineManifest(finalOutput);
      if (manifest) {
        try {
          const url = await postManifest(manifest);
          finalOutput = `✅ ${manifest.title} → ${url}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[orchestrator] Outline publish failed for run ${runId}:`, msg);
          // Stash the publish error on run.error but don't fail the run; the
          // manifest text stays in final_output so the operator can retry.
          try {
            await setRunError(runId, `Outline publish failed: ${msg}`);
          } catch {
            // best-effort
          }
        }
      }
      await setRunFinalOutput(runId, finalOutput);
    }
    const done = await updateRunStatus(runId, 'done', { ended_at: new Date() });
    const finalRun = done ?? run;
    safeEmit('run.completed', {
      run_id: runId,
      job_id: jobId,
      final_output: finalOutput,
      ended_at: finalRun.ended_at,
    });
    return finalRun;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await setRunError(runId, msg);
      const failed = await updateRunStatus(runId, 'failed', { ended_at: new Date() });
      safeEmit('run.failed', {
        run_id: runId,
        job_id: jobId,
        error: msg,
        ended_at: failed?.ended_at ?? new Date(),
      });
      if (failed) return failed;
    } catch {
      // DB unavailable too — fall through to synthetic return.
    }
    return {
      id: runId,
      job_id: jobId,
      status: 'failed',
      triggered_by: triggeredBy,
      started_at: null,
      ended_at: new Date(),
      step_runs: [],
      final_output: null,
      error: msg,
      pending_approval: null,
      created_at: new Date(),
    };
  }
}

/**
 * Fire-and-forget wrapper around `emit` — webhook delivery failures must NOT
 * abort a run. Logs any escape.
 */
function safeEmit(event: Parameters<typeof emit>[0], payload: unknown): void {
  void emit(event, payload).catch((err) => {
    console.error(`[orchestrator] emit(${event}) failed:`, err);
  });
}

/**
 * Resume a run that was paused by the approval gate. Loads the run, finds the
 * step index that paused (the step recorded in pending_approval), rebuilds
 * `ctx` from already-completed step_runs (so the edited approved output is
 * picked up because `approveRun` wrote it back to the step row), and runs the
 * remaining steps via the shared `runStepsFrom` driver.
 *
 * Returns the final Run. Never throws — same contract as executeJob.
 */
export async function resumeJob(runId: string): Promise<Run | null> {
  let current: Run | null = null;
  try {
    current = await getRun(runId);
    if (!current) return null;

    const job = await getJob(current.job_id);
    if (!job) {
      await setRunError(runId, `Job ${current.job_id} not found at resume`);
      return updateRunStatus(runId, 'failed', { ended_at: new Date() });
    }

    // Find the step that was paused. Approve already cleared
    // pending_approval and flipped status back to 'running', so we rely on
    // step_runs to identify the resume point: the LAST step with status='done'
    // is the gate step, and we resume from the index AFTER it.
    const completedStepNames = new Set(
      current.step_runs.filter((sr) => sr.status === 'done').map((sr) => sr.step_name),
    );
    let resumeFrom = 0;
    for (let i = 0; i < job.steps.length; i++) {
      if (completedStepNames.has(job.steps[i].name)) {
        resumeFrom = i + 1;
      } else {
        break;
      }
    }

    // Rebuild ctx from the already-completed step outputs. The approve path
    // wrote the (possibly edited) approved output back to the step_run row,
    // so this naturally picks up the edit.
    const ctx: StepContext = {};
    for (const sr of current.step_runs) {
      if (sr.status === 'done') {
        ctx[sr.step_name] = { output: sr.output };
      }
    }

    if (resumeFrom >= job.steps.length) {
      // Nothing left — treat as done. Use last completed step output.
      const lastDone = [...current.step_runs].reverse().find((sr) => sr.status === 'done');
      if (lastDone?.output != null) {
        await setRunFinalOutput(runId, lastDone.output);
      }
      return updateRunStatus(runId, 'done', { ended_at: new Date() });
    }

    const result = await runStepsFrom(job, runId, resumeFrom, ctx);
    if (result.kind === 'cancelled') return result.run;
    if (result.kind === 'awaiting_approval') return result.run;
    if (result.kind === 'failed') return result.run ?? current;

    if (result.lastOutput !== null) {
      await setRunFinalOutput(runId, result.lastOutput);
    }
    return updateRunStatus(runId, 'done', { ended_at: new Date() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await setRunError(runId, msg);
      return updateRunStatus(runId, 'failed', { ended_at: new Date() });
    } catch {
      return current;
    }
  }
}

type StepLoopResult =
  | { kind: 'ok'; lastOutput: string | null }
  | { kind: 'cancelled'; run: Run }
  | { kind: 'awaiting_approval'; run: Run | null }
  | { kind: 'failed'; run: Run | null };

/**
 * Shared driver for the orchestrator's step loop. Used by both `executeJob`
 * (starts at index 0) and `resumeJob` (starts after the approval gate). The
 * caller owns the run-row lifecycle (createRun, final status flip, etc.); we
 * just iterate steps and surface a terminal/pause signal.
 */
async function runStepsFrom(
  job: Job,
  runId: string,
  startIndex: number,
  ctx: StepContext,
  triggerCtx?: TriggerContext,
): Promise<StepLoopResult> {
  let lastOutput: string | null = null;

  // Materialize prior feedback once per run; cheap query but no need to repeat
  // it for every step that has use_feedback.
  let cachedFeedbackSection: string | null = null;
  const getFeedbackSection = async (): Promise<string> => {
    if (cachedFeedbackSection !== null) return cachedFeedbackSection;
    try {
      const items = await listFeedbackForJob(job.id, 5);
      cachedFeedbackSection = renderFeedbackPromptSection(items);
    } catch (err) {
      console.error(`[orchestrator] failed to load feedback for job ${job.id}:`, err);
      cachedFeedbackSection = '';
    }
    return cachedFeedbackSection;
  };

  for (let i = startIndex; i < job.steps.length; i++) {
    const step = job.steps[i];

    // Cooperative cancellation: re-check the run row before each step. If a
    // caller hit /api/v1/runs/:id/cancel between steps we stop here without
    // starting the next model call.
    const fresh = await getRun(runId).catch(() => null);
    if (fresh?.status === 'cancelled') {
      return { kind: 'cancelled', run: fresh };
    }

    // Workstream G — optionally prepend prior-feedback section to system prompt.
    let effectiveStep = step;
    if (step.use_feedback) {
      const fb = await getFeedbackSection();
      if (fb.length > 0) {
        effectiveStep = {
          ...step,
          system_prompt: `${fb}\n\n${step.system_prompt}`,
        };
      }
    }

    const result = await executeStepWithRetries(runId, effectiveStep, ctx, triggerCtx);
    if (result.ok === false) {
      // If a cancel landed during the step, prefer the cancelled state over
      // surfacing the (often-spurious) abort error.
      const after = await getRun(runId).catch(() => null);
      if (after?.status === 'cancelled') return { kind: 'cancelled', run: after };
      await setRunError(runId, result.error);
      const failed = await updateRunStatus(runId, 'failed', { ended_at: new Date() });
      return { kind: 'failed', run: failed };
    }
    ctx[step.name] = { output: result.output };
    lastOutput = result.output;

    safeEmit('step.completed', {
      run_id: runId,
      job_id: job.id,
      step_name: step.name,
      status: 'done',
      tokens: result.tokens ?? null,
      ended_at: new Date().toISOString(),
    });

    // Workstream H — pause for approval before running any subsequent step.
    if (step.approval_required) {
      const paused = await requestApproval(runId, step.name, result.output);
      return { kind: 'awaiting_approval', run: paused };
    }
  }

  return { kind: 'ok', lastOutput };
}

/**
 * Mint a runId synchronously, kick off `executeJob` in the background using
 * that id, and return the id. Used by HTTP routes that want to redirect the
 * user to `/runs/:id` before the orchestrator's first model call lands.
 *
 * Caller is responsible for verifying the job exists before calling this
 * (so they can return 404 instead of creating a doomed runId).
 */
export function startJobRun(
  jobId: string,
  triggeredBy: 'cron' | 'manual' | 'chat' | 'trigger',
  opts?: Omit<ExecuteJobOptions, 'presetRunId'>,
): string {
  const runId = randomUUID();
  void executeJob(jobId, triggeredBy, { presetRunId: runId, ...(opts ?? {}) }).catch((err) => {
    console.error(`[orchestrator] background executeJob(${jobId}, ${runId}) escaped:`, err);
  });
  return runId;
}

async function executeStepWithRetries(
  runId: string,
  step: StepDefinition,
  ctx: StepContext,
  triggerCtx?: TriggerContext,
): Promise<
  | { ok: true; output: string; tokens: { in: number; out: number } }
  | { ok: false; error: string }
> {
  const retries = step.retries ?? DEFAULT_RETRIES;
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const startedAtIso = new Date().toISOString();
    let didPersistTerminal = false;
    try {
      await updateStepRun(runId, step.name, {
        status: 'running',
        started_at: startedAtIso,
        error: null,
      });
      const { output, tokensIn, tokensOut } = await runSingleStep(step, ctx, triggerCtx);
      await updateStepRun(runId, step.name, {
        status: 'done',
        output,
        tokens: { in: tokensIn, out: tokensOut },
        ended_at: new Date().toISOString(),
        error: null,
      });
      didPersistTerminal = true;
      return { ok: true, output, tokens: { in: tokensIn, out: tokensOut } };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === retries) {
        try {
          await updateStepRun(runId, step.name, {
            status: 'failed',
            error: lastError,
            ended_at: new Date().toISOString(),
          });
          didPersistTerminal = true;
        } catch {
          // swallow — we'll still return the error below
        }
      }
    } finally {
      if (!didPersistTerminal && attempt === retries) {
        try {
          await updateStepRun(runId, step.name, {
            status: 'failed',
            error: lastError || 'unknown step failure',
            ended_at: new Date().toISOString(),
          });
        } catch {
          // truly unrecoverable; outer catch will set run-level error
        }
      }
    }
  }
  return { ok: false, error: lastError || 'step failed' };
}

/**
 * Single attempt of a step. We expose MCP tools from `lib/mcp.ts` (filtered
 * by step.tools_allowed if set) directly to the OpenRouter Chat Completions
 * API and route tool_call responses back through MCP. Loop until the model
 * returns no tool_calls or we hit MAX_TOOL_LOOP_ITERATIONS.
 */
async function runSingleStep(
  step: StepDefinition,
  ctx: StepContext,
  triggerCtx?: TriggerContext,
): Promise<{ output: string; tokensIn: number; tokensOut: number }> {
  const userContent = substitute(step.user_template, { steps: ctx, trigger: triggerCtx });
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: step.system_prompt },
    { role: 'user', content: userContent },
  ];

  const client = selectClient(step.model);
  const timeoutMs = (step.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

  const tools = buildToolList(step.tools_allowed);
  const toolsParam: ChatCompletionTool[] | undefined = tools.length > 0
    ? tools.map((t) => ({
        type: 'function',
        function: {
          name: t.exposedName,
          description: t.description,
          parameters: t.inputSchema,
        },
      }))
    : undefined;

  let tokensIn = 0;
  let tokensOut = 0;
  let finalText: string | null = null;

  for (let iter = 0; iter < MAX_TOOL_LOOP_ITERATIONS; iter++) {
    const completion: ChatCompletion = await callWithTimeout(
      client.chat.completions.create({
        model: step.model,
        messages,
        tools: toolsParam,
        max_tokens: 8192,
        stream: false,
      }),
      timeoutMs,
      `step "${step.name}" timed out after ${step.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS}s`,
    );

    if (completion.usage) {
      tokensIn += completion.usage.prompt_tokens ?? 0;
      tokensOut += completion.usage.completion_tokens ?? 0;
    }

    const choice = completion.choices?.[0];
    if (!choice) {
      throw new Error(`Model returned no choices for step "${step.name}"`);
    }
    const msg = choice.message;
    const toolCalls = msg.tool_calls;

    if (toolCalls && toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: toolCalls,
      });
      // Execute tool calls in parallel — they're independent MCP calls.
      const results = await Promise.all(
        toolCalls.map(async (tc) => {
          if (tc.type !== 'function') {
            return { id: tc.id, content: `[unsupported tool call type: ${tc.type}]` };
          }
          const exposedName = tc.function.name;
          const def = findToolByExposedName(exposedName);
          if (!def) {
            return { id: tc.id, content: `[tool ${exposedName} is not available]` };
          }
          let args: Record<string, unknown> = {};
          try {
            args = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
          } catch (err) {
            return { id: tc.id, content: `[invalid JSON arguments: ${(err as Error).message}]` };
          }
          try {
            const body = await callTool(def.serverName, def.toolName, args);
            return { id: tc.id, content: body };
          } catch (err) {
            return { id: tc.id, content: `[tool error: ${(err as Error).message}]` };
          }
        }),
      );
      for (const r of results) {
        messages.push({
          role: 'tool',
          tool_call_id: r.id,
          content: r.content,
        });
      }
      continue;
    }

    finalText = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
    break;
  }

  if (finalText === null) {
    throw new Error(
      `step "${step.name}" exceeded ${MAX_TOOL_LOOP_ITERATIONS} tool-use iterations without producing a final response`,
    );
  }

  return { output: finalText, tokensIn, tokensOut };
}

/**
 * Build the tool list available to this step. If tools_allowed is null we
 * expose every MCP tool we know about; if it's an empty array we expose none
 * (pure text-generation step); otherwise we filter by exposedName OR by
 * server prefix (e.g. "torque" matches every mcp_torque_*).
 */
function buildToolList(allowed: string[] | null): McpToolDef[] {
  const all = listAllTools();
  if (allowed === null) return all;
  if (allowed.length === 0) return [];
  const allowedSet = new Set(allowed);
  return all.filter((t) =>
    allowedSet.has(t.exposedName) || allowedSet.has(t.serverName),
  );
}

function callWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && 'type' in part && (part as { type: string }).type === 'text') {
      const text = (part as { text?: string }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('');
}

async function safeCreateFailedRun(
  runId: string,
  jobId: string,
  triggeredBy: 'cron' | 'manual' | 'chat' | 'trigger',
  error: string,
): Promise<Run> {
  try {
    const run = await createRun({
      id: runId,
      job_id: jobId,
      status: 'failed',
      triggered_by: triggeredBy,
      started_at: new Date(),
      step_runs: [],
    });
    await setRunError(runId, error);
    const ended = await updateRunStatus(runId, 'failed', { ended_at: new Date() });
    return ended ?? { ...run, error };
  } catch {
    return {
      id: runId,
      job_id: jobId,
      status: 'failed',
      triggered_by: triggeredBy,
      started_at: null,
      ended_at: new Date(),
      step_runs: [],
      final_output: null,
      error,
      pending_approval: null,
      created_at: new Date(),
    };
  }
}
