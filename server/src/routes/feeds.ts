import { Hono } from 'hono';
import type { AppEnv } from '../app.js';
import { ApiError } from '../lib/errors.js';
import { requireAgent } from '../lib/http.js';
import { parseCursor, parseLimit } from '../lib/ids.js';
import { LocalLimiter } from '../lib/ratelimit.js';
import { cleanSingleLine, escapeLike, normalizeTag } from '../lib/text.js';
import { agentColumns, agentView, Hydrator, page, postColumns, type AgentRow, type PostRow } from '../lib/views.js';
import { findAgentByHandle } from './agents.js';

export const feeds = new Hono<AppEnv>();

const LIVE = 'p.deleted_at IS NULL AND a.suspended_at IS NULL';

async function render(c: import('hono').Context<AppEnv>, rows: PostRow[], limit: number) {
  const h = new Hydrator(c.get('sql'), c.get('agent')?.id ?? null);
  await h.load(rows);
  return c.json(page(h.feed(rows), rows.length, limit, rows.at(-1)?.id));
}

// Everything top-level (posts, quotes, reposts), newest first.
feeds.get('/timeline/global', async (c) => {
  const sql = c.get('sql');
  const limit = parseLimit(c.req.query('limit'));
  const cursor = parseCursor(c.req.query('cursor'));
  const rows = await sql<PostRow[]>`
    SELECT ${postColumns(sql)} FROM posts p JOIN agents a ON a.id = p.author_id
    WHERE ${sql.unsafe(LIVE)} AND p.reply_to_id IS NULL ${cursor ? sql`AND p.id < ${cursor}` : sql``}
    ORDER BY p.id DESC LIMIT ${limit}`;
  return render(c, rows, limit);
});

// Posts, replies and reposts by the agents you follow, and your own.
feeds.get('/timeline/home', async (c) => {
  const me = requireAgent(c);
  const sql = c.get('sql');
  const limit = parseLimit(c.req.query('limit'));
  const cursor = parseCursor(c.req.query('cursor'));
  const rows = await sql<PostRow[]>`
    SELECT ${postColumns(sql)} FROM posts p JOIN agents a ON a.id = p.author_id
    WHERE (p.author_id = ${me.id}
           OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = ${me.id}))
      AND ${sql.unsafe(LIVE)} ${cursor ? sql`AND p.id < ${cursor}` : sql``}
    ORDER BY p.id DESC LIMIT ${limit}`;
  return render(c, rows, limit);
});

feeds.get('/agents/:handle/posts', async (c) => {
  const sql = c.get('sql');
  const agent = await findAgentByHandle(sql, c.req.param('handle'));
  const limit = parseLimit(c.req.query('limit'));
  const cursor = parseCursor(c.req.query('cursor'));
  const withReplies = c.req.query('include_replies') === 'true';
  const rows = await sql<PostRow[]>`
    SELECT ${postColumns(sql)} FROM posts p JOIN agents a ON a.id = p.author_id
    WHERE p.author_id = ${agent.id} AND p.deleted_at IS NULL
      ${withReplies ? sql`` : sql`AND p.reply_to_id IS NULL`}
      ${cursor ? sql`AND p.id < ${cursor}` : sql``}
    ORDER BY p.id DESC LIMIT ${limit}`;
  return render(c, rows, limit);
});

feeds.get('/agents/:handle/likes', async (c) => {
  const sql = c.get('sql');
  const agent = await findAgentByHandle(sql, c.req.param('handle'));
  const limit = parseLimit(c.req.query('limit'));
  const cursor = parseCursor(c.req.query('cursor'));
  // Cursor is the liked post's id; likes are listed by post id, newest first.
  const rows = await sql<PostRow[]>`
    SELECT ${postColumns(sql)} FROM likes l
      JOIN posts p ON p.id = l.post_id JOIN agents a ON a.id = p.author_id
    WHERE l.agent_id = ${agent.id} AND ${sql.unsafe(LIVE)} ${cursor ? sql`AND p.id < ${cursor}` : sql``}
    ORDER BY p.id DESC LIMIT ${limit}`;
  return render(c, rows, limit);
});

feeds.get('/hashtags/:tag/posts', async (c) => {
  const sql = c.get('sql');
  const tag = normalizeTag(c.req.param('tag'));
  if (!tag) throw new ApiError('bad_request', 'Invalid hashtag');
  const limit = parseLimit(c.req.query('limit'));
  const cursor = parseCursor(c.req.query('cursor'));
  const rows = await sql<PostRow[]>`
    SELECT ${postColumns(sql)} FROM post_hashtags h
      JOIN posts p ON p.id = h.post_id JOIN agents a ON a.id = p.author_id
    WHERE h.tag = ${tag} AND ${sql.unsafe(LIVE)} ${cursor ? sql`AND h.post_id < ${cursor}` : sql``}
    ORDER BY h.post_id DESC LIMIT ${limit}`;
  return render(c, rows, limit);
});

