import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { serverFetch } from "@/lib/server-fetch";
import type { Job, Run } from "@/lib/types";
import { StatusBadge } from "@/lib/status";
import { JobRowActions } from "./job-row-actions";

type JobWithLastRun = Job & { last_run?: Run | null };

async function getJobs(): Promise<JobWithLastRun[]> {
  try {
    const jobs = await serverFetch<JobWithLastRun[]>("/api/jobs");
    return jobs;
  } catch {
    return [];
  }
}

export default async function JobsPage() {
  const jobs = await getJobs();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Jobs
          </h1>
          <p className="text-sm text-muted-foreground">
            Scheduled and on-demand multi-step agent jobs.
          </p>
        </div>
        <Button asChild>
          <Link href="/jobs/new">+ New Job</Link>
        </Button>
      </div>

      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Cron schedule</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>Steps</TableHead>
              <TableHead>Last run</TableHead>
              <TableHead className="w-12 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="py-8 text-center text-muted-foreground"
                >
                  No jobs yet.{" "}
                  <Link
                    href="/jobs/new"
                    className="underline underline-offset-4"
                  >
                    Create one
                  </Link>
                  .
                </TableCell>
              </TableRow>
            ) : (
              jobs.map((job) => (
                <TableRow key={job.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/jobs/${job.id}`}
                      className="hover:underline"
                    >
                      {job.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {job.cron ?? "—"}
                  </TableCell>
                  <TableCell>
                    {job.enabled ? (
                      <Badge className="bg-green-500/15 text-green-700 dark:text-green-400">
                        enabled
                      </Badge>
                    ) : (
                      <Badge variant="secondary">disabled</Badge>
                    )}
                  </TableCell>
                  <TableCell>{job.steps?.length ?? 0}</TableCell>
                  <TableCell>
                    {job.last_run ? (
                      <StatusBadge status={job.last_run.status} />
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <JobRowActions jobId={job.id} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
