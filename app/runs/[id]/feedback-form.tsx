"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2Icon, ThumbsUpIcon, ThumbsDownIcon, MinusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import type { RunFeedback } from "@/lib/types";

type Rating = "good" | "bad" | "neutral";

/**
 * Workstream G — per-run feedback form. Renders rating buttons + comment
 * textarea, POSTs to /api/runs/:id/feedback, then re-fetches and shows the
 * full feedback list for this run below the form.
 *
 * Designed to be embedded by Agent B's /runs/[id]/page.tsx — accepts runId
 * and jobId as props (jobId not strictly needed for the POST since the server
 * derives it from the run row, but exposing it makes the prop shape obvious
 * for the parent page).
 */
export function FeedbackForm({
  runId,
  jobId: _jobId,
}: {
  runId: string;
  jobId: string;
}) {
  const [rating, setRating] = useState<Rating | null>(null);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [items, setItems] = useState<RunFeedback[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  async function loadList() {
    setLoadingList(true);
    try {
      const res = await fetch(`/api/runs/${runId}/feedback`, { cache: "no-store" });
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const data = (await res.json()) as RunFeedback[];
      setItems(data);
    } catch (err) {
      console.error("[feedback-form] list failed:", err);
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => {
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  async function handleSubmit() {
    if (!rating) {
      toast.error("Pick a rating first");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/runs/${runId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating, comment }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success("Thanks — feedback saved");
      setComment("");
      setRating(null);
      await loadList();
    } catch (err) {
      toast.error(`Failed: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Feedback</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={rating === "good" ? "default" : "outline"}
            onClick={() => setRating("good")}
            disabled={submitting}
          >
            <ThumbsUpIcon data-icon="inline-start" />
            Good
          </Button>
          <Button
            type="button"
            variant={rating === "bad" ? "default" : "outline"}
            onClick={() => setRating("bad")}
            disabled={submitting}
          >
            <ThumbsDownIcon data-icon="inline-start" />
            Bad
          </Button>
          <Button
            type="button"
            variant={rating === "neutral" ? "default" : "outline"}
            onClick={() => setRating("neutral")}
            disabled={submitting}
          >
            <MinusIcon data-icon="inline-start" />
            Neutral
          </Button>
        </div>
        <Textarea
          placeholder="What worked, what didn't, what to fix next time…"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          rows={4}
          disabled={submitting}
        />
        <div>
          <Button onClick={handleSubmit} disabled={submitting || !rating}>
            {submitting && (
              <Loader2Icon className="animate-spin" data-icon="inline-start" />
            )}
            Submit feedback
          </Button>
        </div>

        <div className="mt-2 border-t pt-4">
          <div className="mb-2 text-xs uppercase text-muted-foreground">
            Feedback on this run ({items.length})
          </div>
          {loadingList ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : items.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No feedback yet.
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((it) => (
                <li
                  key={it.id}
                  className="rounded-lg border bg-background/40 p-3 text-sm"
                >
                  <div className="flex items-center gap-2">
                    <RatingBadge rating={it.rating} />
                    <span className="text-xs text-muted-foreground">
                      {new Date(it.created_at).toLocaleString()}
                    </span>
                    {it.created_by && (
                      <span className="text-xs text-muted-foreground">
                        · {it.created_by}
                      </span>
                    )}
                  </div>
                  {it.comment && (
                    <div className="mt-1 whitespace-pre-wrap">{it.comment}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function RatingBadge({ rating }: { rating: Rating }) {
  switch (rating) {
    case "good":
      return (
        <Badge className="bg-green-500/15 text-green-700 dark:text-green-400">
          good
        </Badge>
      );
    case "bad":
      return <Badge variant="destructive">bad</Badge>;
    case "neutral":
      return <Badge variant="secondary">neutral</Badge>;
  }
}
