"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckIcon, XIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import type { PendingApproval } from "@/lib/types";

/**
 * Workstream H — approval panel.
 *
 * Parent (/runs/[id]/page.tsx, owned by Agent B) is responsible for fetching
 * the run, deciding whether to render this panel (status === 'awaiting_approval'
 * AND pending_approval truthy), and passing the pending_approval blob in.
 *
 * Renders the paused step's output in an editable textarea — Approve sends
 * the (possibly edited) text back to /approve, Reject prompts for a reason
 * and sends to /reject. After either action we refresh the route so the
 * parent re-reads the run status.
 */
export function ApprovalPanel({
  runId,
  pendingApproval,
}: {
  runId: string;
  pendingApproval: PendingApproval;
}) {
  const router = useRouter();
  const [edit, setEdit] = useState(pendingApproval.output);
  const [submitting, setSubmitting] = useState<"approve" | "reject" | null>(null);

  // If the underlying pending_approval changes (parent re-fetched), reset the
  // editable textarea. Without this the user would see the prior step's text
  // if the route navigates to a different paused run.
  useEffect(() => {
    setEdit(pendingApproval.output);
  }, [pendingApproval.output]);

  async function handleApprove() {
    setSubmitting("approve");
    try {
      const body = edit !== pendingApproval.output ? { edit } : {};
      const res = await fetch(`/api/runs/${runId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok && res.status !== 202) {
        throw new Error(await res.text());
      }
      toast.success("Approved — resuming run");
      router.refresh();
    } catch (err) {
      toast.error(`Failed: ${(err as Error).message}`);
    } finally {
      setSubmitting(null);
    }
  }

  async function handleReject() {
    const reason = window.prompt("Reason for rejection?");
    if (reason === null) return;
    if (reason.trim() === "") {
      toast.error("Reason required");
      return;
    }
    setSubmitting("reject");
    try {
      const res = await fetch(`/api/runs/${runId}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success("Rejected");
      router.refresh();
    } catch (err) {
      toast.error(`Failed: ${(err as Error).message}`);
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <Card className="border-amber-500/40 bg-amber-500/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Approval required
          <Badge variant="outline" className="font-mono text-xs">
            step: {pendingApproval.step_name}
          </Badge>
        </CardTitle>
        <div className="text-xs text-muted-foreground">
          Paused at{" "}
          {pendingApproval.requested_at
            ? new Date(pendingApproval.requested_at).toLocaleString()
            : "—"}
          . Review the output below, edit if needed, then Approve or Reject.
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Textarea
          value={edit}
          onChange={(e) => setEdit(e.target.value)}
          rows={Math.min(30, Math.max(8, edit.split("\n").length + 1))}
          className="font-mono text-sm"
          disabled={submitting !== null}
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={handleApprove} disabled={submitting !== null}>
            {submitting === "approve" ? (
              <Loader2Icon className="animate-spin" data-icon="inline-start" />
            ) : (
              <CheckIcon data-icon="inline-start" />
            )}
            Approve {edit !== pendingApproval.output && "(edited)"}
          </Button>
          <Button
            onClick={handleReject}
            variant="destructive"
            disabled={submitting !== null}
          >
            {submitting === "reject" ? (
              <Loader2Icon className="animate-spin" data-icon="inline-start" />
            ) : (
              <XIcon data-icon="inline-start" />
            )}
            Reject
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
