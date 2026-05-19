"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2Icon, SendIcon, SaveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Job } from "@/lib/types";

type DraftJob = Omit<Job, "id" | "created_at" | "updated_at">;

type TranslateResponse = {
  job: DraftJob;
  explanation: string;
};

export default function ChatPage() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [translating, setTranslating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TranslateResponse | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) {
      toast.error("Describe the job first");
      return;
    }
    setTranslating(true);
    setResult(null);
    try {
      const res = await fetch("/api/chat/translate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as TranslateResponse;
      setResult(data);
    } catch (err) {
      toast.error(`Translate failed: ${(err as Error).message}`);
    } finally {
      setTranslating(false);
    }
  }

  async function saveAsJob() {
    if (!result) return;
    setSaving(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result.job),
      });
      if (!res.ok) throw new Error(await res.text());
      const job = (await res.json()) as Job;
      toast.success("Job created");
      router.push(`/jobs/${job.id}`);
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Chat translator
        </h1>
        <p className="text-sm text-muted-foreground">
          Describe the job in plain English; we&apos;ll draft the spec.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Every weekday at 8am, fetch top crypto headlines, summarize them in three bullets, and email me the result."
          className="min-h-32"
        />
        <div className="flex justify-end">
          <Button type="submit" disabled={translating}>
            {translating ? (
              <Loader2Icon className="animate-spin" data-icon="inline-start" />
            ) : (
              <SendIcon data-icon="inline-start" />
            )}
            Translate
          </Button>
        </div>
      </form>

      {result && (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Explanation</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {result.explanation}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Job spec preview</span>
                <Button onClick={saveAsJob} disabled={saving} size="sm">
                  {saving ? (
                    <Loader2Icon
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  ) : (
                    <SaveIcon data-icon="inline-start" />
                  )}
                  Save as job
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="overflow-x-auto rounded-lg border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
                {JSON.stringify(result.job, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
