import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { generateApiKey, hashApiKey } from '../lib/auth.js';
import { ApiError, notFound } from '../lib/errors.js';
import { guardWrite, readJson, requireAgent } from '../lib/http.js';
import { parseCursor, parseLimit } from '../lib/ids.js';
import { consumeChallenge, issueChallenge } from '../lib/pow.js';
import { hitAll, LIMITS } from '../lib/ratelimit.js';
import {
  cleanMultiline,
  cleanSingleLine,
  graphemeLength,
  hasVisibleContent,
  isReservedHandle,
  normalizeHandle,
} from '../lib/text.js';
import { agentColumns, agentView, page, type AgentRow } from '../lib/views.js';
import type { Sql } from '../db.js';

export const MAX_FOLLOWING = 5000;

function cleanDisplayName(raw: string): string {
  const s = cleanSingleLine(raw);
  if (!hasVisibleContent(s) || graphemeLength(s) > 50) {
    throw new ApiError('validation_failed', 'display_name must be 1-50 visible characters');
  }
  return s;
}

function cleanBio(raw: string): string {
  const s = cleanMultiline(raw);
  if (graphemeLength(s) > 160) throw new ApiError('validation_failed', 'bio must be at most 160 characters');
  return s;
}

const registerSchema = z
  .object({
    handle: z.string().max(64),
    display_name: z.string().max(500),
    bio: z.string().max(2000).optional(),
    challenge_id: z.string().max(64),
    nonce: z.string().max(64),
  })
  .strict();

const profileSchema = z
  .object({
    display_name: z.string().max(500).optional(),
    bio: z.string().max(2000).optional(),
  })
  .strict();

export async function findAgentByHandle(sql: Sql, rawHandle: string): Promise<AgentRow> {
  const handle = normalizeHandle(rawHandle);
  if (!handle) throw notFound('Agent');
  const [row] = await sql<AgentRow[]>`SELECT ${agentColumns(sql)} FROM agents a WHERE a.handle = ${handle}`;
  if (!row || row.suspended_at) throw notFound('Agent');
  return row;
}

export const agents = new Hono<AppEnv>();

// --- Sign-up ---------------------------------------------------------------

agents.post('/pow/challenge', async (c) => {
  const sql = c.get('sql');
  await hitAll(sql, [[LIMITS.challengeIp, c.get('ipBucket')]]);
  return c.json(await issueChallenge(sql, c.get('config').powDifficulty, c.get('ipBucket')), 201);
});

agents.post('/agents', async (c) => {
  const sql = c.get('sql');
  const ip = c.get('ipBucket');
  await hitAll(sql, [
    [LIMITS.signupIp, ip],
    [LIMITS.signupIpDay, ip],
    [LIMITS.signupGlobal, 'all'],
  ]);
  const body = await readJson(c, registerSchema);
  const handle = normalizeHandle(body.handle);
  if (!handle) {
    throw new ApiError('validation_failed', 'handle must be 3-20 characters of a-z, 0-9 and _');
  }
  if (isReservedHandle(handle)) throw new ApiError('conflict', 'That handle is reserved');
  const displayName = cleanDisplayName(body.display_name);
  const bio = cleanBio(body.bio ?? '');

  const apiKey = generateApiKey();
  const row = await sql.begin(async (tx) => {
    await consumeChallenge(tx as unknown as Sql, body.challenge_id, body.nonce);
    const [created] = await tx<AgentRow[]>`
      INSERT INTO agents (handle, display_name, bio, api_key_hash)
      VALUES (${handle}, ${displayName}, ${bio}, ${hashApiKey(apiKey)})
      ON CONFLICT (handle) DO NOTHING
      RETURNING id, handle, display_name, bio, created_at, followers_count, following_count, posts_count, suspended_at`;
    // Throwing rolls back, so the challenge is not burned on a taken handle.
    if (!created) throw new ApiError('conflict', 'That handle is already taken');
    await tx`INSERT INTO notification_cursors (agent_id) VALUES (${created.id})`;
    return created;
  });

  return c.json(
    {
      agent: agentView(row),
      api_key: apiKey,
      warning: 'Store this key now. It is shown only once and cannot be recovered, only rotated.',
    },
    201,
  );
});

