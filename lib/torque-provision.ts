/**
 * Mint a scoped Torque MCP token from a wallet secret key.
 *
 * This reproduces the sign-in flow used by @torque-labs/mcp's `authenticate`
 * tool (verified against the package bundle, v0.3.1):
 *
 *   1. Sign the fixed statement "Sign in to Torque" with the wallet's ed25519
 *      secret key.
 *   2. POST {apiBaseUrl}/login with:
 *        { authType: "basic",
 *          pubKey:   <base58 wallet address>,
 *          payload:  { input: "Sign in to Torque", output: <signature bytes> } }
 *      where `output` is the raw signature. The MCP bundle passes a Uint8Array;
 *      we send it as a JSON array of bytes (the most portable shape). If the
 *      server rejects that encoding, TODO below covers the base58 fallback.
 *   3. The response `{ token }` is the scoped MCP JWT to store on the tenant.
 *
 * Isolation: if the wallet administers exactly one Torque project, the minted
 * token sees only that project (verified for the $TRUMP tenant).
 *
 * NETWORK: this hits server.torque.so. In this foundation pass it is only
 * exercised against a stub/local mock — do NOT point it at prod during review.
 *
 * Dependencies: uses Node's built-in ed25519 (node:crypto) and a tiny base58
 * codec below, so it adds NO new package to agent-jobs.
 */
import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';

const DEFAULT_API_BASE = process.env.TORQUE_API_URL ?? 'https://server.torque.so';
const SIGN_STATEMENT = 'Sign in to Torque';

// ---------- base58 (Bitcoin alphabet) ----------

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < B58_ALPHABET.length; i++) m[B58_ALPHABET[i]] = i;
  return m;
})();

