import OpenAI from 'openai';

/** Steps whose model is this alias run the full Hermes autonomous loop. */
export const HERMES_MODEL = 'hermes-agent';

export function isHermesModel(model: string): boolean {
  return model === HERMES_MODEL;
}

/**
 * OpenRouter client. Tool steps drive MCP via in-process subprocesses
 * (see lib/mcp.ts) — the LLM call itself goes straight to OpenRouter.
 */
export function createOpenRouterClient(): OpenAI {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY env var is required');
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: key,
  });
}

export function selectClient(_model: string): OpenAI {
  return createOpenRouterClient();
}

/**
 * Run a step through the Hermes Agent gateway's Responses API. Hermes owns
 * its own multi-turn tool loop (browser, terminal, code-exec, delegation,
 * Torque/Supabase MCPs auto-loaded via platform_toolsets.api_server), so we
 * just hand it the prompt and read back the final text — no client-side tool
 * dispatch. This is the "autonomous" backend choice.
 */
export async function runHermesResponse(
  systemPrompt: string,
  userContent: string,
  timeoutMs: number,
): Promise<{ output: string; tokensIn: number; tokensOut: number }> {
  const base = process.env.HERMES_API_URL;
  if (!base) throw new Error('HERMES_API_URL env var is required for hermes-agent steps');
  const token = process.env.HERMES_API_TOKEN;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/v1/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        model: HERMES_MODEL,
        instructions: systemPrompt,
        input: userContent,
      }),
    });
    if (!res.ok) {
      throw new Error(`Hermes ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json();
    let output = '';
    for (const item of data.output ?? []) {
      if (item.type === 'message') {
        for (const c of item.content ?? []) {
          if (c.type === 'output_text') output += c.text;
        }
      }
    }
    const usage = data.usage ?? {};
    return {
      output: output.trim(),
      tokensIn: usage.input_tokens ?? 0,
      tokensOut: usage.output_tokens ?? 0,
    };
  } finally {
    clearTimeout(timer);
  }
}
