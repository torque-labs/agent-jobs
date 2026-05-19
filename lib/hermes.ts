import OpenAI from 'openai';

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
