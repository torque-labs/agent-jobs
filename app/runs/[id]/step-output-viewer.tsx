"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

const TRUNCATE_AT = 500;

/**
 * Show the first ~500 chars of a step output with a "show more" toggle to
 * expand the full body. Keeps the run-detail page scannable when steps
 * produce long markdown reports.
 */
export function StepOutputViewer({ output }: { output: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = output.length > TRUNCATE_AT;
  const display = expanded || !needsTruncation
    ? output
    : output.slice(0, TRUNCATE_AT) + "…";

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-muted-foreground">Output</div>
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
        {display}
      </pre>
      {needsTruncation && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setExpanded((e) => !e)}
        >
          {expanded ? "Show less" : `Show all ${output.length} chars`}
        </Button>
      )}
    </div>
  );
}
