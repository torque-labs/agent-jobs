import { notFound } from "next/navigation";
import Link from "next/link";
import { serverFetch } from "@/lib/server-fetch";
import type { Job } from "@/lib/types";
import { EditJobForm } from "@/app/jobs/[id]/edit-job-form";

async function getJob(id: string): Promise<Job | null> {
  try {
    return await serverFetch<Job>(`/api/jobs/${id}`);
  } catch {
    return null;
  }
}

export default async function EditJobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) notFound();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <div className="text-xs text-muted-foreground">
          <Link href="/jobs" className="hover:underline">
            Jobs
          </Link>{" "}
          /{" "}
          <Link href={`/jobs/${job.id}`} className="hover:underline">
            {job.name}
          </Link>{" "}
          / Edit
        </div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Edit job
        </h1>
      </div>
      <EditJobForm job={job} />
    </div>
  );
}
