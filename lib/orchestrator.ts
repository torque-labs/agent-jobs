import { randomUUID } from 'node:crypto';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
import {
  createRun,
  getJob,
  setRunError,
  setRunFinalOutput,
  updateRunStatus,
  updateStepRun,
} from './db';
import { isHermesModel, selectClient } from './hermes';
import { referencedSteps, substitute } from './templating';
import type { Run, StepDefinition, StepRun } from './types';

const MAX_TOOL_LOOP_ITERATIONS = 10;
const DEFAULT_TIMEOUT_SECONDS = 600;
const DEFAULT_RETRIES = 1;

type StepContext = Record<string, { output: string | null }>;

/**
 * Run a job end-to-end: load it, persist a Run row, execute each step in
 * order with retries + multi-turn tool-use loops, and update the Run record
 * after each transition so the UI can poll.
 *
 * Never throws — always resolves to a Run reflecting the final outcome.
 */
export async function executeJob(
  jobId: string,
  triggeredBy: 'cron' | 'manual' | 'chat',
): Promise<Run> {
  const runId = randomUUID();
  let run: Run;

  // Bootstrap: load job, write the queued/running Run record. If even this
  // fails we still want to return a synthetic Run-shaped object so callers
  // (API routes) can render a sensible error — but we also try to persist.
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

    // Validate that step templates only reference earlier steps. Fail fast
    // before we burn tokens.
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

    // Execute steps sequentially. The StepContext grows as we go.
    const ctx: StepContext = {};
    let lastOutput: string | null = null;

    for (const step of job.steps) {
      const result = await executeStepWithRetries(runId, step, ctx);
      if (!result.ok) {
        // Mark run failed and stop — downstream steps stay 'pending' in DB,
        // which signals to the UI that they were never attempted.
        await setRunError(runId, result.error);
        const failed = await updateRunStatus(runId, 'failed', { ended_at: new Date() });
        return failed ?? run;
      }
      ctx[step.name] = { output: result.output };
      lastOutput = result.output;
    }

    if (lastOutput !== null) {
      await setRunFinalOutput(runId, lastOutput);
    }
    const done = await updateRunStatus(runId, 'done', { ended_at: new Date() });
    return done ?? run;
  } catch (err) {
    // Catch-all so executeJob never throws. Persist what we can.
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await setRunError(runId, msg);
      const failed = await updateRunStatus(runId, 'failed', { ended_at: new Date() });
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
      created_at: new Date(),
    };
  }
}

/**
 * Execute a single step with retry semantics. Returns the final output on
 * success, or the last error on terminal failure. Each attempt persists its
 * own status transitions so the UI sees retries happen in real time.
 *
 * The try/finally around the DB updates guarantees the step_run row reflects
 * the latest known state even if the upstream call throws mid-execution.
 */
async function executeStepWithRetries(
  runId: string,
  step: StepDefinition,
  ctx: StepContext,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
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
      const { output, tokensIn, tokensOut } = await runSingleStep(step, ctx);
      await updateStepRun(runId, step.name, {
        status: 'done',
        output,
        tokens: { in: tokensIn, out: tokensOut },
        ended_at: new Date().toISOString(),
        error: null,
      });
      didPersistTerminal = true;
      return { ok: true, output };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // Only mark failed on the FINAL attempt. Intermediate failures stay as
      // 'running' transiently and get overwritten by the next attempt's
      // 'running' update — that's fine, the run history shows the final state.
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
      // Belt-and-suspenders: if neither success nor terminal-failure path
      // wrote a row (shouldn't happen, but JS), at least leave a breadcrumb.
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
 * Single attempt of a step: substitutes the user template, calls the model,
 * walks any multi-turn tool_call loop until a final text response, returns
 * that text along with aggregate token counts.
 */
async function runSingleStep(
  step: StepDefinition,
  ctx: StepContext,
): Promise<{ output: string; tokensIn: number; tokensOut: number }> {
  const userContent = substitute(step.user_template, { steps: ctx });
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: step.system_prompt },
    { role: 'user', content: userContent },
  ];

  const client = selectClient(step.model);
  const timeoutMs = (step.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;

  let tokensIn = 0;
  let tokensOut = 0;
  let finalText: string | null = null;

  // Multi-turn loop. For Hermes-routed steps the gateway may return
  // tool_calls that it has already executed server-side; we append the
  // assistant message + synthetic tool results and re-call. For OpenRouter
  // direct calls there are no MCP tools, so tool_calls should never appear
  // and the loop exits on the first iteration. The 10-iteration cap is a
  // safety net against pathological models that keep tool-calling forever.
  for (let iter = 0; iter < MAX_TOOL_LOOP_ITERATIONS; iter++) {
    const completion: ChatCompletion = await callWithTimeout(
      client.chat.completions.create({
        model: step.model,
        messages,
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

    if (toolCalls && toolCalls.length > 0 && isHermesModel(step.model)) {
      // Persist the assistant turn (including the tool_calls) so the next
      // request has the full history, then synthesize tool result messages.
      // The Hermes gateway has ALREADY executed the tools; this block is a
      // defensive fallback for the case where the gateway surfaces tool
      // calls back to us. In the normal happy path Hermes returns a plain
      // text message and we exit the loop on iteration 0.
      messages.push({
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: toolCalls,
      });
      for (const tc of toolCalls) {
        messages.push(buildToolResultMessage(tc));
      }
      continue;
    }

    // Final text response — exit the loop.
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
 * Wrap a promise with a timeout. Rejects if the underlying call doesn't
 * settle in time, but does NOT cancel the upstream request (the OpenAI SDK
 * supports an AbortSignal — wiring it up here would be a nice v1.1).
 */
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

/**
 * Synthesize a tool message that closes out a tool_call when we can't
 * actually execute it locally (we can't — MCP tools live behind the
 * gateway). In practice the Hermes gateway should have already executed the
 * tool and returned the result inline; this is a fallback that tells the
 * model "we don't have the result, decide what to do".
 */
function buildToolResultMessage(
  tc: ChatCompletionMessageToolCall,
): ChatCompletionMessageParam {
  return {
    role: 'tool',
    tool_call_id: tc.id,
    content: '[tool result unavailable — Hermes gateway should have inlined this]',
  };
}

/**
 * Extract plain text from an OpenAI content array (multimodal responses).
 * Concatenates any text parts; ignores non-text parts.
 */
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

/**
 * Best-effort: try to persist a failed-from-the-start Run row. If the DB is
 * unreachable, return a synthetic Run so the caller still gets a typed value.
 */
async function safeCreateFailedRun(
  runId: string,
  jobId: string,
  triggeredBy: 'cron' | 'manual' | 'chat',
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
      created_at: new Date(),
    };
  }
}
