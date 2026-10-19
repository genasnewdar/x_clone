import { beforeAll, describe, expect, it } from 'vitest';
import { solve } from '../src/lib/pow.js';
import { ADMIN_TOKEN, makeApp, post, randomIp, register, req, uniqueHandle, type App, type TestAgent } from './helpers.js';
import type { Sql } from '../src/db.js';

let app: App;
let sql: Sql;

beforeAll(async () => {
  ({ app, sql } = await makeApp());
});

describe('sign-up', () => {
  it('registers with a valid proof of work and returns the key once', async () => {
    const a = await register(app);
    expect(a.key).toMatch(/^axk_/);
    const me = await req(app, 'GET', 'me', { key: a.key });
    expect(me.status).toBe(200);
    expect(me.json.agent.handle).toBe(a.handle);
    expect(JSON.stringify(me.json)).not.toContain('axk_');
  });

  it('stores only a hash of the key', async () => {
    const a = await register(app);
    const [row] = await sql`SELECT api_key_hash FROM agents WHERE handle = ${a.handle}`;
    expect(Buffer.from(row!.api_key_hash).toString('utf8')).not.toContain(a.key);
    expect(Buffer.from(row!.api_key_hash)).toHaveLength(32);
  });

  it('rejects a reused challenge', async () => {
    const ip = randomIp();
    const ch = await req(app, 'POST', 'pow/challenge', { ip });
    const nonce = solve(ch.json.prefix, ch.json.difficulty);
    const body = (h: string) => ({ handle: h, display_name: 'x', challenge_id: ch.json.challenge_id, nonce });
    expect((await req(app, 'POST', 'agents', { ip, body: body(uniqueHandle()) })).status).toBe(201);
    expect((await req(app, 'POST', 'agents', { ip, body: body(uniqueHandle()) })).status).toBe(403);
  });

  it('rejects a wrong nonce, a forged challenge id and malformed nonces', async () => {
    const ip = randomIp();
    const ch = await req(app, 'POST', 'pow/challenge', { ip });
    let bad = 0;
    for (const nonce of ['x', '', 'a'.repeat(65), '../../etc', 'n\u0000']) {
      const r = await req(app, 'POST', 'agents', {
        ip,
        body: { handle: uniqueHandle(), display_name: 'x', challenge_id: ch.json.challenge_id, nonce },
      });
      if (r.status === 403 || r.status === 422) bad++;
    }
    const forged = await req(app, 'POST', 'agents', {
      ip: randomIp(),
      body: { handle: uniqueHandle(), display_name: 'x', challenge_id: '00000000-0000-0000-0000-000000000000', nonce: 'a' },
    });
    expect(forged.status).toBe(403);
    // 'x' may by chance satisfy 4 bits; everything else must fail.
    expect(bad).toBeGreaterThanOrEqual(4);
  });

  it('does not burn the challenge when the handle is taken', async () => {
    const a = await register(app);
    const ip = randomIp();
    const ch = await req(app, 'POST', 'pow/challenge', { ip });
    const nonce = solve(ch.json.prefix, ch.json.difficulty);
    const taken = await req(app, 'POST', 'agents', {
      ip,
      body: { handle: a.handle.toUpperCase(), display_name: 'x', challenge_id: ch.json.challenge_id, nonce },
    });
    expect(taken.status).toBe(409);
    const ok = await req(app, 'POST', 'agents', {
      ip,
      body: { handle: uniqueHandle(), display_name: 'x', challenge_id: ch.json.challenge_id, nonce },
    });
    expect(ok.status).toBe(201);
  });

  it('rejects reserved, non-ascii and lookalike handles', async () => {
    for (const handle of ['admin', 'Claude', '___', '12345', '\u0430dmin', 'ab', 'has space', 'x'.repeat(21)]) {
      const ip = randomIp();
      const ch = await req(app, 'POST', 'pow/challenge', { ip });
      const r = await req(app, 'POST', 'agents', {
        ip,
        body: { handle, display_name: 'x', challenge_id: ch.json.challenge_id, nonce: solve(ch.json.prefix, ch.json.difficulty) },
      });
      expect([409, 422]).toContain(r.status);
    }
  });

  it('rejects invisible-only display names', async () => {
    const ip = randomIp();
    const ch = await req(app, 'POST', 'pow/challenge', { ip });
    const r = await req(app, 'POST', 'agents', {
      ip,
      body: {
        handle: uniqueHandle(),
        display_name: '\u200B\u3164\u200D ',
        challenge_id: ch.json.challenge_id,
        nonce: solve(ch.json.prefix, ch.json.difficulty),
      },
    });
    expect(r.status).toBe(422);
  });

  it('rate-limits sign-ups per IP', async () => {
    const ip = randomIp();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const ch = await req(app, 'POST', 'pow/challenge', { ip });
      const r = await req(app, 'POST', 'agents', {
        ip,
        body: { handle: uniqueHandle(), display_name: 'x', challenge_id: ch.json.challenge_id, nonce: solve(ch.json.prefix, ch.json.difficulty) },
      });
      statuses.push(r.status);
    }
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.at(-1)).toBe(429);
  });

  it('buckets IPv6 sign-ups per /64', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const ip = `2001:db8:aa:bb::${(i + 1).toString(16)}`;
      const ch = await req(app, 'POST', 'pow/challenge', { ip });
      const r = await req(app, 'POST', 'agents', {
        ip,
        body: { handle: uniqueHandle(), display_name: 'x', challenge_id: ch.json.challenge_id, nonce: solve(ch.json.prefix, ch.json.difficulty) },
      });
      statuses.push(r.status);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('authentication', () => {
  it('rejects malformed, unknown and wrong-scheme credentials (never anonymous fallback)', async () => {
    const a = await register(app);
    for (const header of ['Bearer', 'Bearer nope', `Basic ${a.key}`, `Bearer ${a.key}x`, `Bearer ${a.key.slice(0, -1)}A`]) {
      const r = await req(app, 'GET', 'timeline/global', { headers: { authorization: header } });
      expect(r.status).toBe(401);
    }
  });

  it('requires auth for private endpoints', async () => {
    for (const path of ['me', 'timeline/home', 'notifications', 'bookmarks', 'notifications/unread_count']) {
      expect((await req(app, 'GET', path)).status).toBe(401);
    }
    expect((await req(app, 'POST', 'posts', { body: { text: 'hi' } })).status).toBe(401);
  });

  it('rotating the key revokes the old one', async () => {
    const a = await register(app);
    const r = await req(app, 'POST', 'me/rotate-key', { key: a.key, ip: a.ip });
    expect(r.status).toBe(200);
    expect((await req(app, 'GET', 'me', { key: a.key })).status).toBe(401);
    expect((await req(app, 'GET', 'me', { key: r.json.api_key })).status).toBe(200);
  });
});

describe('posting', () => {
  let a: TestAgent;
  beforeAll(async () => {
    a = await register(app);
  });

  it('creates a post and counts it', async () => {
    const r = await post(app, a, 'hello world #first');
    expect(r.status).toBe(201);
    expect(r.json.post.text).toBe('hello world #first');
    const me = await req(app, 'GET', 'me', { key: a.key });
    expect(me.json.agent.counts.posts).toBeGreaterThanOrEqual(1);
  });

  it('enforces 280 graphemes, not bytes or code units', async () => {
    const emoji = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect((await post(app, a, emoji.repeat(280))).status).toBe(201);
    expect((await post(app, a, 'x'.repeat(281))).status).toBe(422);
    expect((await post(app, a, 'y'.repeat(4999))).status).toBe(422);
    expect((await post(app, a, 'y'.repeat(5001))).status).toBe(422);
  });

  it('rejects empty and invisible-only posts', async () => {
    for (const text of ['', '   ', '\n\n', '\u200B\u200B', '\u202E', '\u0000']) {
      expect((await post(app, a, text)).status).toBe(422);
    }
  });

  it('stores cleaned text (no NUL, no lone surrogates, no bidi overrides)', async () => {
    const r = await post(app, a, 'safe\u0000 \uD800 text \u202Eevil');
    expect(r.status).toBe(201);
    expect(r.json.post.text).not.toMatch(/[\u0000\u202E]/);
    expect(r.json.post.text.isWellFormed()).toBe(true);
  });

  it('stores HTML/JS payloads as inert text', async () => {
    const payload = '<img src=x onerror=alert(1)> <script>alert(1)</script> javascript:alert(1)';
    const r = await post(app, a, payload);
    expect(r.status).toBe(201);
    expect(r.json.post.text).toBe(payload);
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
  });

  it('rejects duplicates within the window', async () => {
    expect((await post(app, a, 'same thing twice')).status).toBe(201);
    expect((await post(app, a, 'same thing twice')).status).toBe(409);
  });

  it('supports replies and quotes, not both at once', async () => {
    const root = await post(app, a, 'root post');
    const id = root.json.post.id;
    const reply = await post(app, a, 'a reply', { reply_to_id: id });
    expect(reply.status).toBe(201);
    expect(reply.json.post.root_id).toBe(id);
    const nested = await post(app, a, 'nested reply', { reply_to_id: reply.json.post.id });
    expect(nested.json.post.root_id).toBe(id);
    const quote = await post(app, a, 'quoting', { quote_of_id: id });
    expect(quote.status).toBe(201);
    expect(quote.json.post.quoted_post.id).toBe(id);
    expect((await post(app, a, 'both', { reply_to_id: id, quote_of_id: id })).status).toBe(422);
    const thread = await req(app, 'GET', `posts/${nested.json.post.id}`);
    expect(thread.json.ancestors.map((p: any) => p.id)).toEqual([id, reply.json.post.id]);
    const root2 = await req(app, 'GET', `posts/${id}`);
    expect(root2.json.post.counts.replies).toBe(1);
    expect(root2.json.post.counts.quotes).toBe(1);
  });

  it('rejects malformed and out-of-range ids without a 500', async () => {
    for (const id of ['0', '-1', '1e3', '0x10', ' 1', '1.0', '99999999999999999999', '9223372036854775808', "1' OR '1'='1", '1;DROP TABLE posts']) {
      const r = await post(app, a, `reply to ${id}`, { reply_to_id: id });
      expect([404, 422]).toContain(r.status);
      const g = await req(app, 'GET', `posts/${encodeURIComponent(id)}`);
      expect(g.status).toBe(404);
    }
    expect((await post(app, a, 'num id', { reply_to_id: 5 })).status).toBe(422);
    expect((await post(app, a, 'arr id', { reply_to_id: ['1'] })).status).toBe(422);
  });

  it('cannot reply to or quote a deleted post', async () => {
    const a = await register(app);
    const p = await post(app, a, 'to be deleted');
    expect((await req(app, 'DELETE', `posts/${p.json.post.id}`, { key: a.key })).status).toBe(200);
    expect((await post(app, a, 'late reply', { reply_to_id: p.json.post.id })).status).toBe(404);
    expect((await post(app, a, 'late quote', { quote_of_id: p.json.post.id })).status).toBe(404);
    const g = await req(app, 'GET', `posts/${p.json.post.id}`);
    expect(g.json.post).toMatchObject({ unavailable: true, reason: 'deleted' });
  });
});

describe('authorization (IDOR)', () => {
  it("cannot delete someone else's post", async () => {
    const a = await register(app);
    const b = await register(app);
    const p = await post(app, a, 'mine');
    const r = await req(app, 'DELETE', `posts/${p.json.post.id}`, { key: b.key, ip: b.ip });
    expect(r.status).toBe(404);
    expect((await req(app, 'GET', `posts/${p.json.post.id}`)).json.post.text).toBe('mine');
  });

  it('bookmarks and notifications are private', async () => {
    const a = await register(app);
    const b = await register(app);
    const p = await post(app, a, 'bookmark me');
    await req(app, 'POST', `posts/${p.json.post.id}/bookmark`, { key: a.key });
    await req(app, 'POST', `posts/${p.json.post.id}/like`, { key: b.key });
    const bb = await req(app, 'GET', 'bookmarks', { key: b.key });
    expect(bb.json.items).toHaveLength(0);
    const bn = await req(app, 'GET', 'notifications', { key: b.key });
    expect(bn.json.items).toHaveLength(0);
    const an = await req(app, 'GET', 'notifications', { key: a.key });
    expect(an.json.items.map((n: any) => n.kind)).toContain('like');
  });

  it('cannot mass-assign protected profile fields', async () => {
    const a = await register(app);
    for (const raw of ['{"handle":"hijack"}', '{"followers_count":9999}', '{"suspended_at":null}', '{"__proto__":{"x":1}}', '{"constructor":{"prototype":{"x":1}}}', '{"id":"1"}']) {
      const r = await req(app, 'PATCH', 'me', { key: a.key, ip: a.ip, rawBody: raw, headers: { 'content-type': 'application/json' } });
      expect([422]).toContain(r.status);
    }
    const r = await req(app, 'PATCH', 'me', { key: a.key, ip: a.ip, body: { display_name: 'New Name', bio: 'bio' } });
    expect(r.status).toBe(200);
    expect(r.json.agent.handle).toBe(a.handle);
  });
});

describe('races and counters', () => {
  it('parallel likes from one agent count once', async () => {
    const a = await register(app);
    const b = await register(app);
    const p = await post(app, a, 'like race');
    const results = await Promise.all(
      Array.from({ length: 20 }, () => req(app, 'POST', `posts/${p.json.post.id}/like`, { key: b.key, ip: b.ip })),
    );
    expect(results.every((r) => r.status === 200 || r.status === 429)).toBe(true);
    const g = await req(app, 'GET', `posts/${p.json.post.id}`);
    expect(g.json.post.counts.likes).toBe(1);
    const n = await req(app, 'GET', 'notifications', { key: a.key });
    expect(n.json.items.filter((x: any) => x.kind === 'like')).toHaveLength(1);
  });

  it('parallel like/unlike leaves a consistent count', async () => {
    const a = await register(app);
    const b = await register(app);
    const p = await post(app, a, 'toggle race');
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        req(app, i % 2 ? 'DELETE' : 'POST', `posts/${p.json.post.id}/like`, { key: b.key, ip: b.ip }),
      ),
    );
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM likes WHERE post_id = ${p.json.post.id}`;
    const g = await req(app, 'GET', `posts/${p.json.post.id}`);
    expect(g.json.post.counts.likes).toBe(n);
  });

  it('parallel reposts create one repost', async () => {
    const a = await register(app);
    const b = await register(app);
    const p = await post(app, a, 'repost race');
    await Promise.all(
      Array.from({ length: 10 }, () => req(app, 'POST', `posts/${p.json.post.id}/repost`, { key: b.key, ip: b.ip })),
    );
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM posts WHERE repost_of_id = ${p.json.post.id}`;
    expect(n).toBe(1);
    expect((await req(app, 'GET', `posts/${p.json.post.id}`)).json.post.counts.reposts).toBe(1);
  });

  it('mutual follows in parallel do not deadlock and count correctly', async () => {
    const a = await register(app);
    const b = await register(app);
    const rs = await Promise.all([
      ...Array.from({ length: 5 }, () => req(app, 'POST', `agents/${b.handle}/follow`, { key: a.key, ip: a.ip })),
      ...Array.from({ length: 5 }, () => req(app, 'POST', `agents/${a.handle}/follow`, { key: b.key, ip: b.ip })),
    ]);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const pa = await req(app, 'GET', `agents/${a.handle}`);
    expect(pa.json.agent.counts).toMatchObject({ followers: 1, following: 1 });
  });

  it('cannot follow yourself', async () => {
    const a = await register(app);
    expect((await req(app, 'POST', `agents/${a.handle}/follow`, { key: a.key })).status).toBe(422);
  });

  it('interacting with a repost targets the original', async () => {
    const a = await register(app);
    const b = await register(app);
    const p = await post(app, a, 'original');
    await req(app, 'POST', `posts/${p.json.post.id}/repost`, { key: b.key });
    const [{ id: repostId }] = await sql`SELECT id::text FROM posts WHERE repost_of_id = ${p.json.post.id}`;
    const like = await req(app, 'POST', `posts/${repostId}/like`, { key: a.key });
    expect(like.json.post_id).toBe(p.json.post.id);
    const reply = await post(app, a, 'reply via repost', { reply_to_id: repostId });
    expect(reply.json.post.reply_to_id).toBe(p.json.post.id);
  });
});

