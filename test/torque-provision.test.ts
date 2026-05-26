/**
 * Unit tests for the base58 codec + secret-key validation in
 * lib/torque-provision.ts. No test framework is wired into agent-jobs, so these
 * use Node's built-in test runner (no new dependency):
 *
 *   pnpm tsx --test test/torque-provision.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base58Decode, base58Encode } from '../lib/torque-provision';

test('base58 roundtrip: 0x00 <-> "1"', () => {
  // A single zero byte encodes to the leading-zero sentinel "1".
  assert.equal(base58Encode(new Uint8Array([0])), '1');
  assert.deepEqual(base58Decode('1'), new Uint8Array([0]));
});

test('base58 roundtrip: multiple leading zeros', () => {
  const bytes = new Uint8Array([0, 0, 0, 7, 42, 255]);
  assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
  // Leading zero bytes => one "1" each.
  assert.equal(base58Encode(new Uint8Array([0, 0, 1])).startsWith('11'), true);
});

test('base58 roundtrip: empty input', () => {
  assert.equal(base58Encode(new Uint8Array(0)), '');
  assert.deepEqual(base58Decode(''), new Uint8Array(0));
});

test('base58 roundtrip: random 32-byte values are stable', () => {
  for (let i = 0; i < 50; i++) {
    const bytes = new Uint8Array(32);
    for (let j = 0; j < 32; j++) bytes[j] = Math.floor(Math.random() * 256);
    const enc = base58Encode(bytes);
    assert.deepEqual(base58Decode(enc), bytes, `roundtrip failed for ${enc}`);
  }
});

test('base58Decode rejects invalid characters', () => {
  // '0', 'O', 'I', 'l' are not in the Bitcoin alphabet.
  assert.throws(() => base58Decode('0OIl'), /Invalid base58 character/);
});

test('base58 roundtrip: known vector', () => {
  // "Hello World!" base58 -> "2NEpo7TZRRrLZSi2U" (Bitcoin alphabet).
  const text = new TextEncoder().encode('Hello World!');
  const enc = base58Encode(text);
  assert.equal(enc, '2NEpo7TZRRrLZSi2U');
  assert.deepEqual(base58Decode(enc), new Uint8Array(text));
});
