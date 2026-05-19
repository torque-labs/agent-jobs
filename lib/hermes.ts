import OpenAI from 'openai';

/**
 * Hermes Agent gateway client (OpenAI-compatible). When called with
 * `model: 'hermes-agent'` the gateway internally fans out to MCP tools and
 * may return multiple turns of tool_calls before producing a final text
 * response — the orchestrator handles the loop.
 */
export function createHermesClient(): OpenAI {
  const base = process.env.HERMES_API_URL;
  const token = process.env.HERMES_API_TOKEN;
  if (!base) throw new Error('HERMES_API_URL env var is required');
  if (!token) throw new Error('HERMES_API_TOKEN env var is required');
  return new OpenAI({
    baseURL: `${base.replace(/\/$/, '')}/v1`,
    apiKey: token,
  });
}

/**
 * Direct OpenRouter client for non-Hermes models. No MCP tools are exposed on
 * this path — tool_calls won't appear in responses.
 */
export function createOpenRouterClient(): OpenAI {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY env var is required');
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: key,
  });
}

/**
 * Route a step to the right gateway based on its declared model. The Hermes
 * alias 'hermes-agent' is the only trigger for the gateway path; everything
 * else hits OpenRouter directly.
 */
export function selectClient(model: string): OpenAI {
  if (model === 'hermes-agent') return createHermesClient();
  return createOpenRouterClient();
}

/**
 * Convenience: is this step routed through Hermes (and therefore eligible for
 * multi-turn MCP tool_call loops)?
 */
export function isHermesModel(model: string): boolean {
  return model === 'hermes-agent';
}
