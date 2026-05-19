export type StepDefinition = {
  name: string;                   // unique within job
  model: string;                  // e.g. "anthropic/claude-sonnet-4-6" or "hermes-agent" for Hermes-routed (gets MCP tools)
  system_prompt: string;
  user_template: string;          // can reference prior step outputs: "{{steps.fetcher.output}}"
  tools_allowed: string[] | null; // null = all available on the model; only relevant for Hermes-routed steps
  retries: number;                // default 1
  timeout_seconds: number;        // default 600
};

export type Job = {
  id: string;
  name: string;
  description: string;
  cron: string | null;
  steps: StepDefinition[];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

export type StepRun = {
  step_name: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  output: string | null;
  tokens: { in: number; out: number } | null;
  cost_usd: number | null;
  started_at: string | null;
  ended_at: string | null;
  error: string | null;
};

export type Run = {
  id: string;
  job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  triggered_by: 'cron' | 'manual' | 'chat';
  started_at: Date | null;
  ended_at: Date | null;
  step_runs: StepRun[];
  final_output: string | null;
  error: string | null;
  created_at: Date;
};

export type ModelCatalogEntry = {
  id: string;       // canonical model identifier (e.g. "anthropic/claude-sonnet-4-6")
  name: string;     // display label
  provider: string; // "openrouter" | "hermes" etc.
};