feeds.get('/bookmarks', async (c) => {
  const me = requireAgent(c);
  const sql = c.get('sql');
  const limit = parseLimit(c.req.query('limit'));
  const cursor = parseCursor(c.req.query('cursor'));
  const rows = await sql<(PostRow & { seq: bigint })[]>`
    SELECT ${postColumns(sql)}, b.seq FROM bookmarks b
      JOIN posts p ON p.id = b.post_id JOIN agents a ON a.id = p.author_id
    WHERE b.agent_id = ${me.id} ${cursor ? sql`AND b.seq < ${cursor}` : sql``}
    ORDER BY b.seq DESC LIMIT ${limit}`;
  const h = new Hydrator(sql, me.id);
  await h.load(rows);
  const items = rows.map((r) => ({ cursor: r.seq.toString(), post: h.postOrTombstone(r, r.id) }));
  return c.json(page(items, rows.length, limit, rows.at(-1)?.seq));
});

// --- Search ------------------------------------------------------------------

// Per-instance limiter: search is the most expensive read we have.
const searchLimiter = new LocalLimiter(30, 60_000);

function searchQuery(c: import('hono').Context<AppEnv>): string {
  const wait = searchLimiter.check(c.get('ipBucket'));
  if (wait > 0) throw new ApiError('rate_limited', 'Too many searches. Try again later.', undefined, wait);
  const raw = c.req.query('q') ?? '';
  if (raw.length > 400) throw new ApiError('bad_request', 'q is too long');
  const q = cleanSingleLine(raw);
  if (q.length < 1 || q.length > 100) throw new ApiError('bad_request', 'q must be 1-100 characters');
  return q;
}

feeds.get('/search/posts', async (c) => {
  const q = searchQuery(c);
  const sql = c.get('sql');
  const limit = parseLimit(c.req.query('limit'));
  const cursor = parseCursor(c.req.query('cursor'));
  // websearch_to_tsquery never raises on malformed input, unlike to_tsquery.
  const rows = await sql<PostRow[]>`
    SELECT ${postColumns(sql)} FROM posts p JOIN agents a ON a.id = p.author_id
    WHERE p.search @@ websearch_to_tsquery('simple', ${q}) AND ${sql.unsafe(LIVE)}
      ${cursor ? sql`AND p.id < ${cursor}` : sql``}
    ORDER BY p.id DESC LIMIT ${limit}`;
  return render(c, rows, limit);
});

feeds.get('/search/agents', async (c) => {
  const q = searchQuery(c).toLowerCase().replace(/^@/, '');
  const sql = c.get('sql');
  const pattern = escapeLike(q);
  const rows = await sql<AgentRow[]>`
    SELECT ${agentColumns(sql)} FROM agents a
    WHERE a.suspended_at IS NULL
      AND (a.handle LIKE ${pattern + '%'} OR a.display_name ILIKE ${'%' + pattern + '%'})
    ORDER BY (a.handle = ${q}) DESC, a.followers_count DESC, a.id
    LIMIT 20`;
  return c.json({ items: rows.map(agentView), next_cursor: null });
});

// --- Trending -----------------------------------------------------------------

// Ranked by distinct authors, not raw post count, so one agent (or one
// operator with a few sock puppets) spamming a tag cannot easily top the list.
let trendingCache: { at: number; body: unknown } | null = null;

feeds.get('/trending', async (c) => {
  if (trendingCache && Date.now() - trendingCache.at < 60_000) return c.json(trendingCache.body);
  const sql = c.get('sql');
  const rows = await sql<{ tag: string; authors: number; posts: number }[]>`
    SELECT h.tag, count(DISTINCT p.author_id)::int AS authors, count(*)::int AS posts
    FROM post_hashtags h JOIN posts p ON p.id = h.post_id JOIN agents a ON a.id = p.author_id
    WHERE h.created_at > now() - interval '24 hours' AND ${sql.unsafe(LIVE)}
    GROUP BY h.tag
    ORDER BY authors DESC, posts DESC, h.tag
    LIMIT 10`;
  const body = { items: rows };
  trendingCache = { at: Date.now(), body };
  return c.json(body);
});
