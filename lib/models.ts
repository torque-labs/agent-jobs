import type { ModelCatalogEntry } from './types';

export const MODELS: ModelCatalogEntry[] = [
  { id: 'anthropic/claude-opus-4-7', name: 'Claude Opus 4.7 (max reasoning)', provider: 'openrouter' },
  { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6 (balanced)', provider: 'openrouter' },
  { id: 'anthropic/claude-haiku-4-5', name: 'Claude Haiku 4.5 (fast/cheap)', provider: 'openrouter' },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'openrouter' },

  { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'openrouter' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini (cheap)', provider: 'openrouter' },
  { id: 'openai/o1', name: 'OpenAI o1 (reasoning)', provider: 'openrouter' },
  { id: 'openai/o1-mini', name: 'OpenAI o1 mini', provider: 'openrouter' },
  { id: 'openai/o3-mini', name: 'OpenAI o3 mini', provider: 'openrouter' },

  { id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'openrouter' },
  { id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'openrouter' },
  { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash', provider: 'openrouter' },
  { id: 'google/gemini-2.0-flash-thinking-exp:free', name: 'Gemini 2.0 Flash Thinking (free)', provider: 'openrouter' },

  { id: 'x-ai/grok-4.1-fast', name: 'Grok 4.1 Fast', provider: 'openrouter' },
  { id: 'x-ai/grok-2-1212', name: 'Grok 2', provider: 'openrouter' },
  { id: 'x-ai/grok-beta', name: 'Grok beta', provider: 'openrouter' },

  { id: 'deepseek/deepseek-chat', name: 'DeepSeek V3 Chat', provider: 'openrouter' },
  { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1 (reasoning)', provider: 'openrouter' },
  { id: 'deepseek/deepseek-r1-distill-llama-70b', name: 'DeepSeek R1 Distill Llama 70B', provider: 'openrouter' },

  { id: 'minimax/minimax-01', name: 'MiniMax-01 (4M ctx)', provider: 'openrouter' },
  { id: 'minimax/minimax-m1', name: 'MiniMax M1', provider: 'openrouter' },
  { id: 'minimax/minimax-m2', name: 'MiniMax M2', provider: 'openrouter' },

  { id: 'tencent/hy3-preview', name: 'Tencent Hunyuan 3 (preview)', provider: 'openrouter' },
  { id: 'tencent/hunyuan-large', name: 'Tencent Hunyuan Large', provider: 'openrouter' },

  { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B', provider: 'openrouter' },
  { id: 'qwen/qwen-2.5-coder-32b-instruct', name: 'Qwen 2.5 Coder 32B', provider: 'openrouter' },
  { id: 'qwen/qwq-32b-preview', name: 'Qwen QwQ 32B (reasoning preview)', provider: 'openrouter' },

  { id: 'mistralai/mistral-large', name: 'Mistral Large', provider: 'openrouter' },
  { id: 'mistralai/mistral-medium-3', name: 'Mistral Medium 3', provider: 'openrouter' },
  { id: 'mistralai/mistral-nemo', name: 'Mistral Nemo', provider: 'openrouter' },
  { id: 'mistralai/codestral-2501', name: 'Codestral 2501', provider: 'openrouter' },

  { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', provider: 'openrouter' },
  { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B', provider: 'openrouter' },

  { id: 'nvidia/llama-3.1-nemotron-70b-instruct', name: 'Nvidia Nemotron 70B', provider: 'openrouter' },
  { id: 'nousresearch/hermes-3-llama-3.1-70b', name: 'Nous Hermes 3 70B', provider: 'openrouter' },
  { id: 'nousresearch/hermes-3-llama-3.1-405b', name: 'Nous Hermes 3 405B', provider: 'openrouter' },

  { id: 'perplexity/sonar-pro', name: 'Perplexity Sonar Pro', provider: 'openrouter' },
  { id: 'perplexity/sonar-reasoning', name: 'Perplexity Sonar Reasoning', provider: 'openrouter' },
];

export function getAllModels(): ModelCatalogEntry[] {
  return MODELS;
}
