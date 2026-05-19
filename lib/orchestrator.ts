import { randomUUID } from 'node:crypto';
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import {
  createRun,
  getJob,
  setRunError,
  setRunFinalOutput,
  updateRunStatus,
  updateStepRun,
} from './db';
import { selectClient } from './hermes';
import { callTool, findToolByExposedName, listAllTools, type McpToolDef } from './mcp';
import { referencedSteps, substitute } from './templating';
import type { Run, StepDefinition, StepRun } from './types';

const MAX_TOOL_LOOP_ITERATIONS = 25;
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
    let lastOutput: string | null = null;

    for (const step of job.steps) {
      const result = await executeStepWithRetries(runId, step, ctx);
      if (result.ok === false) {
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
): Promise<{ output: string; tokensIn: number; tokensOut: number }> {
  const userContent = substitute(step.user_template, { steps: ctx });
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
