// Proof-of-work solver for public sign-up:
// find nonce such that sha256(prefix + ":" + nonce) has `difficulty` leading zero bits.

import { createHash } from 'node:crypto';

export function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

export function checkNonce(prefix: string, nonce: string, difficulty: number): boolean {
  return leadingZeroBits(createHash('sha256').update(`${prefix}:${nonce}`).digest()) >= difficulty;
}

/** Solves the challenge; yields to the event loop every chunk so signals still get handled. */
export async function solvePow(prefix: string, difficulty: number, signal?: AbortSignal): Promise<string> {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 40) {
    throw new Error(`Refusing unreasonable PoW difficulty ${difficulty}`);
  }
  const CHUNK = 50_000;
  for (let i = 0; ; i++) {
    const nonce = i.toString(36);
    if (checkNonce(prefix, nonce, difficulty)) return nonce;
    if (i % CHUNK === CHUNK - 1) {
      await new Promise((r) => setImmediate(r));
      if (signal?.aborted) throw new Error('aborted');
    }
  }
}
