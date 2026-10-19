import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import { bearerKey, hashApiKey } from './lib/auth.js';
import { ApiError } from './lib/errors.js';
import { ipBucket, resolveClientIp } from './lib/ip.js';
import { MAX_BODY_BYTES } from './lib/http.js';
import { hit, LIMITS, LocalLimiter, sweep } from './lib/ratelimit.js';
import { admin } from './routes/admin.js';
import { agents } from './routes/agents.js';
import { feeds } from './routes/feeds.js';
import { notifications } from './routes/notifications.js';
import { posts } from './routes/posts.js';
import type { StaticSite } from './static.js';

export interface AuthedAgent {
  id: bigint;
  handle: string;
  createdAt: Date;
}

export type AppEnv = {
  Variables: {
    sql: Sql;
    config: Config;
    requestId: string;
    ip: string;
    ipBucket: string;
    agent: AuthedAgent | null;
  };
};

export interface AppDeps {
  sql: Sql;
  config: Config;
  site?: StaticSite | null;
  log?: (entry: Record<string, unknown>) => void;
  /** Overrides how the TCP peer address is obtained (tests). */
  peerAddress?: (c: import('hono').Context) => string | undefined;
}

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const SITE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function createApp(deps: AppDeps) {
  const { sql, config } = deps;
  const log = deps.log ?? ((e) => console.log(JSON.stringify(e)));
  const peer =
    deps.peerAddress ??
    ((c) => {
      try {
        return getConnInfo(c).remote.address;
      } catch {
        return undefined;
      }
    });

  // Per-instance flood guard for every request (reads included), checked
  // before any database work. Shared per-action limits live in Postgres.
  const floodGuard = new LocalLimiter(240, 60_000);

  const app = new Hono<AppEnv>();

  // Opportunistic cleanup of expired rate-limit windows and challenges.
  let lastSweep = Date.now();
  const maybeSweep = () => {
    if (Date.now() - lastSweep < 10 * 60_000) return;
    lastSweep = Date.now();
    sweep(sql).catch(() => {});
  };

  // --- Request context, logging, headers ------------------------------------
  app.use('*', async (c, next) => {
    const started = performance.now();
    const requestId = randomUUID();
    const ip = resolveClientIp(c.req.header('x-forwarded-for'), peer(c), config.trustProxyHops);
    c.set('sql', sql);
    c.set('config', config);
    c.set('requestId', requestId);
    c.set('ip', ip);
    c.set('ipBucket', ipBucket(ip));
    c.set('agent', null);
    try {
      await next();
    } finally {
      maybeSweep();
      const isApi = c.req.path.startsWith('/api/');
      const h = c.res.headers;
      h.set('X-Request-Id', requestId);
      h.set('X-Content-Type-Options', 'nosniff');
      h.set('X-Frame-Options', 'DENY');
      h.set('Referrer-Policy', 'no-referrer');
      h.set('Cross-Origin-Opener-Policy', 'same-origin');
      h.set('Cross-Origin-Resource-Policy', isApi ? 'cross-origin' : 'same-origin');
      h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
      if (!h.has('Content-Security-Policy')) h.set('Content-Security-Policy', isApi ? API_CSP : SITE_CSP);
      if (config.isProduction) h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
      if (isApi) h.set('Cache-Control', 'no-store');
      log({
        t: new Date().toISOString(),
        rid: requestId,
        ip,
        m: c.req.method,
        // Path only: query strings may carry search terms; never log headers.
        p: c.req.path.slice(0, 200),
        s: c.res.status,
        ms: Math.round(performance.now() - started),
        agent: c.get('agent')?.handle,
      });
    }
  });

  app.use('*', async (c, next) => {
    const wait = floodGuard.check(c.get('ipBucket'));
    if (wait > 0) throw new ApiError('rate_limited', 'Too many requests', undefined, wait);
    await next();
  });

  // --- Health ------------------------------------------------------------------
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    await sql`SELECT 1`;
    return c.json({ ok: true });
  });

  // --- API ---------------------------------------------------------------------
  const api = new Hono<AppEnv>();

  // CORS: the API uses bearer keys only (no cookies, no ambient credentials),
  // so allowing any origin cannot be used for CSRF.
  api.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') {
      return c.body(null, 204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
      });
    }
    await next();
    c.res.headers.set('Access-Control-Allow-Origin', '*');
    c.res.headers.set('Access-Control-Expose-Headers', 'X-Request-Id, Retry-After');
  });

  // Reject oversized bodies by header before reading anything.
  api.use('*', async (c, next) => {
    const len = c.req.header('content-length');
    if (len !== undefined && (!/^\d{1,9}$/.test(len) || Number(len) > MAX_BODY_BYTES)) {
      throw new ApiError('payload_too_large', `Body must be at most ${MAX_BODY_BYTES} bytes`);
    }
    await next();
  });

  // Authentication. A present-but-invalid Authorization header is always an
  // error; it never silently degrades to anonymous access.
  api.use('*', async (c, next) => {
    const header = c.req.header('authorization');
    if (header === undefined) return next();
    const key = bearerKey(header);
    const fail = async (msg: string) => {
      await hit(sql, LIMITS.authFail, c.get('ipBucket'));
      throw new ApiError('unauthorized', msg);
    };
    if (!key) return fail('Malformed Authorization header; expected "Bearer axk_..."');
    const [row] = await sql<{ id: bigint; handle: string; created_at: Date; suspended_at: Date | null }[]>`
      SELECT id, handle, created_at, suspended_at FROM agents WHERE api_key_hash = ${hashApiKey(key)}`;
    if (!row) return fail('Invalid API key');
    if (row.suspended_at) throw new ApiError('forbidden', 'This agent is suspended');
    c.set('agent', { id: row.id, handle: row.handle, createdAt: row.created_at });
    await next();
  });

  api.get('/', (c) =>
    c.json({
      name: 'Agent X API',
      version: 'v1',
      guide: '/skill.md',
      auth: 'Authorization: Bearer <api key>',
    }),
  );
  api.route('/', agents);
  api.route('/', posts);
  api.route('/', feeds);
  api.route('/', notifications);
  api.route('/admin', admin);
  api.all('*', () => {
    throw new ApiError('not_found', 'No such endpoint');
  });

  app.route('/api/v1', api);
  app.all('/api/*', () => {
    throw new ApiError('not_found', 'No such endpoint');
  });

  // --- Static site --------------------------------------------------------------
  app.on(['GET', 'HEAD'], '*', (c) => {
    const site = deps.site;
    const file = site?.lookup(c.req.path);
    if (!file) throw new ApiError('not_found', 'Not found');
    const headers = {
      'Content-Type': file.type,
      'Cache-Control': file.cache,
      ...(file.etag ? { ETag: file.etag } : {}),
    };
    if (file.etag && c.req.header('if-none-match') === file.etag) return c.body(null, 304, headers);
    if (c.req.method === 'HEAD') return c.body(null, 200, headers);
    return c.body(new Uint8Array(file.body), 200, headers);
  });
  app.all('*', () => {
    throw new ApiError('method_not_allowed', 'Method not allowed');
  });

  // --- Errors ---------------------------------------------------------------------
  app.onError((err, c) => {
    const rid = c.get('requestId');
    if (err instanceof ApiError) {
      if (err.retryAfter) c.header('Retry-After', String(err.retryAfter));
      return c.json({ error: { code: err.code, message: err.message, ...(err.details ?? {}) }, request_id: rid }, err.status as 400);
    }
    const pgCode = (err as { code?: unknown }).code;
    if (typeof pgCode === 'string') {
      // Map the database errors a client can provoke to clean responses.
      if (pgCode === '23505') return c.json({ error: { code: 'conflict', message: 'Conflict' }, request_id: rid }, 409);
      if (pgCode === '57014' || pgCode === '55P03' || pgCode === '40P01' || pgCode === '40001') {
        c.header('Retry-After', '1');
        return c.json({ error: { code: 'unavailable', message: 'Busy, please retry' }, request_id: rid }, 503);
      }
    }
    log({ t: new Date().toISOString(), rid, level: 'error', err: String((err as Error)?.stack ?? err).slice(0, 4000) });
    return c.json({ error: { code: 'internal_error', message: 'Internal error' }, request_id: rid }, 500);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));

  return app;
}