export function base58Decode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);
  const bytes: number[] = [0];
  for (const ch of str) {
    const value = B58_MAP[ch];
    if (value === undefined) throw new Error(`Invalid base58 character: ${ch}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // `bytes` is little-endian; drop the most-significant zero bytes (the high
  // end of the array, which become the leading bytes after reverse) so the
  // seed accumulator '0' and any zero high bytes don't survive. The leading
  // '1' sentinels below re-add exactly the right number of zero bytes.
  while (bytes.length > 0 && bytes[bytes.length - 1] === 0) bytes.pop();
  // Leading '1's => leading zero bytes (one each).
  for (let k = 0; k < str.length && str[k] === '1'; k++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  // Leading zero BYTES are encoded as the sentinel '1' (one each)...
  for (let k = 0; k < bytes.length && bytes[k] === 0; k++) out += '1';
  // ...so skip ALL most-significant zero DIGITS: they represent exactly those
  // same leading zero bytes already emitted above. Emitting them again would
  // double-count (e.g. a single 0x00 byte would render as '11' instead of '1';
  // an all-zero buffer must be all sentinels and nothing more).
  let top = digits.length - 1;
  while (top >= 0 && digits[top] === 0) top--;
  for (let q = top; q >= 0; q--) out += B58_ALPHABET[digits[q]];
  return out;
}

// ---------- key parsing ----------

/**
 * Accept the two formats Solana tooling emits, matching the MCP bundle:
 *  - base58-encoded 64-byte secret key (32 seed + 32 pubkey)
 *  - JSON byte array, e.g. the `[12,34,...]` from `solana-keygen` / id.json
 */
function parseSecretKey(input: string): Uint8Array {
  const trimmed = input.trim();
  if (trimmed.startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(trimmed);
    } catch {
      throw new Error('secret key looks like a JSON array but is not valid JSON');
    }
    if (!Array.isArray(arr)) {
      throw new Error('secret key JSON must be an array of byte values');
    }
    // Validate every element is an integer in the 0–255 byte range before
    // coercing — `Uint8Array.from` would silently truncate floats / wrap
    // out-of-range values, which would corrupt the key rather than fail loudly.
    for (const v of arr) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
        throw new Error('secret key byte array contains a non-byte (0–255 integer) value');
      }
    }
    if (arr.length !== 32 && arr.length !== 64) {
      throw new Error(`secret key byte array has ${arr.length} bytes (expected 32 or 64)`);
    }
    return Uint8Array.from(arr as number[]);
  }
  return base58Decode(trimmed);
}

/**
 * Derive the 32-byte ed25519 public key from a 32-byte seed using Node crypto,
 * so we can verify a 64-byte secret key's embedded pubkey actually matches its
 * seed (a mismatched/forged key would otherwise sign with one identity and
 * authenticate as another).
 */
function derivePublicKey(seed: Uint8Array): Uint8Array {
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der = Buffer.concat([pkcs8Prefix, Buffer.from(seed)]);
  const priv = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv);
  const spki = pub.export({ format: 'der', type: 'spki' }) as Buffer;
  // SPKI for ed25519 is a fixed 12-byte header followed by the 32-byte key.
  return new Uint8Array(spki.subarray(spki.length - 32));
}

/** Derive {seed32, pubkey32} from a 64- or 32-byte secret key. */
function splitKey(secret: Uint8Array): { seed: Uint8Array; pubkey: Uint8Array } {
  if (secret.length === 64) {
    const seed = secret.slice(0, 32);
    const embeddedPubkey = secret.slice(32, 64);
    // Verify the embedded pubkey actually corresponds to the seed. A key whose
    // halves don't match would sign as one identity but claim another.
    const derived = derivePublicKey(seed);
    if (Buffer.compare(Buffer.from(embeddedPubkey), Buffer.from(derived)) !== 0) {
      throw new Error('secret key is invalid: embedded public key does not match its seed');
    }
    return { seed, pubkey: embeddedPubkey };
  }
  if (secret.length === 32) {
    // Seed-only: we can sign but cannot recover the pubkey without a curve op.
    // TODO: derive pubkey from seed if a 32-byte key is ever passed. For now the
    // caller must provide the 64-byte form (what solana-keygen produces).
    throw new Error('32-byte seed-only keys are not supported; provide the 64-byte secret key');
  }
  throw new Error(`Unexpected secret key length: ${secret.length} (expected 32 or 64)`);
}

/** Sign a message with an ed25519 seed using Node's built-in crypto. */
function ed25519Sign(message: Uint8Array, seed: Uint8Array): Uint8Array {
  // PKCS#8 wrapper for a raw 32-byte ed25519 seed.
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der = Buffer.concat([pkcs8Prefix, Buffer.from(seed)]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return new Uint8Array(edSign(null, Buffer.from(message), key));
}

// ---------- public API ----------

export type ProvisionResult = {
  token: string;
  pubkey: string;
};

export type ProvisionOptions = {
  apiBaseUrl?: string;
  /** Inject a fetch impl for tests/stubbing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Mint a scoped Torque MCP token for the given wallet secret key.
 *
 * @param secretKey  base58 string or JSON byte-array of the 64-byte secret key.
 */
export async function provisionTorqueToken(
  secretKey: string,
  opts: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const apiBaseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;

  const secret = parseSecretKey(secretKey);
  const { seed, pubkey } = splitKey(secret);
  const pubkeyB58 = base58Encode(pubkey);

  const message = new TextEncoder().encode(SIGN_STATEMENT);
  const signature = ed25519Sign(message, seed);

  const res = await doFetch(`${apiBaseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      authType: 'basic',
      pubKey: pubkeyB58,
      payload: {
        input: SIGN_STATEMENT,
        // The MCP client passes the raw signature Uint8Array. We send a byte
        // array; TODO: if server.torque.so requires base58, switch to
        // base58Encode(signature) here once the exact contract is confirmed
        // against a non-prod environment.
        output: Array.from(signature),
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Torque login failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { token?: unknown };
  if (!data.token || typeof data.token !== 'string') {
    throw new Error('Torque login response missing token field');
  }
  return { token: data.token, pubkey: pubkeyB58 };
}

/**
 * Verify a Torque MCP token is still valid (GET {apiBaseUrl}/verify with the
 * Bearer token). Mirrors the MCP bundle's `verify()`. Returns false on any
 * error so callers can treat it as "needs re-provision".
 */
export async function verifyTorqueToken(
  token: string,
  opts: ProvisionOptions = {},
): Promise<boolean> {
  const apiBaseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${apiBaseUrl}/verify`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}
