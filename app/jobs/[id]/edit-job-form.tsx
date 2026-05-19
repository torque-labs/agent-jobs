"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2Icon, TrashIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { getAllModels } from "@/lib/models";
import type { Job, StepDefinition } from "@/lib/types";

type DraftStep = StepDefinition & { _key: string };

function toDraft(step: StepDefinition): DraftStep {
  return {
    _key:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2),
    name: step.name,
    model: step.model,
    system_prompt: step.system_prompt,
    user_template: step.user_template,
    tools_allowed: step.tools_allowed,
    retries: step.retries,
    timeout_seconds: step.timeout_seconds,
  };
}

function blankStep(): DraftStep {
  return toDraft({
    name: "",
    model: "anthropic/claude-sonnet-4.6",
    system_prompt: "",
    user_template: "",
    tools_allowed: null,
    retries: 1,
    timeout_seconds: 600,
  });
}

export function EditJobForm({ job }: { job: Job }) {
  const router = useRouter();
  const models = getAllModels();
  const [name, setName] = useState(job.name);
  const [description, setDescription] = useState(job.description);
  const [cron, setCron] = useState(job.cron ?? "");
  const [enabled, setEnabled] = useState(job.enabled);
  const [steps, setSteps] = useState<DraftStep[]>(
    (job.steps ?? []).map(toDraft),
  );
  const [submitting, setSubmitting] = useState(false);

  function updateStep(key: string, patch: Partial<DraftStep>) {
    setSteps((prev) =>
      prev.map((s) => (s._key === key ? { ...s, ...patch } : s)),
    );
  }

  function removeStep(key: string) {
    setSteps((prev) =>
      prev.length === 1 ? prev : prev.filter((s) => s._key !== key),
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (steps.some((s) => !s.name.trim() || !s.model)) {
      toast.error("Every step needs a name and model");
      return;
    }
    setSubmitting(true);
    try {
      // Send the full set of editable fields so we always sync UI state
      // back to the server, even if the user only touched one thing. The
      // PATCH route accepts partial updates, so this is safe.
      const body = {
        name: name.trim(),
        description: description.trim(),
        cron: cron.trim() === "" ? null : cron.trim(),
        enabled,
        steps: steps.map((s) => ({
          name: s.name.trim(),
          model: s.model,
          system_prompt: s.system_prompt,
          user_template: s.user_template,
          tools_allowed: s.tools_allowed,
          retries: s.retries,
          timeout_seconds: s.timeout_seconds,
        })),
      };
      const res = await fetch(`/api/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success("Job updated");
      router.push(`/jobs/${job.id}`);
      router.refresh();
    } catch (err) {
      toast.error(`Save failed: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <div className="flex items-center justify-end gap-2">
        <Button asChild variant="outline" type="button">
          <Link href={`/jobs/${job.id}`}>Cancel</Link>
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting && (
            <Loader2Icon className="animate-spin" data-icon="inline-start" />
          )}
          Save changes
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Job metadata</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cron">Cron schedule</Label>
              <Input
                id="cron"
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                placeholder="0 2 * * *"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Leave empty for manual-only. Changes re-register the cron
                handle on save.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="enabled">Enabled</Label>
              <label className="inline-flex h-8 cursor-pointer items-center gap-2 text-sm">
                <input
                  id="enabled"
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="size-4 accent-primary"
                />
                {enabled ? "On" : "Off"}
              </label>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        <h2 className="font-heading text-lg font-semibold">Steps</h2>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setSteps((prev) => [...prev, blankStep()])}
        >
          <PlusIcon data-icon="inline-start" />
          Add step
        </Button>
      </div>

      <div className="flex flex-col gap-4">
        {steps.map((step, idx) => (
          <Card key={step._key}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Step {idx + 1}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => removeStep(step._key)}
                  disabled={steps.length === 1}
                >
                  <TrashIcon />
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label>Name</Label>
                  <Input
                    value={step.name}
                    onChange={(e) =>
                      updateStep(step._key, { name: e.target.value })
                    }
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Model</Label>
                  <Select
                    value={step.model}
                    onValueChange={(v) => updateStep(step._key, { model: v })}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>System prompt</Label>
                <Textarea
                  rows={6}
                  value={step.system_prompt}
                  onChange={(e) =>
                    updateStep(step._key, { system_prompt: e.target.value })
                  }
                  className="min-h-32"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>User template</Label>
                <Textarea
                  rows={4}
                  value={step.user_template}
                  onChange={(e) =>
                    updateStep(step._key, { user_template: e.target.value })
                  }
                  className="min-h-24 font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  Use <code>{`{{steps.X.output}}`}</code> to reference earlier
                  step outputs.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label>Tools allowed</Label>
                  <Input
                    value={step.tools_allowed?.join(", ") ?? ""}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      updateStep(step._key, {
                        tools_allowed:
                          raw === ""
                            ? null
                            : raw
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean),
                      });
                    }}
                    placeholder="tool1, tool2"
                  />
                  <p className="text-xs text-muted-foreground">
                    Empty = all tools.
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Retries</Label>
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    value={step.retries}
                    onChange={(e) =>
                      updateStep(step._key, {
                        retries: Number.parseInt(e.target.value, 10) || 0,
                      })
                    }
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Timeout (s)</Label>
                  <Input
                    type="number"
                    min={1}
                    value={step.timeout_seconds}
                    onChange={(e) =>
                      updateStep(step._key, {
                        timeout_seconds:
                          Number.parseInt(e.target.value, 10) || 600,
                      })
                    }
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Separator />
      <div className="flex justify-end gap-2">
        <Button asChild variant="outline" type="button">
          <Link href={`/jobs/${job.id}`}>Cancel</Link>
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting && (
            <Loader2Icon className="animate-spin" data-icon="inline-start" />
          )}
          Save changes
        </Button>
      </div>
    </form>
  );
}
