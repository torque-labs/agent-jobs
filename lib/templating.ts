/**
 * Templating context passed into `substitute`. Step outputs may be null while
 * a step is still running or has failed.
 */
export type SubstitutionContext = {
  steps: Record<string, { output: string | null }>;
};

const STEP_PATTERN = /\{\{\s*steps\.([a-zA-Z0-9_\-]+)\.output\s*\}\}/g;
const ENV_PATTERN = /\{\{\s*env\.([A-Z0-9_]+)\s*\}\}/g;

/**
 * Substitute `{{steps.<name>.output}}` and `{{env.<NAME>}}` references in a
 * template string. Missing step outputs produce a literal placeholder string
 * so the downstream model can see what was expected; missing env vars produce
 * an empty string and log a warning.
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
  return out;
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
