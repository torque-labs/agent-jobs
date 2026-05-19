import { headers } from "next/headers";

/**
 * Build an absolute URL for server-side fetches against the local API.
 * Uses the incoming request host so it works regardless of port / deploy URL.
 */
export async function getBaseUrl(): Promise<string> {
  const h = await headers();
  const host =
    h.get("x-forwarded-host") ??
    h.get("host") ??
    process.env.NEXT_PUBLIC_APP_URL?.replace(/^https?:\/\//, "") ??
    "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function serverFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const base = await getBaseUrl();
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const res = await fetch(url, { cache: "no-store", ...init });
  if (!res.ok) {
    throw new Error(
      `Fetch ${path} failed: ${res.status} ${res.statusText}`
    );
  }
  return (await res.json()) as T;
}
