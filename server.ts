/**
 * Custom Next.js server. Replaces `next start`.
 *
 * Why custom: we need to (a) run schema bootstrap on boot and (b) start the
 * node-cron scheduler in the same process that serves HTTP. The standard
 * `next start` entrypoint doesn't give us a hook for that.
 *
 * Local dev note: `pnpm dev` still uses `next dev` (the Turbopack dev server)
 * and skips this entrypoint, so cron will NOT fire in `pnpm dev`. Use
 * `pnpm dev:server` (this file via tsx) to exercise the cron path locally.
 * In production (Coolify) the container runs `node server.js` (the compiled
 * output) via `pnpm start`.
 */
import { createServer } from 'node:http';
import { parse } from 'node:url';
import next from 'next';
import { createJob, initSchema, listJobs } from './lib/db';
import { ensureBootstrapKey } from './lib/api-keys';
import { initCron } from './lib/cron';
import { initMcp, shutdownMcp } from './lib/mcp';
import { TRUMP_DIGEST_JOB } from './seed/torque-digest';

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? '0.0.0.0';
const dev = process.env.NODE_ENV !== 'production';

async function main() {
  // 1. Migrate schema before we accept traffic. If this fails we exit non-zero
  //    so the container restarts (and the user sees the error in logs).
  try {
    await initSchema();
    console.log('[server] schema ready');
  } catch (err) {
    console.error('[server] initSchema failed — exiting:', err);
    process.exit(1);
  }

  // 2. Spawn MCP subprocesses (torque, supabase) so tool steps can drive them.
  //    Non-fatal: individual server start failures schedule retries; the HTTP
  //    server still comes up so operators can debug via the UI.
  try {
    await initMcp();
    console.log('[server] mcp initialized');
  } catch (err) {
    console.error('[server] initMcp failed (continuing without MCP):', err);
  }

  // 3. Seed default jobs if the jobs table is empty. Non-fatal: a seed
  //    failure (e.g. a constraint we didn't anticipate) shouldn't keep the
  //    server from booting — operators can always seed manually via the UI.
  try {
    await seedIfEmpty();
  } catch (err) {
    console.error('[server] seedIfEmpty failed (continuing without seed):', err);
  }

  // 3b. Provision the first API key from env if BOOTSTRAP_ADMIN_KEY is set, so
  //     the initial jobs:write key can exist without manual DB access. Non-fatal.
  if (process.env.BOOTSTRAP_ADMIN_KEY) {
    try {
      const created = await ensureBootstrapKey(process.env.BOOTSTRAP_ADMIN_KEY, ['jobs:read', 'jobs:write']);
      console.log(`[server] bootstrap api key ${created ? 'provisioned' : 'already present'} (jobs:read,jobs:write)`);
    } catch (err) {
      console.error('[server] bootstrap key failed (continuing):', err);
    }
  }

  // 4. Register cron schedules. Failures are logged but non-fatal — HTTP
  //    should still serve so the operator can fix bad cron strings via the UI.
  try {
    await initCron();
  } catch (err) {
    console.error('[server] initCron failed (continuing without scheduler):', err);
  }

  // 5. Start Next.
  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const server = createServer((req, res) => {
    const parsedUrl = req.url ? parse(req.url, true) : parse('/', true);
    handle(req, res, parsedUrl).catch((err) => {
      console.error('[server] request handler error:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('internal error');
      }
    });
  });

  server.on('error', (err) => {
    console.error('[server] HTTP server error:', err);
  });

  server.listen(port, hostname, () => {
    console.log(`[server] ready on http://${hostname}:${port}`);
  });

  // Graceful shutdown so cron + DB pool + MCP subprocesses drain cleanly.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} — shutting down`);
    server.close(() => {
      shutdownMcp().finally(() => process.exit(0));
    });
    // Hard exit if close hangs.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * If the jobs table is empty, insert the default seed jobs. We use createJob
 * directly (no upsert) — once a job exists, operators own it; we don't want
 * to silently overwrite their edits on every boot.
 */
async function seedIfEmpty(): Promise<void> {
  const existing = await listJobs();
  if (existing.length > 0) {
    console.log(`[server] seed skipped: ${existing.length} job(s) already present`);
    return;
  }
  await createJob({
    id: TRUMP_DIGEST_JOB.id,
    name: TRUMP_DIGEST_JOB.name,
    description: TRUMP_DIGEST_JOB.description,
    cron: TRUMP_DIGEST_JOB.cron,
    steps: TRUMP_DIGEST_JOB.steps,
    enabled: TRUMP_DIGEST_JOB.enabled,
  });
  console.log(`[server] seeded job: ${TRUMP_DIGEST_JOB.id}`);
}

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
