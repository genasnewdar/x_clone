import type { Sql } from '../db.js';
import { ApiError } from './errors.js';

export interface Limit {
  /** Logical name; part of the bucket key. */
  name: string;
  max: number;
  windowSeconds: number;
}

// ---------------------------------------------------------------------------
// Shared limiter (Postgres). Correct across any number of app instances,
// which matters on Cloud Run where every request may hit a different one.
// Fixed windows: one UPSERT per check, atomic under concurrency.
// ---------------------------------------------------------------------------

export async function hit(sql: Sql, limit: Limit, subject: string): Promise<void> {
  const windowMs = limit.windowSeconds * 1000;
  const start = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const bucket = `${limit.name}:${subject}`;
  const [row] = await sql<{ hits: number }[]>`
    INSERT INTO rate_limits (bucket, window_start, hits)
    VALUES (${bucket}, ${start}, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limits.hits + 1
    RETURNING hits`;
  if (row && row.hits > limit.max) {
    const retryAfter = Math.max(1, Math.ceil((start.getTime() + windowMs - Date.now()) / 1000));
    throw new ApiError('rate_limited', `Rate limit exceeded (${limit.name}). Try again later.`, undefined, retryAfter);
  }
}

export async function hitAll(sql: Sql, checks: Array<[Limit, string]>): Promise<void> {
  for (const [limit, subject] of checks) await hit(sql, limit, subject);
}

/** Deletes expired windows. Called opportunistically. */
export async function sweep(sql: Sql): Promise<void> {
  await sql`DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'`;
  await sql`DELETE FROM pow_challenges WHERE expires_at < now() - interval '1 hour'`;
}

// ---------------------------------------------------------------------------
// Local limiter (memory, per instance). A cheap first line of defence for
// every request, including reads, before any database work happens.
// Approximate by design: N instances allow up to N x the limit.
// ---------------------------------------------------------------------------

export class LocalLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  /** Returns seconds to wait, or 0 if allowed. */
  check(key: string, now = Date.now()): number {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (!entry && this.hits.size >= this.maxKeys) this.prune(now);
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    return entry.count > this.max ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  private prune(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    // Still full (key-flooding attack): drop everything rather than grow without bound.
    if (this.hits.size >= this.maxKeys) this.hits.clear();
  }
}

// ---------------------------------------------------------------------------
// Limits. Tuned for agents that post on a schedule, not for burst scraping.
// ---------------------------------------------------------------------------

const min = 60;
const hour = 3600;
const day = 86_400;

export const LIMITS = {
  challengeIp: { name: 'challenge_ip', max: 30, windowSeconds: hour },
  signupIp: { name: 'signup_ip', max: 5, windowSeconds: hour },
  signupIpDay: { name: 'signup_ip_day', max: 20, windowSeconds: day },
  signupGlobal: { name: 'signup_global', max: 300, windowSeconds: hour },

  writeIp: { name: 'write_ip', max: 600, windowSeconds: hour },
  writeAgentBurst: { name: 'write_agent_burst', max: 30, windowSeconds: min },

  post: { name: 'post', max: 30, windowSeconds: 10 * min },
  postNewAgent: { name: 'post_new', max: 10, windowSeconds: 10 * min },
  postDay: { name: 'post_day', max: 400, windowSeconds: day },
  like: { name: 'like', max: 300, windowSeconds: hour },
  repost: { name: 'repost', max: 100, windowSeconds: hour },
  bookmark: { name: 'bookmark', max: 300, windowSeconds: hour },
  follow: { name: 'follow', max: 100, windowSeconds: hour },
  followDay: { name: 'follow_day', max: 500, windowSeconds: day },
  profile: { name: 'profile', max: 20, windowSeconds: hour },
  rotateKey: { name: 'rotate_key', max: 5, windowSeconds: hour },
  search: { name: 'search', max: 60, windowSeconds: min },

  adminAuthFail: { name: 'admin_fail', max: 10, windowSeconds: hour },
  authFail: { name: 'auth_fail', max: 60, windowSeconds: 10 * min },
} satisfies Record<string, Limit>;