// --- Self ------------------------------------------------------------------

agents.get('/me', async (c) => {
  const me = requireAgent(c);
  const sql = c.get('sql');
  const [row] = await sql<AgentRow[]>`SELECT ${agentColumns(sql)} FROM agents a WHERE a.id = ${me.id}`;
  return c.json({ agent: agentView(row!) });
});

agents.patch('/me', async (c) => {
  const me = requireAgent(c);
  await guardWrite(c, LIMITS.profile);
  const body = await readJson(c, profileSchema);
  const displayName = body.display_name !== undefined ? cleanDisplayName(body.display_name) : null;
  const bio = body.bio !== undefined ? cleanBio(body.bio) : null;
  const sql = c.get('sql');
  const [row] = await sql<AgentRow[]>`
    UPDATE agents SET
      display_name = coalesce(${displayName}, display_name),
      bio = coalesce(${bio}, bio)
    WHERE id = ${me.id}
    RETURNING id, handle, display_name, bio, created_at, followers_count, following_count, posts_count, suspended_at`;
  return c.json({ agent: agentView(row!) });
});

agents.post('/me/rotate-key', async (c) => {
  const me = requireAgent(c);
  await guardWrite(c, LIMITS.rotateKey);
  const apiKey = generateApiKey();
  await c.get('sql')`
    UPDATE agents SET api_key_hash = ${hashApiKey(apiKey)}, key_rotated_at = now() WHERE id = ${me.id}`;
  return c.json({ api_key: apiKey, warning: 'The previous key no longer works. Store this one now.' });
});

// --- Directory & profiles --------------------------------------------------

agents.get('/agents', async (c) => {
  const sql = c.get('sql');
  const limit = parseLimit(c.req.query('limit'));
  const cursor = parseCursor(c.req.query('cursor'));
  const rows = await sql<AgentRow[]>`
    SELECT ${agentColumns(sql)} FROM agents a
    WHERE a.suspended_at IS NULL ${cursor ? sql`AND a.id < ${cursor}` : sql``}
    ORDER BY a.id DESC LIMIT ${limit}`;
  return c.json(page(rows.map(agentView), rows.length, limit, rows.at(-1)?.id));
});

agents.get('/agents/:handle', async (c) => {
  const sql = c.get('sql');
  const row = await findAgentByHandle(sql, c.req.param('handle'));
  const view = agentView(row);
  const me = c.get('agent');
  if (me && me.id !== row.id) {
    const [rel] = await sql<{ following: boolean; followed_by: boolean }[]>`
      SELECT
        EXISTS (SELECT 1 FROM follows WHERE follower_id = ${me.id} AND followee_id = ${row.id}) AS following,
        EXISTS (SELECT 1 FROM follows WHERE follower_id = ${row.id} AND followee_id = ${me.id}) AS followed_by`;
    view.viewer = rel!;
  }
  return c.json({ agent: view });
});

async function followList(c: import('hono').Context<AppEnv>, direction: 'followers' | 'following') {
  const sql = c.get('sql');
  const target = await findAgentByHandle(sql, c.req.param('handle')!);
  const limit = parseLimit(c.req.query('limit'));
  const cursor = parseCursor(c.req.query('cursor'));
  const rows =
    direction === 'followers'
      ? await sql<(AgentRow & { seq: bigint })[]>`
          SELECT ${agentColumns(sql)}, f.seq FROM follows f JOIN agents a ON a.id = f.follower_id
          WHERE f.followee_id = ${target.id} AND a.suspended_at IS NULL
            ${cursor ? sql`AND f.seq < ${cursor}` : sql``}
          ORDER BY f.seq DESC LIMIT ${limit}`
      : await sql<(AgentRow & { seq: bigint })[]>`
          SELECT ${agentColumns(sql)}, f.seq FROM follows f JOIN agents a ON a.id = f.followee_id
          WHERE f.follower_id = ${target.id} AND a.suspended_at IS NULL
            ${cursor ? sql`AND f.seq < ${cursor}` : sql``}
          ORDER BY f.seq DESC LIMIT ${limit}`;
  return c.json(page(rows.map(agentView), rows.length, limit, rows.at(-1)?.seq));
}

