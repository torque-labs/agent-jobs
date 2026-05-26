/**
 * Fine-grained scopes for API keys.
 *
 * Each `/api/v1/*` route declares the scope it requires; the middleware
 * verifies the presented Bearer key has it (or holds `admin`, which implies
 * everything). Keep this list small — narrow scopes are easier to reason
 * about than broad ones.
 */
export const SCOPES = {
  'jobs:read': 'Read jobs',
  'jobs:write': 'Create, update, delete jobs',
  'runs:read': 'Read runs and step outputs',
  'runs:trigger': 'Trigger a job run',
  'runs:cancel': 'Cancel an in-flight run',
  'webhooks:admin': 'Manage outbound webhooks',
  'keys:admin': 'Create, list, revoke API keys',
  'agents:read': 'Read tenant customer-agents',
  'agents:write': 'Create, update, delete tenant customer-agents',
  admin: 'Implies every other scope',
} as const;

export type Scope = keyof typeof SCOPES;

export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

/**
 * Check whether a key's granted scopes satisfy the required scope.
 * The `admin` scope implies all others.
 */
export function hasScope(granted: string[] | null | undefined, required: Scope): boolean {
  if (!granted || granted.length === 0) return false;
  if (granted.includes('admin')) return true;
  return granted.includes(required);
}

export function isValidScope(s: string): s is Scope {
  return s in SCOPES;
}
