# agent-jobs

Multi-agent job/workflow platform for scheduled and manually triggered tasks. Each job is a sequence of LLM steps (Anthropic / OpenAI / Google / Hermes-routed with MCP tools), wired together via templated prompts and run on cron or on demand. Outputs land in Postgres and can be published downstream (e.g. Outline).

## Local development

```bash
git clone git@github.com:torque-labs/agent-jobs.git
cd agent-jobs
pnpm install
cp .env.example .env.local
# fill in DATABASE_URL at minimum
pnpm dev
```

Then open http://localhost:3000.

## Deployment

Target: Coolify app at `jobs.coolify.torque.so`. Postgres is the existing Coolify Postgres instance; the orchestrator and cron run inside the same Next.js process.

## Architecture

See the full design + phased build plan at:

`/Users/smick/.claude/plans/let-s-think-about-it-jiggly-pebble.md`

Round 0 (this repo state) ships the scaffold only: Next.js 15 + Tailwind v4 + shadcn (radix / nova preset), the shared `lib/types.ts` contract, and `lib/models.ts` model catalog. DB schema, orchestrator, API routes, UI pages, and cron are delivered by subsequent rounds.

## Auth

Three layers, applied in order by `proxy.ts` (Next 16's renamed `middleware.ts`):

1. **API key (Bearer)** — required for every `/api/v1/*` route. Keys are
   created in the UI (`/settings/keys`) or via `POST /api/v1/keys` (scope:
   `keys:admin`). The plain key is shown once at creation; we store SHA-256
   of it plus a 12-char prefix.
2. **Supabase Google OAuth** — restricted to `@torque.so` accounts. Used for
   the browser UI and the internal `/api/*` routes.
3. **Basic auth (`APP_PASSWORD`)** — fallback for when Supabase isn't
   configured. Enable with `ALLOW_BASIC_AUTH=true`. Keeps existing curl
   workflows alive during rollout.

### Scopes

Declared in `lib/scopes.ts` and enforced per-route via `requireScope`:

- `jobs:read`, `jobs:write`
- `runs:read`, `runs:trigger`, `runs:cancel`
- `webhooks:admin`
- `keys:admin`
- `admin` (implies everything)

### Supabase setup (one-time, manual)

The Supabase project + Google provider must be wired by hand. Until the env
vars below are set, the proxy skips OAuth and falls back to basic auth so the
UI keeps working.

1. Create (or reuse) a Supabase project for Torque internal tools.
2. Enable the **Google** provider. Paste in a Google OAuth client_id +
   client_secret from console.cloud.google.com (any Torque-owned GCP project).
3. Add `https://jobs.coolify.torque.so/auth/callback` to the provider's
   **Authorized redirect URIs**.
4. Set these env vars in Coolify (app `tg884kogsosg0s4wsc0so8g0`):
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (server-only)
5. Trigger a redeploy.

Once the env vars are present, the Login page swaps the basic-auth challenge
for the Google button automatically.

### API key quickstart

```bash
# Create a read-only key (basic auth example — replace with the deployed password)
curl -u admin:changeme-jobs-2026 \
  -X POST https://jobs.coolify.torque.so/api/internal/keys \
  -H 'content-type: application/json' \
  -d '{"name":"laptop","scopes":["jobs:read"]}'

# Use the returned plain_key
curl -H 'Authorization: Bearer ak_live_...' \
  https://jobs.coolify.torque.so/api/v1/jobs
```
