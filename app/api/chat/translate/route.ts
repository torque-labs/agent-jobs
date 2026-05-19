import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createOpenRouterClient } from '@/lib/hermes';

export const runtime = 'nodejs';

const bodySchema = z.object({
  prompt: z.string().min(1),
});

const SYSTEM_PROMPT = `You convert natural-language workflow requests into structured Job specs for an agent job platform.

A Job has these fields:
- name: string (short, descriptive)
- description: string (one or two sentences)
- cron: string | null  (a standard 5-field cron expression, or null for manual-only)
- enabled: boolean (default true)
- steps: array of Step objects, at least one

Each Step has:
- name: string (unique within the job, snake_case)
- model: string — use "hermes-agent" for steps that need Torque or Supabase MCP tools (database queries, on-chain lookups, posting to Outline, etc); use "anthropic/claude-sonnet-4-6" for plain LLM reasoning/writing
- system_prompt: string (instructions to the agent for this step)
- user_template: string — the actual prompt for this step. Reference prior step outputs with {{steps.<step_name>.output}}
- tools_allowed: null  (always null for v1 — model decides)
- retries: 1
- timeout_seconds: 600

Decompose the user's request into the minimum useful steps. Wire later steps to earlier ones via {{steps.X.output}} when one step needs the previous step's data.

Return ONLY a JSON object matching exactly this shape:
{
  "job": {
    "name": "...",
    "description": "...",
    "cron": "..." | null,
    "enabled": true,
    "steps": [ { "name": "...", "model": "...", "system_prompt": "...", "user_template": "...", "tools_allowed": null, "retries": 1, "timeout_seconds": 600 } ]
  },
  "explanation": "Plain-English summary of what this job will do, 1-2 sentences."
}`;

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  let client;
  try {
    client = createOpenRouterClient();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Translator unavailable: ${msg}` }, { status: 500 });
  }

  try {
    const completion = await client.chat.completions.create({
      model: 'openai/gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: parsed.data.prompt },
      ],
      response_format: { type: 'json_object' },
      stream: false,
    });

    const content = completion.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      return NextResponse.json(
        { error: 'Translator returned an empty response' },
        { status: 502 },
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { error: `Translator returned invalid JSON: ${msg}`, raw: content },
        { status: 502 },
      );
    }

    return NextResponse.json(parsedJson);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
