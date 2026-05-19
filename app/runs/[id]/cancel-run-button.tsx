"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CancelRunButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleCancel() {
    if (!confirm("Cancel this run? Already-completed steps will be kept.")) return;
    setPending(true);
    try {
      const res = await fetch(`/api/runs/${runId}/cancel`, { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      toast.success("Cancellation requested");
      router.refresh();
    } catch (err) {
      toast.error(`Cancel failed: ${(err as Error).message}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <Button variant="destructive" onClick={handleCancel} disabled={pending}>
      {pending ? (
        <Loader2Icon className="animate-spin" data-icon="inline-start" />
      ) : (
        <XIcon data-icon="inline-start" />
      )}
      Cancel run
    </Button>
  );
}
