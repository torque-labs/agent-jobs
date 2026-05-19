import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { serverFetch } from "@/lib/server-fetch";
import type { Job, Run, StepRun } from "@/lib/types";
import { StatusBadge } from "@/lib/status";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { LivePollWrapper } from "@/components/live-poll-wrapper";
import { CancelRunButton } from "./cancel-run-button";
import { StepOutputViewer } from "./step-output-viewer";

async function getRun(id: string): Promise<Run | null> {
  try {
    return await serverFetch<Run>(`/api/runs/${id}`);
  } catch {
    return null;
  }
}

async function getJob(id: string): Promise<Job | null> {
  try {
    return await serverFetch<Job>(`/api/jobs/${id}`);
  } catch {
    return null;
  }
}

function durationLabel(startedAt: Date | string | null, endedAt: Date | string | null): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

function stepStatusBadge(status: StepRun["status"]) {
  switch (status) {
    case "pending":
      return <Badge variant="outline">pending</Badge>;
    case "running":
      return (
        <Badge className="animate-pulse" variant="default">
          running
        </Badge>
      );
    case "done":
      return (
        <Badge className="bg-green-500/15 text-green-700 dark:text-green-400">
          done
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">failed</Badge>;
    case "skipped":
      return <Badge variant="secondary">skipped</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const run = await getRun(id);
  if (!run) notFound();
  const job = await getJob(run.job_id);

  const isLive = run.status === "queued" || run.status === "running";

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">
            <Link href="/kanban" className="hover:underline">
              Runs
            </Link>{" "}
            / <span className="font-mono">{run.id.slice(0, 8)}</span>
          </div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {job ? (
              <Link href={`/jobs/${run.job_id}`} className="hover:underline">
                {job.name}
              </Link>
            ) : (
              <span className="font-mono text-base">{run.job_id}</span>
            )}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <StatusBadge status={run.status} />
            <Badge variant="outline">{run.triggered_by}</Badge>
            <span>
              Started{" "}
              {run.started_at
                ? formatDistanceToNow(new Date(run.started_at), {
                    addSuffix: true,
                  })
                : "—"}
            </span>
            <span>Duration {durationLabel(run.started_at, run.ended_at)}</span>
          </div>
        </div>
        {isLive && <CancelRunButton runId={run.id} />}
      </div>

      {run.error && (
        <Card className="border-destructive/40 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-destructive">Run error</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="overflow-x-auto whitespace-pre-wrap text-xs">
              {run.error}
            </pre>
          </CardContent>
        </Card>
      )}

      <LivePollWrapper isActive={isLive}>
        <div className="flex flex-col gap-3">
          <h2 className="font-heading text-lg font-semibold">Steps</h2>
          {(run.step_runs ?? []).length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No steps recorded yet.
              </CardContent>
            </Card>
          ) : (
            run.step_runs.map((step, idx) => (
              <Card key={`${step.step_name}-${idx}`}>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    <Badge variant="outline">{idx + 1}</Badge>
                    <span>{step.step_name}</span>
                    {stepStatusBadge(step.status)}
                    {step.tokens && (
                      <span className="ml-auto text-xs font-normal text-muted-foreground">
                        in {step.tokens.in} · out {step.tokens.out}
                      </span>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 text-sm">
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-muted-foreground">
                    <div>
                      <span className="font-medium">started:</span>{" "}
                      {step.started_at
                        ? formatDistanceToNow(new Date(step.started_at), {
                            addSuffix: true,
                          })
                        : "—"}
                    </div>
                    <div>
                      <span className="font-medium">ended:</span>{" "}
                      {step.ended_at
                        ? formatDistanceToNow(new Date(step.ended_at), {
                            addSuffix: true,
                          })
                        : "—"}
                    </div>
                    <div>
                      <span className="font-medium">duration:</span>{" "}
                      {durationLabel(step.started_at, step.ended_at)}
                    </div>
                  </div>
                  {step.error && (
                    <div className="rounded border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
                      <div className="font-medium">Error</div>
                      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">
                        {step.error}
                      </pre>
                    </div>
                  )}
                  {step.output && (
                    <StepOutputViewer output={step.output} />
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </LivePollWrapper>

      {run.final_output && (
        <>
          <Separator />
          <Card>
            <CardHeader>
              <CardTitle>Final output</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap text-sm">
                {run.final_output}
              </pre>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
