import Link from "next/link";
import { notFound } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { serverFetch } from "@/lib/server-fetch";
import type { Job, Run } from "@/lib/types";
import { StatusBadge } from "@/lib/status";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LivePollWrapper } from "@/components/live-poll-wrapper";
import { JobDetailActions } from "./job-detail-actions";

async function getJob(id: string): Promise<Job | null> {
  try {
    return await serverFetch<Job>(`/api/jobs/${id}`);
  } catch {
    return null;
  }
}

async function getRuns(jobId: string): Promise<Run[]> {
  try {
    return await serverFetch<Run[]>(`/api/runs?jobId=${jobId}`);
  } catch {
    return [];
  }
}

function durationLabel(run: Run): string {
  if (!run.started_at) return "—";
  const start = new Date(run.started_at).getTime();
  const end = run.ended_at ? new Date(run.ended_at).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

export default async function JobDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [job, runs] = await Promise.all([getJob(id), getRuns(id)]);
  if (!job) notFound();

  const hasLiveRun = runs.some(
    (r) => r.status === "running" || r.status === "queued",
  );

  return (
    <LivePollWrapper isActive={hasLiveRun}>
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xs text-muted-foreground">
            <Link href="/jobs" className="hover:underline">
              Jobs
            </Link>{" "}
            / <span className="font-mono">{job.id}</span>
          </div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {job.name}
          </h1>
          {job.description && (
            <p className="mt-1 text-sm text-muted-foreground">
              {job.description}
            </p>
          )}
        </div>
        <JobDetailActions jobId={job.id} />
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="history">Run History</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Metadata</CardTitle>
            </CardHeader>
            <CardContent className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div>
                <div className="text-xs uppercase text-muted-foreground">
                  Cron
                </div>
                <div className="font-mono">{job.cron ?? "—"}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-muted-foreground">
                  Enabled
                </div>
                <div>
                  {job.enabled ? (
                    <Badge className="bg-green-500/15 text-green-700 dark:text-green-400">
                      enabled
                    </Badge>
                  ) : (
                    <Badge variant="secondary">disabled</Badge>
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs uppercase text-muted-foreground">
                  Steps
                </div>
                <div>{job.steps?.length ?? 0}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-muted-foreground">
                  Updated
                </div>
                <div>
                  {job.updated_at
                    ? formatDistanceToNow(new Date(job.updated_at), {
                        addSuffix: true,
                      })
                    : "—"}
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Steps</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {(job.steps ?? []).map((step, i) => (
                <div
                  key={`${step.name}-${i}`}
                  className="rounded-lg border bg-background/40 p-3"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{i + 1}</Badge>
                    <span className="font-medium">{step.name}</span>
                    <Badge variant="secondary" className="font-mono text-xs">
                      {step.model}
                    </Badge>
                  </div>
                  {step.system_prompt && (
                    <div className="mt-2 text-xs text-muted-foreground">
                      <span className="font-medium">system:</span>{" "}
                      <span className="line-clamp-2">{step.system_prompt}</span>
                    </div>
                  )}
                  {step.user_template && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      <span className="font-medium">user:</span>{" "}
                      <span className="line-clamp-2 font-mono">
                        {step.user_template}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Started</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Triggered by</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="py-8 text-center text-muted-foreground"
                      >
                        No runs yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    runs.map((run) => (
                      <TableRow key={run.id}>
                        <TableCell className="font-mono text-xs">
                          <Link
                            href={`/runs/${run.id}`}
                            className="hover:underline"
                          >
                            {run.id.slice(0, 8)}
                          </Link>
                        </TableCell>
                        <TableCell>
                          {run.started_at
                            ? formatDistanceToNow(new Date(run.started_at), {
                                addSuffix: true,
                              })
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={run.status} />
                        </TableCell>
                        <TableCell>{durationLabel(run)}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{run.triggered_by}</Badge>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
    </LivePollWrapper>
  );
}
