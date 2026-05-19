export type StepDefinition = {
  name: string;                   // unique within job
  model: string;                  // e.g. "anthropic/claude-sonnet-4.6" or "hermes-agent" for Hermes-routed (gets MCP tools)
  system_prompt: string;
  user_template: string;          // can reference prior step outputs: "{{steps.fetcher.output}}"
  tools_allowed: string[] | null; // null = all available on the model; only relevant for Hermes-routed steps
  retries: number;                // default 1
  timeout_seconds: number;        // default 600
  // Workstream H — pause execution after this step and wait for a human to
  // call /api/runs/:id/approve (or /reject) before continuing. Default false
  // so legacy jobs keep their fire-and-forget semantics.
  approval_required?: boolean;
  // Workstream G — inject the last few feedback entries for this job into the
  // system prompt so the model can learn from prior corrections. Default false.
  use_feedback?: boolean;
};

export type Job = {
  id: string;
  name: string;
  description: string;
  cron: string | null;
  steps: StepDefinition[];
  enabled: boolean;
  trigger_token: string | null;
  trigger_enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

export type Webhook = {
  id: string;
  name: string;
  url: string;
  events: string[];
  secret: string;
  enabled: boolean;
  created_at: Date;
};

export type WebhookDelivery = {
  id: string;
  webhook_id: string;
  event: string;
  payload: unknown;
  attempt: number;
  next_attempt_at: Date | null;
  delivered_at: Date | null;
  dead_lettered_at: Date | null;
  last_status: number | null;
  last_error: string | null;
  created_at: Date;
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

export type PendingApproval = {
  step_name: string;
  output: string;
  requested_at: string;  // ISO timestamp
};

export type Run = {
  id: string;
  job_id: string;
  status: 'queued' | 'running' | 'awaiting_approval' | 'done' | 'failed' | 'cancelled';
  triggered_by: 'cron' | 'manual' | 'chat' | 'trigger';
  started_at: Date | null;
  ended_at: Date | null;
  step_runs: StepRun[];
  final_output: string | null;
  error: string | null;
  pending_approval: PendingApproval | null;
  created_at: Date;
};

export type RunFeedback = {
  id: string;
  run_id: string;
  job_id: string;
  rating: 'good' | 'bad' | 'neutral';
  comment: string;
  created_at: Date;
  created_by: string | null;
};

export type ModelCatalogEntry = {
  id: string;       // canonical model identifier (e.g. "anthropic/claude-sonnet-4.6")
  name: string;     // display label
  provider: string; // "openrouter" | "hermes" etc.
};

export type ApiKey = {
  id: string;
  name: string;
  key_prefix: string;         // first 12 chars of the plain key, safe to display
  scopes: string[];           // see lib/scopes.ts
  created_by: string | null;  // user email (Supabase) or "basic-auth" fallback
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};
