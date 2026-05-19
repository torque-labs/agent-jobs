import { listApiKeys } from '@/lib/api-keys';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDistanceToNow } from 'date-fns';
import { CreateKeyDialog } from './create-key-dialog';
import { RevokeKeyButton } from './revoke-key-button';
import { ALL_SCOPES } from '@/lib/scopes';
import type { ApiKey } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function loadKeys(): Promise<ApiKey[]> {
  try {
    return await listApiKeys();
  } catch (err) {
    console.error('[settings/keys] listApiKeys failed:', err);
    return [];
  }
}

function formatRelative(d: Date | null): string {
  if (!d) return '—';
  return formatDistanceToNow(new Date(d), { addSuffix: true });
}

export default async function ApiKeysPage() {
  const keys = await loadKeys();
  const active = keys.filter((k) => !k.revoked_at);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-heading text-lg font-semibold">API keys</h2>
          <p className="text-sm text-muted-foreground">
            Bearer tokens for `/api/v1/*`. Plain key shown once at creation.
          </p>
        </div>
        <CreateKeyDialog scopes={ALL_SCOPES} />
      </div>

      <div className="rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Prefix</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead className="w-20 text-right">Status</TableHead>
              <TableHead className="w-20 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                  No API keys yet. Create one to start hitting `/api/v1/*`.
                </TableCell>
              </TableRow>
            ) : (
              keys.map((k) => (
                <TableRow key={k.id}>
                  <TableCell className="font-medium">{k.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {k.key_prefix}…
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {k.scopes.map((s) => (
                        <Badge key={s} variant="secondary" className="text-[10px]">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelative(k.created_at)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelative(k.last_used_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    {k.revoked_at ? (
                      <Badge variant="destructive" className="text-[10px]">revoked</Badge>
                    ) : (
                      <Badge className="bg-green-500/15 text-green-700 dark:text-green-400 text-[10px]">
                        active
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {!k.revoked_at && <RevokeKeyButton id={k.id} name={k.name} />}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {active.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {active.length} active key{active.length === 1 ? '' : 's'}.
        </p>
      )}
    </div>
  );
}
