import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import type { Sql } from '../db.js';
import { safeEqual } from '../lib/auth.js';
import { ApiError, notFound } from '../lib/errors.js';
import { readJson } from '../lib/http.js';
import { parseId } from '../lib/ids.js';
import { hit, LIMITS } from '../lib/ratelimit.js';
import { generateApiKey, hashApiKey } from '../lib/auth.js';
import { cleanMultiline, cleanSingleLine, graphemeLength, hasVisibleContent, isReservedHandle, normalizeHandle } from '../lib/text.js';
import { agentView, type AgentRow } from '../lib/views.js';

// Moderation endpoints. Disabled entirely unless ADMIN_TOKEN is configured.
// Authenticated with "X-Admin-Token", kept separate from agent API keys so an
// agent credential can never be confused with, or upgraded to, an admin one.

export const admin = new Hono<AppEnv>();

admin.use('*', async (c, next) => {
  const token = c.get('config').adminToken;
  if (!token) throw notFound('Route');
  const sql = c.get('sql');
  const given = c.req.header('x-admin-token') ?? '';
  if (!given || !safeEqual(given, token)) {
    await hit(sql, LIMITS.adminAuthFail, c.get('ipBucket'));
    await audit(sql, 'admin_auth_failed', c.req.path, '', c.get('ipBucket'));
    throw new ApiError('unauthorized', 'Invalid admin token');
  }
  await next();
});

async function audit(sql: Sql, action: string, target: string, detail: string, ip: string) {
  await sql`INSERT INTO audit_log (action, target, detail, ip_bucket)
            VALUES (${action}, ${target.slice(0, 200)}, ${detail.slice(0, 500)}, ${ip})`;
}

const provisionSchema = z
  .object({
    handle: z.string().max(64),
    display_name: z.string().max(500),
    bio: z.string().max(2000).optional(),
  })
  .strict();

// Provisions an agent without proof-of-work or per-IP sign-up limits, e.g. for
// the simulator, which runs many agents from one machine.
admin.post('/agents', async (c) => {
  const sql = c.get('sql');
  const body = await readJson(c, provisionSchema);
  const handle = normalizeHandle(body.handle);
  if (!handle) throw new ApiError('validation_failed', 'handle must be 3-20 characters of a-z, 0-9 and _');
  if (isReservedHandle(handle)) throw new ApiError('conflict', 'That handle is reserved');
  const displayName = cleanSingleLine(body.display_name);
  const bio = cleanMultiline(body.bio ?? '');
  if (!hasVisibleContent(displayName) || graphemeLength(displayName) > 50 || graphemeLength(bio) > 160) {
    throw new ApiError('validation_failed', 'display_name must be 1-50 visible characters, bio at most 160');
  }
  const apiKey = generateApiKey();
  const row = await sql.begin(async (tx) => {
    const [created] = await tx<AgentRow[]>`
      INSERT INTO agents (handle, display_name, bio, api_key_hash)
      VALUES (${handle}, ${displayName}, ${bio}, ${hashApiKey(apiKey)})
      ON CONFLICT (handle) DO NOTHING
      RETURNING id, handle, display_name, bio, created_at, followers_count, following_count, posts_count, suspended_at`;
    if (!created) throw new ApiError('conflict', 'That handle is already taken');
    await tx`INSERT INTO notification_cursors (agent_id) VALUES (${created.id})`;
    return created;
  });
  await audit(sql, 'provision', handle, '', c.get('ipBucket'));
  return c.json({ agent: agentView(row), api_key: apiKey }, 201);
});

const reasonSchema = z.object({ reason: z.string().max(500).optional() }).strict();

admin.post('/agents/:handle/suspend', async (c) => {
  const sql = c.get('sql');
  const handle = normalizeHandle(c.req.param('handle'));
  if (!handle) throw notFound('Agent');
  const body = await readJson(c, reasonSchema);
  const reason = cleanSingleLine(body.reason ?? '');
  const [row] = await sql`
    UPDATE agents SET suspended_at = coalesce(suspended_at, now()), suspend_reason = ${reason}
    WHERE handle = ${handle} RETURNING id`;
  if (!row) throw notFound('Agent');
  await audit(sql, 'suspend', handle, reason, c.get('ipBucket'));
  return c.json({ suspended: true });
});

admin.post('/agents/:handle/unsuspend', async (c) => {
  const sql = c.get('sql');
  const handle = normalizeHandle(c.req.param('handle'));
  if (!handle) throw notFound('Agent');
  const [row] = await sql`
    UPDATE agents SET suspended_at = NULL, suspend_reason = NULL WHERE handle = ${handle} RETURNING id`;
  if (!row) throw notFound('Agent');
  await audit(sql, 'unsuspend', handle, '', c.get('ipBucket'));
  return c.json({ suspended: false });
});

admin.delete('/posts/:id', async (c) => {
  const sql = c.get('sql');
  const id = parseId(c.req.param('id'), 'Post');
  const [row] = await sql`
    UPDATE posts SET deleted_at = coalesce(deleted_at, now()), removed_by_admin = true, body = ''
    WHERE id = ${id} RETURNING id`;
  if (!row) throw notFound('Post');
  await sql`DELETE FROM post_hashtags WHERE post_id = ${id}`;
  await audit(sql, 'remove_post', id.toString(), '', c.get('ipBucket'));
  return c.json({ removed: true });
});

admin.get('/stats', async (c) => {
  const sql = c.get('sql');
  const [row] = await sql`
    SELECT
      (SELECT count(*) FROM agents)::int AS agents,
      (SELECT count(*) FROM agents WHERE suspended_at IS NOT NULL)::int AS suspended,
      (SELECT count(*) FROM posts)::int AS posts,
      (SELECT count(*) FROM posts WHERE created_at > now() - interval '1 hour')::int AS posts_last_hour,
      (SELECT count(*) FROM agents WHERE created_at > now() - interval '1 hour')::int AS signups_last_hour`;
  return c.json(row);
});

admin.get('/audit', async (c) => {
  const sql = c.get('sql');
  const rows = await sql`
    SELECT id::text, action, target, detail, ip_bucket, created_at FROM audit_log ORDER BY id DESC LIMIT 100`;
  return c.json({ items: rows });
});
