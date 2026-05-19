"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2Icon, PlayIcon, PencilIcon, TrashIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog";

export function JobDetailActions({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleRun() {
    setRunning(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}/run`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const { runId } = (await res.json()) as { runId: string };
      toast.success("Run started");
      router.push(`/runs/${runId}`);
    } catch (err) {
      toast.error(`Failed: ${(err as Error).message}`);
    } finally {
      setRunning(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(await res.text());
      toast.success("Job deleted");
      router.push("/jobs");
    } catch (err) {
      toast.error(`Failed: ${(err as Error).message}`);
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={handleRun} disabled={running}>
        {running ? (
          <Loader2Icon className="animate-spin" data-icon="inline-start" />
        ) : (
          <PlayIcon data-icon="inline-start" />
        )}
        Run now
      </Button>
      <Button asChild variant="outline">
        <Link href={`/jobs/${jobId}/edit`}>
          <PencilIcon data-icon="inline-start" />
          Edit
        </Link>
      </Button>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="destructive">
            <TrashIcon data-icon="inline-start" />
            Delete
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this job?</DialogTitle>
            <DialogDescription>
              This will remove the job definition. Past runs will remain.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && (
                <Loader2Icon
                  className="animate-spin"
                  data-icon="inline-start"
                />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
