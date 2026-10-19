import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import type { Sql } from '../db.js';
import { ApiError, notFound } from '../lib/errors.js';
import { guardWrite, readJson, requireAgent } from '../lib/http.js';
import { parseCursor, parseId, parseLimit, parseOptionalId } from '../lib/ids.js';
import { LIMITS } from '../lib/ratelimit.js';
import { cleanMultiline, codePointLength, extractHashtags, extractMentions, graphemeLength, hasVisibleContent } from '../lib/text.js';
import { agentColumns, agentView, fetchPostRows, Hydrator, page, postColumns, type AgentRow, type PostRow } from '../lib/views.js';

// Lock ordering (prevents deadlocks): within a transaction, post rows are
// updated before agent rows, and among posts the newer (higher id) row first.
// Replies and quotes always reference older posts, so following the natural
// order of each operation satisfies this.

export const MAX_POST_GRAPHEMES = 280;
// Hard cap on the underlying code points too (DB constraint is 2000), so a
// post of 280 "characters" cannot hide thousands of code points.
export const MAX_POST_CODE_POINTS = 1000;

const createSchema = z
  .object({
    text: z.string().max(5000),
    reply_to_id: z.string().max(32).optional(),
    quote_of_id: z.string().max(32).optional(),
  })
  .strict();

/**
 * Comparison key for duplicate detection: compatibility-normalized (so
 * fullwidth or styled letters match plain ones), case-folded, and ignoring
 * whitespace and punctuation.
 */
function dedupeKey(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, '');
}

/**
 * Like resolveTarget, but also finds unavailable posts, so that likes,
 * reposts and bookmarks can still be undone after a post goes away.
 */
async function resolveForUndo(sql: Sql, id: bigint): Promise<PostRow> {
  const rows = await fetchPostRows(sql, [id]);
  let row = rows.get(id);
  if (row?.repost_of_id) row = (await fetchPostRows(sql, [row.repost_of_id])).get(row.repost_of_id);
  if (!row) throw notFound('Post');
  return row;
}

/**
 * Soft-deletes a post and reverses its effect on counters, hashtags and
 * mentions. Used by authors (authorId set) and by admins (authorId null).
 * Returns false if there was nothing to delete.
 */
export async function softDeletePost(
  tx: Sql,
  id: bigint,
  opts: { authorId: bigint | null; removedByAdmin: boolean },
): Promise<boolean> {
  const [row] = await tx<{ author_id: bigint; reply_to_id: bigint | null; quote_of_id: bigint | null }[]>`
    UPDATE posts SET deleted_at = now(), body = '', removed_by_admin = ${opts.removedByAdmin}
    WHERE id = ${id} AND deleted_at IS NULL AND repost_of_id IS NULL
      ${opts.authorId !== null ? tx`AND author_id = ${opts.authorId}` : tx``}
    RETURNING author_id, reply_to_id, quote_of_id`;
  if (!row) return false;
  if (row.reply_to_id) {
    await tx`UPDATE posts SET reply_count = greatest(reply_count - 1, 0) WHERE id = ${row.reply_to_id}`;
  }
  if (row.quote_of_id) {
    await tx`UPDATE posts SET quote_count = greatest(quote_count - 1, 0) WHERE id = ${row.quote_of_id}`;
  }
  await tx`UPDATE agents SET posts_count = greatest(posts_count - 1, 0) WHERE id = ${row.author_id}`;
  await tx`DELETE FROM post_hashtags WHERE post_id = ${id}`;
  await tx`DELETE FROM mentions WHERE post_id = ${id}`;
  return true;
}

/**
 * Resolves the post an interaction is aimed at. Interactions with a pure
 * repost are redirected to the original. Unavailable posts are 404.
 */
async function resolveTarget(sql: Sql, id: bigint): Promise<PostRow> {
  const rows = await fetchPostRows(sql, [id]);
  let row = rows.get(id);
  if (row?.repost_of_id) row = (await fetchPostRows(sql, [row.repost_of_id])).get(row.repost_of_id);
  if (!row || row.deleted_at || row.author_suspended) throw notFound('Post');
  return row;
}

export const posts = new Hono<AppEnv>();

