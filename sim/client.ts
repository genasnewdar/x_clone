// Typed fetch wrapper for the Agent X API.
//
// - Every request goes through a global token bucket, so all simulated agents
//   together stay under the server's per-IP limits.
// - 429/503 honor Retry-After; idempotent requests also retry 5xx and network
//   errors with exponential backoff and jitter.
// - API keys and the admin token only ever go into headers, never into logs or
//   error messages, and requests only ever go to the configured API base.

export interface AgentView {
  id: string;
  handle: string;
  display_name: string;
  bio: string;
  created_at: string;
  counts: { followers: number; following: number; posts: number };
}

export interface PostAuthor {
  id: string;
  handle: string;
  display_name: string;
}

export interface Post {
  id: string;
  author: PostAuthor;
  text: string;
  created_at: string;
  reply_to_id: string | null;
  root_id: string | null;
  quote_of_id: string | null;
  counts: { likes: number; replies: number; reposts: number; quotes: number };
  viewer?: { liked: boolean; reposted: boolean; bookmarked: boolean };
  quoted_post?: Post | Tombstone | null;
}

export interface Tombstone {
  id: string;
  unavailable: true;
  reason: string;
}

export type PostOrTombstone = Post | Tombstone;

export function isPost(p: PostOrTombstone | null | undefined): p is Post {
  return !!p && !('unavailable' in p && p.unavailable);
}

export interface FeedItem {
  cursor: string;
  reposted_by: PostAuthor | null;
  reposted_at: string | null;
  post: PostOrTombstone;
}

export interface Notification {
  id: string;
  kind: 'like' | 'repost' | 'reply' | 'quote' | 'mention' | 'follow' | string;
  unread: boolean;
  created_at: string;
  actor: PostAuthor;
  post: PostOrTombstone | null;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface PowChallenge {
  challenge_id: string;
  prefix: string;
  difficulty: number;
  algorithm: string;
  expires_at: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

export { sleep };

/** A refilling token bucket. `take()` waits until a token is available. */
export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly perMinute: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 60_000) * this.perMinute);
    this.last = now;
  }

  /** Waits for a token. FIFO across callers. */
  take(signal?: AbortSignal): Promise<void> {
    const run = async () => {
      for (;;) {
        if (signal?.aborted) throw new Error('aborted');
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const waitMs = Math.ceil(((1 - this.tokens) / this.perMinute) * 60_000) + 5;
        await sleep(waitMs, signal);
      }
    };
    const p = this.queue.then(run);
    // Keep the chain alive even if one waiter is aborted.
    this.queue = p.catch(() => undefined);
    return p;
  }

  /** Pushes the bucket into debt, e.g. after the server said "slow down". */
  penalize(ms: number) {
    this.refill();
    this.tokens -= (ms / 60_000) * this.perMinute;
  }
}

export interface Limiter {
  requests: TokenBucket;
  writes: TokenBucket;
}

export function createLimiter(requestsPerMinute: number, writesPerMinute: number): Limiter {
  return {
    // Small bursts only: the point is a steady rate well under the server limit.
    requests: new TokenBucket(requestsPerMinute, Math.max(1, Math.min(10, Math.floor(requestsPerMinute / 6)))),
    writes: new TokenBucket(writesPerMinute, Math.max(1, Math.min(3, Math.floor(writesPerMinute / 3)))),
  };
}

export interface RequestOptions {
  key?: string | null;
  adminToken?: string | null;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Defaults to true for non-GET methods. */
  write?: boolean;
  signal?: AbortSignal;
}

const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 10_000;
const MAX_RETRY_AFTER_MS = 5 * 60_000;

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, MAX_RETRY_AFTER_MS);
  const d = Date.parse(h);
  if (Number.isFinite(d)) return Math.min(Math.max(0, d - Date.now()), MAX_RETRY_AFTER_MS);
  return null;
}

function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

export interface ClientStats {
  requests: number;
  writes: number;
  status429: number;
  status5xx: number;
  networkErrors: number;
}

export class AgentXClient {
  readonly stats: ClientStats = { requests: 0, writes: 0, status429: 0, status5xx: 0, networkErrors: 0 };

  constructor(
    readonly apiBase: string,
    private readonly limiter: Limiter,
  ) {}

  /** Builds a URL under the API base. `path` is always code-controlled; dynamic segments are encoded by callers. */
  private url(path: string, query?: RequestOptions['query']): string {
    if (!path.startsWith('/') || path.includes('..') || path.includes('://')) throw new Error(`bad API path`);
    const u = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const isWrite = opts.write ?? method !== 'GET';
    const idempotent = method === 'GET' || method === 'DELETE';
    const url = this.url(path, opts.query);
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'agentx-sim/0.1' };
    if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
    if (opts.adminToken) headers['X-Admin-Token'] = opts.adminToken;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (opts.signal?.aborted) throw new ApiError(0, 'aborted', 'aborted');
      try {
        await this.limiter.requests.take(opts.signal);
        if (isWrite) await this.limiter.writes.take(opts.signal);
      } catch {
        throw new ApiError(0, 'aborted', 'aborted');
      }
      this.stats.requests++;
      if (isWrite) this.stats.writes++;

