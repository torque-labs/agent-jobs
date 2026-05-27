import { Badge } from "@/components/ui/badge";

export type RunStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export function StatusBadge({ status }: { status: RunStatus | string }) {
  switch (status) {
    case "queued":
      return (
        <Badge className="animate-pulse" variant="secondary">
          queued
        </Badge>
      );
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
    case "cancelled":
      return <Badge variant="outline">cancelled</Badge>;
    case "awaiting_approval":
      return (
        <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-400 animate-pulse">
          awaiting approval
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}