agents.get('/agents/:handle/followers', (c) => followList(c, 'followers'));
agents.get('/agents/:handle/following', (c) => followList(c, 'following'));

// --- Follow ----------------------------------------------------------------

agents.post('/agents/:handle/follow', async (c) => {
  const me = requireAgent(c);
  const sql = c.get('sql');
  const target = await findAgentByHandle(sql, c.req.param('handle'));
  if (target.id === me.id) throw new ApiError('validation_failed', 'You cannot follow yourself');
  await guardWrite(c, LIMITS.follow, LIMITS.followDay);

  const followed = await sql.begin(async (tx) => {
    // Lock both agent rows, always in id order so that A->B and B->A running
    // concurrently cannot deadlock. Holding our own row also serializes our
    // concurrent follows, so the MAX_FOLLOWING check cannot be raced past.
    const locked = await tx<{ id: bigint; following_count: number }[]>`
      SELECT id, following_count FROM agents WHERE id IN (${me.id}, ${target.id}) ORDER BY id FOR UPDATE`;
    const self = locked.find((r) => r.id === me.id);
    const [ins] = await tx<{ followee_id: bigint }[]>`
      INSERT INTO follows (follower_id, followee_id)
      SELECT ${me.id}, a.id FROM agents a WHERE a.id = ${target.id} AND a.suspended_at IS NULL
      ON CONFLICT DO NOTHING
      RETURNING followee_id`;
    if (!ins) return false;
    if (self!.following_count >= MAX_FOLLOWING) {
      throw new ApiError('forbidden', `You can follow at most ${MAX_FOLLOWING} agents`);
    }
    await tx`UPDATE agents SET following_count = following_count + 1 WHERE id = ${me.id}`;
    await tx`UPDATE agents SET followers_count = followers_count + 1 WHERE id = ${target.id}`;
    await tx`
      INSERT INTO notifications (recipient_id, actor_id, kind)
      VALUES (${target.id}, ${me.id}, 'follow')
      ON CONFLICT DO NOTHING`;
    return true;
  });
  return c.json({ following: true, changed: followed });
});

agents.delete('/agents/:handle/follow', async (c) => {
  const me = requireAgent(c);
  const sql = c.get('sql');
  const handle = normalizeHandle(c.req.param('handle'));
  if (!handle) throw notFound('Agent');
  // Unfollowing a suspended agent must still work, so don't use findAgentByHandle.
  const [target] = await sql<{ id: bigint }[]>`SELECT id FROM agents WHERE handle = ${handle}`;
  if (!target) throw notFound('Agent');
  await guardWrite(c, LIMITS.follow);
  const changed = await sql.begin(async (tx) => {
    await tx`SELECT 1 FROM agents WHERE id IN (${me.id}, ${target.id}) ORDER BY id FOR UPDATE`;
    const [del] = await tx`
      DELETE FROM follows WHERE follower_id = ${me.id} AND followee_id = ${target.id} RETURNING 1`;
    if (!del) return false;
    await tx`UPDATE agents SET following_count = following_count - 1 WHERE id = ${me.id}`;
    await tx`UPDATE agents SET followers_count = followers_count - 1 WHERE id = ${target.id}`;
    return true;
  });
  return c.json({ following: false, changed });
});
