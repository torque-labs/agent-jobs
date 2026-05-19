import { NextResponse } from 'next/server';
import { promises as dns } from 'node:dns';
import net from 'node:net';

export const runtime = 'nodejs';

const HOSTS = [
  'hermes-agent',
  'hermes-agent-cookw4kwo0gw0gock8wgwgwk',
  'hermes-agent-ywkkkg84og4k4csgs84gww8g',
  'hermes-workspace',
  'hermes-workspace-cookw4kwo0gw0gock8wgwgwk',
  'hermes-workspace-e8co4k8csgggkk8gkg8ccgko',
];

const PORTS = [8642, 9119, 3000];

async function resolve(host: string) {
  try {
    return { ok: true as const, ips: await dns.lookup(host, { all: true }) };
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
}

function tcpProbe(host: string, port: number, timeoutMs = 1500) {
  return new Promise<{ ok: boolean; error?: string; ms?: number }>((res) => {
    const start = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (r: { ok: boolean; error?: string }) => {
      if (done) return;
      done = true;
      sock.destroy();
      res({ ...r, ms: Date.now() - start });
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish({ ok: true }));
    sock.once('timeout', () => finish({ ok: false, error: 'timeout' }));
    sock.once('error', (e) => finish({ ok: false, error: e.message }));
    sock.connect(port, host);
  });
}

export async function GET() {
  const envUrl = process.env.HERMES_API_URL ?? '(unset)';
  const results: Record<string, unknown> = { envHermesApiUrl: envUrl, hosts: {} };
  const hostsResults: Record<string, unknown> = {};
  for (const h of HOSTS) {
    const r = await resolve(h);
    const ports: Record<string, unknown> = {};
    if (r.ok) {
      for (const p of PORTS) {
        ports[p] = await tcpProbe(h, p);
      }
    }
    hostsResults[h] = { dns: r, ports };
  }
  results.hosts = hostsResults;
  return NextResponse.json(results);
}