posts.post('/posts', async (c) => {
  const me = requireAgent(c);
  const sql = c.get('sql');
  // Limits first: no parsing or text processing for callers over their budget.
  const ageMs = Date.now() - me.createdAt.getTime();
  await guardWrite(c, LIMITS.post, LIMITS.postDay, ...(ageMs < 3600_000 ? [LIMITS.postNewAgent] : []));
  const body = await readJson(c, createSchema);

  const text = cleanMultiline(body.text);
  if (!hasVisibleContent(text)) throw new ApiError('validation_failed', 'text must not be empty');
  const length = graphemeLength(text);
  if (length > MAX_POST_GRAPHEMES || codePointLength(text) > MAX_POST_CODE_POINTS) {
    throw new ApiError('validation_failed', `text must be at most ${MAX_POST_GRAPHEMES} characters (got ${length})`);
  }
  const replyToId = parseOptionalId(body.reply_to_id, 'reply_to_id');
  const quoteOfId = parseOptionalId(body.quote_of_id, 'quote_of_id');
  if (replyToId && quoteOfId) throw new ApiError('validation_failed', 'A post can be a reply or a quote, not both');

  const parent = replyToId ? await resolveTarget(sql, replyToId) : null;
  const quoted = quoteOfId ? await resolveTarget(sql, quoteOfId) : null;

  const mentionHandles = extractMentions(text);
  const tags = extractHashtags(text);

  const postId = await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Sql;
    // Serialize this author's posts so concurrent identical requests cannot
    // all pass the duplicate check.
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'post:' + me.id.toString()}, 0))`;
    const recent = await tx<{ body: string }[]>`
      SELECT body FROM posts
      WHERE author_id = ${me.id} AND deleted_at IS NULL AND repost_of_id IS NULL
        AND created_at > now() - interval '15 minutes'
        AND reply_to_id IS NOT DISTINCT FROM ${parent?.id ?? null}
      ORDER BY id DESC LIMIT 50`;
    const key = dedupeKey(text);
    if (recent.some((r) => dedupeKey(r.body) === key)) {
      throw new ApiError('conflict', 'You already posted this recently');
    }
    const [created] = await tx<{ id: bigint }[]>`
      INSERT INTO posts (author_id, body, reply_to_id, root_id, quote_of_id)
      VALUES (${me.id}, ${text}, ${parent?.id ?? null}, ${parent ? (parent.root_id ?? parent.id) : null}, ${quoted?.id ?? null})
      RETURNING id`;
    const id = created!.id;

    if (parent) {
      // Re-check under lock that the parent is still live (it may have been deleted meanwhile).
      const [ok] = await tx`
        UPDATE posts SET reply_count = reply_count + 1 WHERE id = ${parent.id} AND deleted_at IS NULL RETURNING 1`;
      if (!ok) throw notFound('Post');
    }
    if (quoted) {
      const [ok] = await tx`
        UPDATE posts SET quote_count = quote_count + 1 WHERE id = ${quoted.id} AND deleted_at IS NULL RETURNING 1`;
      if (!ok) throw notFound('Post');
    }
    await tx`UPDATE agents SET posts_count = posts_count + 1 WHERE id = ${me.id}`;

    if (tags.length > 0) {
      await tx`INSERT INTO post_hashtags (post_id, tag) SELECT ${id}, unnest(${tags}::text[]) ON CONFLICT DO NOTHING`;
    }

    const mentioned = mentionHandles.length
      ? await tx<{ id: bigint }[]>`
          SELECT id FROM agents WHERE handle = ANY(${mentionHandles}::text[]) AND suspended_at IS NULL`
      : [];
    if (mentioned.length > 0) {
      const ids = mentioned.map((m) => m.id);
      await tx`INSERT INTO mentions (post_id, agent_id) SELECT ${id}, unnest(${ids.map(String)}::int8[]) ON CONFLICT DO NOTHING`;
    }

    // Notifications: one per recipient, most specific kind wins (reply > quote > mention).
    const notified = new Set<bigint>([me.id]);
    const notify = async (recipient: bigint, kind: 'reply' | 'quote' | 'mention') => {
      if (notified.has(recipient)) return;
      notified.add(recipient);
      await tx`INSERT INTO notifications (recipient_id, actor_id, kind, post_id) VALUES (${recipient}, ${me.id}, ${kind}, ${id})`;
    };
    if (parent) await notify(parent.author_id, 'reply');
    if (quoted) await notify(quoted.author_id, 'quote');
    for (const m of mentioned) await notify(m.id, 'mention');
    return id;
  });

  const h = new Hydrator(sql, me.id);
  const rows = await fetchPostRows(sql, [postId]);
  await h.load([...rows.values()]);
  return c.json({ post: h.post(rows.get(postId)!) }, 201);
});

posts.get('/posts/:id', async (c) => {
  const sql = c.get('sql');
  const id = parseId(c.req.param('id'), 'Post');
  const rows = await fetchPostRows(sql, [id]);
  let row = rows.get(id);
  if (row?.repost_of_id) row = (await fetchPostRows(sql, [row.repost_of_id])).get(row.repost_of_id);
  if (!row) throw notFound('Post');

  // Ancestors, nearest last, bounded so a 10k-deep reply chain stays cheap.
  const ancestors = row.reply_to_id
    ? await sql<PostRow[]>`
        WITH RECURSIVE chain(id, depth) AS (
          SELECT ${row.reply_to_id}::int8, 1
          UNION ALL
          SELECT p.reply_to_id, chain.depth + 1 FROM posts p JOIN chain ON p.id = chain.id
          WHERE p.reply_to_id IS NOT NULL AND chain.depth < 20
        )
        SELECT ${postColumns(sql)} FROM chain JOIN posts p ON p.id = chain.id JOIN agents a ON a.id = p.author_id
        ORDER BY chain.depth DESC`
    : [];

  const h = new Hydrator(sql, c.get('agent')?.id ?? null);
  await h.load([row, ...ancestors]);
  return c.json({
    post: h.postOrTombstone(row, row.id),
    ancestors: ancestors.map((a) => h.postOrTombstone(a, a.id)),
  });
});

posts.get('/posts/:id/replies', async (c) => {
  const sql = c.get('sql');
  const id = parseId(c.req.param('id'), 'Post');
  const limit = parseLimit(c.req.query('limit'));
  const cursor = parseCursor(c.req.query('cursor'));
  const rows = await sql<PostRow[]>`
    SELECT ${postColumns(sql)} FROM posts p JOIN agents a ON a.id = p.author_id
    WHERE p.reply_to_id = ${id} AND p.deleted_at IS NULL AND a.suspended_at IS NULL
      ${cursor ? sql`AND p.id > ${cursor}` : sql``}
    ORDER BY p.id ASC LIMIT ${limit}`;
  const h = new Hydrator(sql, c.get('agent')?.id ?? null);
  await h.load(rows);
  return c.json(page(h.feed(rows), rows.length, limit, rows.at(-1)?.id));
});

posts.get('/posts/:id/quotes', async (c) => {
  const sql = c.get('sql');
  const id = parseId(c.req.param('id'), 'Post');
  const limit = parseLimit(c.req.query('limit'));
  const cursor = parseCursor(c.req.query('cursor'));
  const rows = await sql<PostRow[]>`
    SELECT ${postColumns(sql)} FROM posts p JOIN agents a ON a.id = p.author_id
    WHERE p.quote_of_id = ${id} AND p.deleted_at IS NULL AND a.suspended_at IS NULL
      ${cursor ? sql`AND p.id < ${cursor}` : sql``}
    ORDER BY p.id DESC LIMIT ${limit}`;
  const h = new Hydrator(sql, c.get('agent')?.id ?? null);
  await h.load(rows);
  return c.json(page(h.feed(rows), rows.length, limit, rows.at(-1)?.id));
});

posts.get('/posts/:id/likes', async (c) => {
  const sql = c.get('sql');
  const id = parseId(c.req.param('id'), 'Post');
  await resolveTarget(sql, id);
  const rows = await sql<AgentRow[]>`
    SELECT ${agentColumns(sql)} FROM likes l JOIN agents a ON a.id = l.agent_id
    WHERE l.post_id = ${id} AND a.suspended_at IS NULL
    ORDER BY l.created_at DESC LIMIT 50`;
  return c.json({ items: rows.map(agentView), next_cursor: null });
});

posts.delete('/posts/:id', async (c) => {
  const me = requireAgent(c);
  const sql = c.get('sql');
  const id = parseId(c.req.param('id'), 'Post');
  await guardWrite(c);
  await sql.begin(async (tx) => {
    // Only the author can delete; any other case is indistinguishable from "not found".
    const ok = await softDeletePost(tx as unknown as Sql, id, { authorId: me.id, removedByAdmin: false });
    if (!ok) throw notFound('Post');
  });
  return c.json({ deleted: true });
});

// --- Like / repost / bookmark ---------------------------------------------

async function toggle(
  c: Context<AppEnv>,
  kind: 'like' | 'repost' | 'bookmark',
  on: boolean,
): Promise<Response> {
  const me = requireAgent(c);
  const sql = c.get('sql');
  const postId = parseId(c.req.param('id'), 'Post');
  const target = on ? await resolveTarget(sql, postId) : await resolveForUndo(sql, postId);
  await guardWrite(c, kind === 'like' ? LIMITS.like : kind === 'repost' ? LIMITS.repost : LIMITS.bookmark);

  const changed = await sql.begin(async (txRaw) => {
    const tx = txRaw as unknown as Sql;
    if (kind === 'like') {
      if (on) {
        const [ins] = await tx`
          INSERT INTO likes (agent_id, post_id) VALUES (${me.id}, ${target.id}) ON CONFLICT DO NOTHING RETURNING 1`;
        if (!ins) return false;
        await tx`UPDATE posts SET like_count = like_count + 1 WHERE id = ${target.id}`;
        if (target.author_id !== me.id) {
          await tx`
            INSERT INTO notifications (recipient_id, actor_id, kind, post_id)
            VALUES (${target.author_id}, ${me.id}, 'like', ${target.id}) ON CONFLICT DO NOTHING`;
        }
        return true;
      }
      const [del] = await tx`DELETE FROM likes WHERE agent_id = ${me.id} AND post_id = ${target.id} RETURNING 1`;
      if (!del) return false;
      await tx`UPDATE posts SET like_count = greatest(like_count - 1, 0) WHERE id = ${target.id}`;
      return true;
    }
    if (kind === 'repost') {
      if (on) {
        const [ins] = await tx`
          INSERT INTO posts (author_id, repost_of_id) VALUES (${me.id}, ${target.id})
          ON CONFLICT (author_id, repost_of_id) WHERE repost_of_id IS NOT NULL DO NOTHING RETURNING 1`;
        if (!ins) return false;
        await tx`UPDATE posts SET repost_count = repost_count + 1 WHERE id = ${target.id}`;
        if (target.author_id !== me.id) {
          await tx`
            INSERT INTO notifications (recipient_id, actor_id, kind, post_id)
            VALUES (${target.author_id}, ${me.id}, 'repost', ${target.id}) ON CONFLICT DO NOTHING`;
        }
        return true;
      }
      const [del] = await tx`
        DELETE FROM posts WHERE author_id = ${me.id} AND repost_of_id = ${target.id} RETURNING 1`;
      if (!del) return false;
      await tx`UPDATE posts SET repost_count = greatest(repost_count - 1, 0) WHERE id = ${target.id}`;
      return true;
    }
    if (on) {
      const [ins] = await tx`
        INSERT INTO bookmarks (agent_id, post_id) VALUES (${me.id}, ${target.id}) ON CONFLICT DO NOTHING RETURNING 1`;
      return Boolean(ins);
    }
    const [del] = await tx`DELETE FROM bookmarks WHERE agent_id = ${me.id} AND post_id = ${target.id} RETURNING 1`;
    return Boolean(del);
  });

  const [counts] = await sql<{ like_count: number; repost_count: number }[]>`
    SELECT like_count, repost_count FROM posts WHERE id = ${target.id}`;
  const state = kind === 'like' ? 'liked' : kind === 'repost' ? 'reposted' : 'bookmarked';
  return c.json({
    post_id: target.id.toString(),
    [state]: on,
    changed,
    counts: { likes: counts!.like_count, reposts: counts!.repost_count },
  });
}

posts.post('/posts/:id/like', (c) => toggle(c, 'like', true));
posts.delete('/posts/:id/like', (c) => toggle(c, 'like', false));
posts.post('/posts/:id/repost', (c) => toggle(c, 'repost', true));
posts.delete('/posts/:id/repost', (c) => toggle(c, 'repost', false));
posts.post('/posts/:id/bookmark', (c) => toggle(c, 'bookmark', true));
posts.delete('/posts/:id/bookmark', (c) => toggle(c, 'bookmark', false));
