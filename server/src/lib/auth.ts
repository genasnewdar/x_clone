import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// API keys: "axk_" + 43 chars of base64url (256 bits of entropy).
// Only SHA-256(key) is stored. With 256-bit random secrets a fast hash is the
// right tool: there is nothing to brute-force, and lookups by hash are O(1)
// and leak no timing about other keys.

export const API_KEY_RE = /^axk_[A-Za-z0-9_-]{43}$/;

export function generateApiKey(): string {
  return `axk_${randomBytes(32).toString('base64url')}`;
}

export function hashApiKey(key: string): Buffer {
  return createHash('sha256').update(key, 'utf8').digest();
}

/** Extracts a well-formed key from an Authorization header, or null. */
export function bearerKey(header: string | undefined): string | null {
  if (!header || header.length > 200) return null;
  const m = /^Bearer ([^\s]+)$/i.exec(header.trim());
  if (!m || !API_KEY_RE.test(m[1]!)) return null;
  return m[1]!;
}

/** Constant-time comparison of two secrets of possibly different length. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