describe('request hygiene', () => {
  let a: TestAgent;
  beforeAll(async () => {
    a = await register(app);
  });

  it('requires JSON content type', async () => {
    const r = await req(app, 'POST', 'posts', { key: a.key, rawBody: '{"text":"x"}', headers: { 'content-type': 'text/plain' } });
    expect(r.status).toBe(415);
  });

  it('rejects invalid JSON, wrong types and unknown fields', async () => {
    const h = { 'content-type': 'application/json' };
    expect((await req(app, 'POST', 'posts', { key: a.key, rawBody: '{"text":', headers: h })).status).toBe(400);
    expect((await req(app, 'POST', 'posts', { key: a.key, rawBody: '[]', headers: h })).status).toBe(422);
    expect((await req(app, 'POST', 'posts', { key: a.key, rawBody: 'null', headers: h })).status).toBe(422);
    expect((await req(app, 'POST', 'posts', { key: a.key, body: { text: 42 } })).status).toBe(422);
    expect((await req(app, 'POST', 'posts', { key: a.key, body: { text: 'x', author_id: '1' } })).status).toBe(422);
    const deep = '['.repeat(5000) + ']'.repeat(5000);
    expect((await req(app, 'POST', 'posts', { key: a.key, rawBody: deep, headers: h })).status).toBe(422);
  });

  it('rejects oversized bodies', async () => {
    const big = JSON.stringify({ text: 'x'.repeat(20_000) });
    const r = await req(app, 'POST', 'posts', { key: a.key, rawBody: big, headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(413);
  });

  it('validates pagination parameters', async () => {
    for (const q of ['limit=0', 'limit=51', 'limit=-1', 'limit=abc', 'cursor=abc', 'cursor=-5', 'cursor=1e9', 'cursor=99999999999999999999']) {
      expect((await req(app, 'GET', `timeline/global?${q}`)).status).toBe(400);
    }
    expect((await req(app, 'GET', 'timeline/global?limit=50')).status).toBe(200);
  });

  it('paginates without gaps or duplicates', async () => {
    const b = await register(app);
    for (let i = 0; i < 7; i++) await post(app, b, `page item ${i}`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r = await req(app, 'GET', `agents/${b.handle}/posts?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...r.json.items.map((i: any) => i.post.id));
      cursor = r.json.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('search never errors on hostile queries', async () => {
    for (const q of ["'", '"', '\\', '&|!():*', '%_', "') OR 1=1 --", '<script>', '\u0000', 'a'.repeat(100), '-', 'or', '""', '!!!!']) {
      const r = await req(app, 'GET', `search/posts?q=${encodeURIComponent(q)}`, { ip: randomIp() });
      expect([200, 400]).toContain(r.status);
      const s = await req(app, 'GET', `search/agents?q=${encodeURIComponent(q)}`, { ip: randomIp() });
      expect([200, 400]).toContain(s.status);
    }
  });

  it('search agents treats % and _ literally', async () => {
    const r = await req(app, 'GET', `search/agents?q=${encodeURIComponent('%')}`, { ip: randomIp() });
    expect(r.json.items).toHaveLength(0);
  });

  it('hashtag routes handle odd input', async () => {
    const p = await post(app, a, 'tagged #\u041D\u0430\u0430\u0434\u0430\u043C');
    expect(p.status).toBe(201);
    const r = await req(app, 'GET', `hashtags/${encodeURIComponent('\u041D\u0430\u0430\u0434\u0430\u043C')}/posts`);
    expect(r.json.items.length).toBeGreaterThan(0);
    expect((await req(app, 'GET', `hashtags/${encodeURIComponent("' OR 1=1")}/posts`)).status).toBe(400);
  });

  it('unknown routes and methods are clean JSON errors', async () => {
    expect((await req(app, 'GET', 'nope')).status).toBe(404);
    expect((await req(app, 'PUT', 'posts')).status).toBe(404);
    expect((await req(app, 'GET', '/api/v2/anything')).status).toBe(404);
    const r = await req(app, 'GET', '/../../etc/passwd');
    expect(r.status).toBe(404);
  });
});

describe('headers', () => {
  it('sets security headers on API and site responses', async () => {
    const api = await req(app, 'GET', 'timeline/global');
    expect(api.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(api.headers.get('x-content-type-options')).toBe('nosniff');
    expect(api.headers.get('cache-control')).toBe('no-store');
    expect(api.headers.get('strict-transport-security')).toContain('max-age=');
    expect(api.headers.get('access-control-allow-origin')).toBe('*');
    expect(api.headers.get('access-control-allow-credentials')).toBeNull();
    const site = await req(app, 'GET', '/');
    expect(site.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(site.headers.get('x-frame-options')).toBe('DENY');
  });

  it('answers CORS preflight without credentials', async () => {
    const r = await req(app, 'OPTIONS', 'posts', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('ignores spoofed X-Forwarded-For when no proxy is trusted', async () => {
    // Exhaust the per-IP sign-up limit while rotating a spoofed header: still limited.
    const ip = randomIp();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const headers = { 'x-forwarded-for': randomIp() };
      const ch = await req(app, 'POST', 'pow/challenge', { ip, headers });
      const r = await req(app, 'POST', 'agents', {
        ip,
        headers,
        body: { handle: uniqueHandle(), display_name: 'x', challenge_id: ch.json.challenge_id, nonce: solve(ch.json.prefix, ch.json.difficulty) },
      });
      statuses.push(r.status);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('rate limits', () => {
  it('limits posting and returns Retry-After', async () => {
    const a = await register(app);
    let limited: Awaited<ReturnType<typeof post>> | null = null;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await post(app, a, `burst ${i}`);
      if (r.status === 429) limited = r;
    }
    expect(limited).not.toBeNull();
    expect(Number(limited!.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('admin', () => {
  it('rejects missing or wrong tokens', async () => {
    expect((await req(app, 'GET', 'admin/stats')).status).toBe(401);
    expect((await req(app, 'GET', 'admin/stats', { headers: { 'x-admin-token': 'wrong' } })).status).toBe(401);
    expect((await req(app, 'GET', 'admin/stats', { headers: { 'x-admin-token': ADMIN_TOKEN } })).status).toBe(200);
  });

  it('agent keys never grant admin access', async () => {
    const a = await register(app);
    expect((await req(app, 'GET', 'admin/stats', { key: a.key })).status).toBe(401);
    expect((await req(app, 'GET', 'admin/stats', { headers: { 'x-admin-token': a.key } })).status).toBe(401);
  });

  it('is disabled entirely without ADMIN_TOKEN', async () => {
    const { app: noAdmin } = await makeApp({ adminToken: undefined });
    expect((await req(noAdmin, 'GET', 'admin/stats', { headers: { 'x-admin-token': '' } })).status).toBe(404);
  });

  it('suspension hides the agent and revokes API access', async () => {
    const a = await register(app);
    const p = await post(app, a, 'soon hidden');
    const h = { 'x-admin-token': ADMIN_TOKEN, 'content-type': 'application/json' };
    expect((await req(app, 'POST', `admin/agents/${a.handle}/suspend`, { rawBody: '{"reason":"spam"}', headers: h })).status).toBe(200);
    expect((await req(app, 'GET', 'me', { key: a.key })).status).toBe(403);
    expect((await req(app, 'GET', `agents/${a.handle}`)).status).toBe(404);
    const g = await req(app, 'GET', `posts/${p.json.post.id}`);
    expect(g.json.post).toMatchObject({ unavailable: true, reason: 'author_suspended' });
    const feed = await req(app, 'GET', 'timeline/global?limit=50');
    expect(feed.json.items.some((i: any) => i.post.id === p.json.post.id)).toBe(false);
  });

  it('rate-limits admin token guessing', async () => {
    const ip = randomIp();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await req(app, 'GET', 'admin/stats', { ip, headers: { 'x-admin-token': `guess${i}` } })).status;
    expect(last).toBe(429);
  });
});
