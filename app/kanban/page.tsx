"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { Loader2Icon } from "lucide-react";
import type { Job, Run } from "@/lib/types";
import { StatusBadge, type RunStatus } from "@/lib/status";
import { Card } from "@/components/ui/card";

type Column = {
  key: "queued" | "running" | "done" | "failed";
  label: string;
};

const COLUMNS: Column[] = [
  { key: "queued", label: "Queued" },
  { key: "running", label: "Running" },
  { key: "done", label: "Done" },
  { key: "failed", label: "Failed" },
];

export default function KanbanPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [jobsById, setJobsById] = useState<Record<string, Job>>({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      try {
        const [runsRes, jobsRes] = await Promise.all([
          fetch("/api/runs", { cache: "no-store" }),
          fetch("/api/jobs", { cache: "no-store" }),
        ]);
        if (!runsRes.ok) throw new Error(`runs ${runsRes.status}`);
        if (!jobsRes.ok) throw new Error(`jobs ${jobsRes.status}`);
        const runsData = (await runsRes.json()) as Run[];
        const jobsData = (await jobsRes.json()) as Job[];
        if (cancelled) return;
        setRuns(runsData);
        setJobsById(
          jobsData.reduce<Record<string, Job>>((acc, j) => {
            acc[j.id] = j;
            return acc;
          }, {})
        );
        setErr(null);
      } catch (e) {
        if (!cancelled) {
          setErr((e as Error).message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (err) {
      toast.error(`Failed to refresh: ${err}`, { id: "kanban-err" });
    }
  }, [err]);

  const grouped = COLUMNS.reduce<Record<string, Run[]>>((acc, col) => {
    acc[col.key] = runs.filter((r) => r.status === col.key);
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Kanban
          </h1>
          <p className="text-sm text-muted-foreground">
            Live view of every run. Auto-refreshes every 5s.
          </p>
        </div>
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2Icon className="size-3 animate-spin" /> loading
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map((col) => (
          <div
            key={col.key}
            className="flex min-h-[400px] flex-col gap-3 rounded-xl border bg-muted/30 p-3"
          >
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <StatusBadge status={col.key as RunStatus} />
                <span className="text-xs text-muted-foreground">
                  {grouped[col.key].length}
                </span>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              {grouped[col.key].length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                  Nothing here.
                </div>
              ) : (
                grouped[col.key].map((run) => (
                  <RunCard
                    key={run.id}
                    run={run}
                    jobName={jobsById[run.job_id]?.name ?? run.job_id}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RunCard({ run, jobName }: { run: Run; jobName: string }) {
  const total = run.step_runs?.length ?? 0;
  const done = (run.step_runs ?? []).filter(
    (s) => s.status === "done" || s.status === "skipped"
  ).length;
  const startedAt = run.started_at ?? run.created_at;
  return (
    <Link href={`/runs/${run.id}`} className="block">
      <Card
        size="sm"
        className="cursor-pointer transition-colors hover:bg-accent/40"
      >
        <div className="flex flex-col gap-1.5 px-3">
          <div className="flex items-center justify-between gap-2">
            <span className="line-clamp-1 text-sm font-medium">{jobName}</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {run.id.slice(0, 6)}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {startedAt
                ? formatDistanceToNow(new Date(startedAt), { addSuffix: true })
                : "—"}
            </span>
            <span>
              {done}/{total} steps
            </span>
          </div>
        </div>
      </Card>
    </Link>
  );
}
