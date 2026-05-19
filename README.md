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
