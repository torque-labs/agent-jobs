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

// ---------------------------------------------------------------------------
// Multi-tenant Hermes customer-agent runtime.
//
// Each tenant is one Torque customer with a private conversational agent. The
// isolation boundary is `torque_mcp_token`: a scoped Torque MCP JWT minted from
// a wallet that administers ONLY that customer's project, so the agent can only
// ever read that one project's data. See lib/agent-runtime.ts.
// ---------------------------------------------------------------------------

/** Per-channel config. Bot tokens / signing secrets are secrets. */
export type TenantChannels = {
  telegram?: {
    /** Per-tenant bot token (white-label). OPTIONAL: shared mode uses env TELEGRAM_BOT_TOKEN. */
    bot_token?: string;
    /** Telegram chat ids allowed to talk — also the chat→tenant routing key in shared mode. */
    allowed_chats: string[];
    /**
     * Secret token echoed by Telegram in X-Telegram-Bot-Api-Secret-Token.
     * Required by the per-tenant route (fails closed without it); shared route
     * verifies env TELEGRAM_WEBHOOK_SECRET instead.
     */
    webhook_secret?: string;
    /**
     * Opt out of the allow-list and accept ANY chat (M2). Must be set
     * explicitly; an empty allowed_chats does NOT imply allow-all.
     */
    allow_all?: boolean;
  };
  slack?: {
    /** Per-tenant bot token (white-label). OPTIONAL: shared mode uses env. */
    bot_token?: string;
    /** Per-tenant signing secret. OPTIONAL in shared mode (env). */
    signing_secret?: string;
    /** Slack channel ids allowed to talk to this tenant's app. */
    allowed_channels: string[];
    /**
     * Opt out of the allow-list and accept ANY channel (M2). Must be set
     * explicitly; an empty allowed_channels does NOT imply allow-all.
     */
    allow_all?: boolean;
  };
};

/** Optional extra knowledge sources beyond Torque (docs, FAQ urls, etc.). */
export type TenantDataSource = {
  type: string;
  label?: string;
  value: string;
};

export type Tenant = {
  id: string;
  slug: string;
  display_name: string;
  torque_project_id: string;
  torque_wallet_pubkey: string;
  // Secrets — never serialized to API responses (see lib/tenants.ts redaction).
  torque_mcp_token: string;
  torque_ingest_key: string | null;
  model: string;
  provider: string;
  soul: string;                 // SOUL.md persona / system prompt
  channels: TenantChannels;
  memory_namespace: string;
  data_sources: TenantDataSource[] | null;
  status: 'active' | 'paused' | 'disabled';
  owner: string | null;
  created_at: Date;
  updated_at: Date;
};

/** Tenant with all secret fields stripped — safe to return over the API. */
export type PublicTenant = Omit<
  Tenant,
  'torque_mcp_token' | 'torque_ingest_key' | 'channels'
> & {
  channels: PublicTenantChannels;
  has_torque_ingest_key: boolean;
};

/** Channel config with bot tokens / signing secrets redacted. */
export type PublicTenantChannels = {
  telegram?: { allowed_chats: string[]; configured: boolean };
  slack?: { allowed_channels: string[]; configured: boolean };
};
