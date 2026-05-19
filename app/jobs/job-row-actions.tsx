"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontalIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function JobRowActions({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<"run" | "delete" | null>(null);

  async function handleRun() {
    setPending("run");
    try {
      const res = await fetch(`/api/jobs/${jobId}/run`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { runId: string };
      toast.success("Run started");
      router.push(`/runs/${data.runId}`);
    } catch (err) {
      toast.error(`Failed to start run: ${(err as Error).message}`);
    } finally {
      setPending(null);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this job? This cannot be undone.")) return;
    setPending("delete");
    try {
      const res = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 204) throw new Error(await res.text());
      toast.success("Job deleted");
      router.refresh();
    } catch (err) {
      toast.error(`Failed to delete: ${(err as Error).message}`);
    } finally {
      setPending(null);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" disabled={pending !== null}>
          {pending ? (
            <Loader2Icon className="animate-spin" />
          ) : (
            <MoreHorizontalIcon />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => router.push(`/jobs/${jobId}`)}>
          View
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={handleRun}>Run now</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={handleDelete}>
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
