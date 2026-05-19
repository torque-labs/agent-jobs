/**
 * Templating context passed into `substitute`. Step outputs may be null while
 * a step is still running or has failed.
 *
 * Trigger context is populated for runs invoked via /api/v1/triggers/[token]
 * and is undefined for cron / manual / chat runs.
 */
export type TriggerContext = {
  /** Parsed JSON body if Content-Type was application/json, else null. */
  body: unknown;
  /** Raw request body as text (whatever the caller POSTed). */
  rawBody: string;
  /** Header map with lowercased keys. */
  headers: Record<string, string>;
};

export type SubstitutionContext = {
  steps: Record<string, { output: string | null }>;
  trigger?: TriggerContext;
};

const STEP_PATTERN = /\{\{\s*steps\.([a-zA-Z0-9_\-]+)\.output\s*\}\}/g;
const ENV_PATTERN = /\{\{\s*env\.([A-Z0-9_]+)\s*\}\}/g;
// {{trigger.body}} or {{trigger.body.foo.bar}} or {{trigger.headers.x-custom}}
const TRIGGER_PATTERN = /\{\{\s*trigger\.([a-zA-Z0-9_\-.]+)\s*\}\}/g;

/**
 * Substitute `{{steps.<name>.output}}`, `{{env.<NAME>}}`, and
 * `{{trigger.<path>}}` references in a template string. Missing step outputs
 * produce a literal placeholder; missing env vars produce an empty string
 * with a warning; missing trigger paths produce an empty string.
 *
 * v1 design notes:
 * - Only earlier-step refs make sense; the orchestrator builds the context
 *   incrementally so a forward-ref naturally hits the "not yet available"
 *   branch and ALSO trips a sibling check in the orchestrator that throws.
 * - No expression evaluation, no nesting — strict literal replacement.
 */
export function substitute(template: string, context: SubstitutionContext): string {
  if (typeof template !== 'string') return '';
  let out = template.replace(STEP_PATTERN, (_match, name: string) => {
    const step = context.steps[name];
    if (!step || step.output === null || step.output === undefined) {
      return `<step "${name}" output not yet available>`;
    }
    return step.output;
  });
  out = out.replace(ENV_PATTERN, (_match, name: string) => {
    const val = process.env[name];
    // Risky surface: warn loudly so operators see this in logs.
    console.warn(
      `[templating] user_template references env.${name} — env injection is allowed but discouraged.`,
    );
    return val ?? '';
  });
  out = out.replace(TRIGGER_PATTERN, (_match, path: string) => {
    return resolveTriggerPath(context.trigger, path);
  });
  return out;
}

/**
 * Resolve a trigger reference like `body`, `body.foo.bar`, or
 * `headers.x-custom`. Returns the stringified value, or an empty string for
 * missing/null values.
 */
function resolveTriggerPath(trigger: TriggerContext | undefined, path: string): string {
  if (!trigger) return '';

  const parts = path.split('.');
  const root = parts[0];
  const rest = parts.slice(1);

  if (root === 'body') {
    if (rest.length === 0) {
      // Whole body — prefer JSON, fall back to raw text.
      if (trigger.body !== null && trigger.body !== undefined) {
        try {
          return JSON.stringify(trigger.body);
        } catch {
          return String(trigger.body);
        }
      }
      return trigger.rawBody ?? '';
    }
    // Dot-path into parsed body. Only works if body parsed as JSON.
    const value = walkPath(trigger.body, rest);
    return stringifyValue(value);
  }

  if (root === 'headers') {
    if (rest.length === 0) {
      try {
        return JSON.stringify(trigger.headers);
      } catch {
        return '';
      }
    }
    // Headers are case-insensitive; we stored lowercase keys.
    const key = rest.join('.').toLowerCase();
    return trigger.headers[key] ?? '';
  }

  return '';
}

function walkPath(value: unknown, path: string[]): unknown {
  let cur: unknown = value;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function stringifyValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Return the set of step names a template references. Used by the
 * orchestrator to validate that a step only references EARLIER steps.
 */
export function referencedSteps(template: string): string[] {
  if (typeof template !== 'string') return [];
  const names = new Set<string>();
  for (const m of template.matchAll(STEP_PATTERN)) {
    names.add(m[1]);
  }
  return [...names];
}
