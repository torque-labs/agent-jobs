'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Auto-refreshes the surrounding server component every 2s whenever
 * `isActive` is true. Used on pages that show running/queued runs so the
 * status badges + progress update without manual reload.
 *
 * `router.refresh()` re-runs the server component data fetch without a full
 * navigation, so client state (open dialogs, scroll) is preserved.
 */
export function LivePollWrapper({
  children,
  isActive,
  intervalMs = 2000,
}: {
  children: React.ReactNode;
  isActive: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(interval);
  }, [isActive, intervalMs, router]);
  return <>{children}</>;
}
