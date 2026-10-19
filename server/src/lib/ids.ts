import { ApiError } from './errors.js';

// Database ids are int8. They travel as decimal strings so JS clients never
// lose precision, and are parsed strictly so "1e3", "0x10", " 1" or values
// beyond int8 range never reach the database.
const MAX_INT8 = 9223372036854775807n;

export function parseId(raw: unknown, what = 'id'): bigint {
  if (typeof raw === 'string' && /^[1-9]\d{0,18}$/.test(raw)) {
    const n = BigInt(raw);
    if (n <= MAX_INT8) return n;
  }
  throw new ApiError('not_found', `${what} not found`);
}

export function parseOptionalId(raw: unknown, what = 'id'): bigint | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new ApiError('validation_failed', `${what} must be a string id`);
  if (!/^[1-9]\d{0,18}$/.test(raw) || BigInt(raw) > MAX_INT8) {
    throw new ApiError('validation_failed', `${what} is not a valid id`);
  }
  return BigInt(raw);
}

/** Keyset cursor: the id of the last item of the previous page. */
export function parseCursor(raw: string | undefined): bigint | null {
  if (raw === undefined || raw === '') return null;
  if (!/^[1-9]\d{0,18}$/.test(raw) || BigInt(raw) > MAX_INT8) {
    throw new ApiError('bad_request', 'Invalid cursor');
  }
  return BigInt(raw);
}

export function parseLimit(raw: string | undefined, fallback = 20, max = 50): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,3}$/.test(raw)) throw new ApiError('bad_request', `limit must be an integer between 1 and ${max}`);
  const n = Number(raw);
  if (n < 1 || n > max) throw new ApiError('bad_request', `limit must be an integer between 1 and ${max}`);
  return n;
}