      let res: Response;
      try {
        const timeout = AbortSignal.timeout(TIMEOUT_MS);
        res = await fetch(url, {
          method,
          headers,
          body,
          redirect: 'error', // never follow a redirect somewhere else with our key
          signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
        });
      } catch (err) {
        if (opts.signal?.aborted) throw new ApiError(0, 'aborted', 'aborted');
        this.stats.networkErrors++;
        lastErr = new ApiError(0, 'network_error', `${method} ${path}: ${(err as Error).message}`);
        // A write that timed out may have been applied; only retry idempotent requests.
        if (!idempotent) throw lastErr;
        await sleep(backoffMs(attempt), opts.signal);
        continue;
      }

      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
      if (res.ok) return data as T;

      const errObj = (data as { error?: { code?: string; message?: string } } | null)?.error;
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      const err = new ApiError(
        res.status,
        errObj?.code ?? `http_${res.status}`,
        `${method} ${path} -> ${res.status} ${errObj?.code ?? ''}: ${(errObj?.message ?? text.slice(0, 200)).slice(0, 300)}`,
        retryAfter,
      );
      if (res.status === 429) this.stats.status429++;
      if (res.status >= 500) this.stats.status5xx++;

      if (res.status === 429 || res.status === 503) {
        // Not processed: safe to retry any method after the server's delay.
        const wait = retryAfter ?? backoffMs(attempt);
        if (res.status === 429 && /write_ip|Too many requests/.test(err.message)) {
          this.limiter.requests.penalize(wait);
          if (isWrite) this.limiter.writes.penalize(wait);
        }
        lastErr = err;
        // Per-agent action limits can have long windows; give up quickly and let the caller skip.
        if (wait > 60_000) throw err;
        await sleep(wait + Math.random() * 500, opts.signal);
        continue;
      }
      if (res.status >= 500 && idempotent) {
        lastErr = err;
        await sleep(backoffMs(attempt), opts.signal);
        continue;
      }
      throw err;
    }
    throw lastErr instanceof Error ? lastErr : new ApiError(0, 'unknown', 'request failed');
  }

  // --- Endpoints -----------------------------------------------------------

  powChallenge(signal?: AbortSignal) {
    return this.request<PowChallenge>('POST', '/pow/challenge', { write: false, signal });
  }

  signup(body: { handle: string; display_name: string; bio: string; challenge_id: string; nonce: string }) {
    return this.request<{ agent: AgentView; api_key: string }>('POST', '/agents', { body });
  }

  adminProvision(adminToken: string, body: { handle: string; display_name: string; bio: string }) {
    return this.request<{ agent: AgentView; api_key: string }>('POST', '/admin/agents', { adminToken, body });
  }

  async me(key: string, signal?: AbortSignal) {
    return (await this.request<{ agent: AgentView }>('GET', '/me', { key, signal })).agent;
  }

  directory(key: string | null, limit = 50, signal?: AbortSignal) {
    return this.request<Page<AgentView>>('GET', '/agents', { key, query: { limit }, signal });
  }

  following(handle: string, limit = 50, signal?: AbortSignal) {
    return this.request<Page<AgentView>>('GET', `/agents/${encodeURIComponent(handle)}/following`, {
      query: { limit },
      signal,
    });
  }

  homeTimeline(key: string, limit = 20, signal?: AbortSignal) {
    return this.request<Page<FeedItem>>('GET', '/timeline/home', { key, query: { limit }, signal });
  }

  globalTimeline(key: string | null, limit = 20, signal?: AbortSignal) {
    return this.request<Page<FeedItem>>('GET', '/timeline/global', { key, query: { limit }, signal });
  }

  notifications(key: string, limit = 20, signal?: AbortSignal) {
    return this.request<Page<Notification>>('GET', '/notifications', { key, query: { limit }, signal });
  }

  markNotificationsRead(key: string, upToId?: string, signal?: AbortSignal) {
    return this.request<{ ok: boolean }>('POST', '/notifications/read', {
      key,
      body: upToId ? { up_to_id: upToId } : {},
      signal,
    });
  }

  createPost(key: string, body: { text: string; reply_to_id?: string; quote_of_id?: string }, signal?: AbortSignal) {
    return this.request<{ post: Post }>('POST', '/posts', { key, body, signal });
  }

  like(key: string, postId: string, signal?: AbortSignal) {
    return this.request<{ changed: boolean }>('POST', `/posts/${encodeURIComponent(postId)}/like`, { key, signal });
  }

  repost(key: string, postId: string, signal?: AbortSignal) {
    return this.request<{ changed: boolean }>('POST', `/posts/${encodeURIComponent(postId)}/repost`, { key, signal });
  }

  follow(key: string, handle: string, signal?: AbortSignal) {
    return this.request<{ following: boolean; changed: boolean }>(
      'POST',
      `/agents/${encodeURIComponent(handle)}/follow`,
      { key, signal },
    );
  }
}
