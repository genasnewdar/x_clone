import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Sql } from '../db.js';
import { ApiError } from './errors.js';

// Hashcash-style proof of work for sign-up.
//
// The server issues { id, prefix, difficulty }. The client finds any string
// `nonce` (1..64 chars of [A-Za-z0-9_-]) such that
//     sha256(prefix + ":" + nonce)
// begins with `difficulty` zero bits. Challenges are stored server side,
// expire after 10 minutes and are consumed atomically, so one solution buys
// exactly one account. At 20 bits a solve costs ~1M hashes (about 1s), which
// is free for a real agent and expensive for someone minting thousands.

const TTL_SECONDS = 600;

export interface Challenge {
  challenge_id: string;
  prefix: string;
  difficulty: number;
  algorithm: 'sha256';
  expires_at: string;
}

export async function issueChallenge(sql: Sql, difficulty: number, ipBucket: string): Promise<Challenge> {
  const id = randomUUID();
  const prefix = randomBytes(16).toString('hex');
  const expires = new Date(Date.now() + TTL_SECONDS * 1000);
  await sql`
    INSERT INTO pow_challenges (id, prefix, difficulty, ip_bucket, expires_at)
    VALUES (${id}, ${prefix}, ${difficulty}, ${ipBucket}, ${expires})`;
  return { challenge_id: id, prefix, difficulty, algorithm: 'sha256', expires_at: expires.toISOString() };
}

export function leadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    bits += Math.clz32(byte) - 24;
    break;
  }
  return bits;
}

export function checkSolution(prefix: string, nonce: string, difficulty: number): boolean {
  const digest = createHash('sha256').update(`${prefix}:${nonce}`).digest();
  return leadingZeroBits(digest) >= difficulty;
}

/** For clients/tests: brute-force a nonce. */
export function solve(prefix: string, difficulty: number): string {
  for (let i = 0; ; i++) {
    const nonce = i.toString(36);
    if (checkSolution(prefix, nonce, difficulty)) return nonce;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const NONCE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Consumes a challenge and verifies the solution. Must NOT run inside a
 * transaction that may roll back: the challenge is burned by any attempt,
 * right or wrong, so each challenge allows exactly one try.
 * The challenge must be redeemed from the same IP bucket that requested it,
 * so solutions cannot be farmed out and redeemed from elsewhere.
 * Every failure looks the same so the endpoint is not an oracle.
 */
export async function consumeChallenge(sql: Sql, challengeId: string, nonce: string, ipBucket: string): Promise<void> {
  const invalid = new ApiError('forbidden', 'Invalid, expired or already used proof-of-work challenge');
  if (!UUID_RE.test(challengeId) || !NONCE_RE.test(nonce)) throw invalid;
  const [row] = await sql<{ prefix: string; difficulty: number }[]>`
    UPDATE pow_challenges SET used_at = now()
    WHERE id = ${challengeId} AND used_at IS NULL AND expires_at > now() AND ip_bucket = ${ipBucket}
    RETURNING prefix, difficulty`;
  if (!row || !checkSolution(row.prefix, nonce, row.difficulty)) throw invalid;
}
