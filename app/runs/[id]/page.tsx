import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  CheckIcon,
  XIcon,
  Loader2Icon,
  PauseIcon,
  ClockIcon,
  HourglassIcon,
} from "lucide-react";
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
import { LivePollWrapper } from "@/components/live-poll-wrapper";
import { CancelRunButton } from "./cancel-run-button";
import { StepOutputViewer } from "./step-output-viewer";
import { MarkdownView } from "./markdown-view";
import { ApprovalPanel } from "./approval-panel";
import { FeedbackForm } from "./feedback-form";

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

function StepNode({
  status,
  index,
  awaiting,
}: {
  status: StepRun["status"];
  index: number;
  awaiting: boolean;
}) {
  const base =
    "relative z-10 grid h-7 w-7 place-items-center rounded-full ring-4 ring-background";
  if (awaiting) {
    return (
      <div className={`${base} bg-amber-500/15 text-amber-600`}>
        <PauseIcon className="h-4 w-4" />
      </div>
    );
  }
  switch (status) {
    case "done":
      return (
        <div className={`${base} bg-green-500/15 text-green-600`}>
          <CheckIcon className="h-4 w-4" />
        </div>
      );
    case "running":
      return (
        <div className={`${base} bg-primary/15 text-primary`}>
          <Loader2Icon className="h-4 w-4 animate-spin" />
        </div>
      );
    case "failed":
      return (
        <div className={`${base} bg-destructive/15 text-destructive`}>
          <XIcon className="h-4 w-4" />
        </div>
      );
    default:
      return (
        <div className={`${base} bg-muted text-xs font-medium text-muted-foreground`}>
          {index + 1}
        </div>
      );
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
  const awaiting = !!run.pending_approval;
  const steps = run.step_runs ?? [];
  const doneCount = steps.filter((s) => s.status === "done").length;
  const isFinished =
    run.status === "done" ||
    run.status === "failed" ||
    run.status === "cancelled";

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex flex-col gap-2">
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
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <StatusBadge status={awaiting ? "awaiting_approval" : run.status} />
            <Badge variant="outline">{run.triggered_by}</Badge>
            <span className="flex items-center gap-1">
              <ClockIcon className="h-3.5 w-3.5" />
              Started{" "}
              {run.started_at
                ? formatDistanceToNow(new Date(run.started_at), {
                    addSuffix: true,
                  })
                : "—"}
            </span>
            <span className="flex items-center gap-1">
              <HourglassIcon className="h-3.5 w-3.5" />
              Duration {durationLabel(run.started_at, run.ended_at)}
            </span>
            <span>
              {doneCount}/{steps.length} steps done
            </span>
          </div>
        </div>
        {isLive && <CancelRunButton runId={run.id} />}
      </div>

      {/* Approval — primary action, surfaced first */}
      {run.pending_approval && (
        <ApprovalPanel runId={run.id} pendingApproval={run.pending_approval} />
      )}

      {/* Run error */}
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

      {/* Steps timeline */}
      <LivePollWrapper isActive={isLive}>
        <div className="flex flex-col gap-3">
          <h2 className="font-heading text-lg font-semibold">Steps</h2>
          {steps.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No steps recorded yet.
              </CardContent>
            </Card>
          ) : (
            <div className="relative flex flex-col gap-4">
              <div
                aria-hidden
                className="absolute bottom-0 left-3.5 top-0 w-px -translate-x-1/2 bg-border"
              />
              {steps.map((step, idx) => {
                const stepAwaiting =
                  awaiting &&
                  run.pending_approval?.step_name === step.step_name;
                return (
                  <div
                    key={`${step.step_name}-${idx}`}
                    className="relative flex gap-4"
                  >
                    <StepNode
                      status={step.status}
                      index={idx}
                      awaiting={stepAwaiting}
                    />
                    <Card className="min-w-0 flex-1">
                      <CardHeader>
                        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                          <span className="font-medium">{step.step_name}</span>
                          {stepStatusBadge(step.status)}
                          <span className="ml-auto flex items-center gap-2 text-xs font-normal text-muted-foreground">
                            <span>{durationLabel(step.started_at, step.ended_at)}</span>
                            {step.tokens && (
                              <span>
                                in {step.tokens.in} · out {step.tokens.out}
                              </span>
                            )}
                          </span>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-3 text-sm">
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
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </LivePollWrapper>

      {/* Published report */}
      {run.final_output && !run.pending_approval && (
        <Card>
          <CardHeader>
            <CardTitle>Published report</CardTitle>
          </CardHeader>
          <CardContent>
            <MarkdownView source={run.final_output} />
          </CardContent>
        </Card>
      )}

      {/* Feedback — only once the run has finished */}
      {isFinished && <FeedbackForm runId={run.id} jobId={run.job_id} />}
    </div>
  );
}
