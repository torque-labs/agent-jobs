"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "./markdown-view";

const TRUNCATE_AT = 600;

/** Strip a single leading/trailing ``` fence (optionally tagged, e.g. ```json). */
function stripFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return m ? m[1] : t;
}

function looksLikeJson(body: string): boolean {
  const t = body.trim();
  return t.startsWith("{") || t.startsWith("[");
}

function looksLikeMarkdown(body: string): boolean {
  return body.split("\n").some((l) => /^\s*(#|\||>)/.test(l));
}

function RawPre({ output }: { output: string }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = output.length > TRUNCATE_AT;
  const display =
    expanded || !needsTruncation ? output : output.slice(0, TRUNCATE_AT) + "…";
  return (
    <div className="flex flex-col gap-2">
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

/**
 * Detects the content type of a step output and renders accordingly:
 * JSON is pretty-printed, markdown is rendered (with a Rendered/Raw toggle),
 * and everything else falls back to a truncatable <pre>.
 */
export function StepOutputViewer({ output }: { output: string }) {
  const [raw, setRaw] = useState(false);
  const body = stripFence(output);

  if (looksLikeJson(body)) {
    let pretty = body;
    try {
      pretty = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      pretty = body;
    }
    return (
      <div className="flex flex-col gap-2">
        <div className="text-xs font-medium text-muted-foreground">Output</div>
        <RawPre output={pretty} />
      </div>
    );
  }

  if (looksLikeMarkdown(body)) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium text-muted-foreground">Output</div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRaw((r) => !r)}
          >
            {raw ? "Rendered" : "Raw"}
          </Button>
        </div>
        {raw ? (
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs">
            {body}
          </pre>
        ) : (
          <div className="rounded-md border bg-muted/30 p-4 text-sm">
            <MarkdownView source={body} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-medium text-muted-foreground">Output</div>
      <RawPre output={output} />
    </div>
  );
}
