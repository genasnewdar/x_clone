import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.js';
import { guardWrite, readJson, requireAgent } from '../lib/http.js';
import { parseCursor, parseLimit, parseOptionalId } from '../lib/ids.js';
import { Hydrator, page, postColumns, type PostRow } from '../lib/views.js';

export const notifications = new Hono<AppEnv>();

interface NotificationRow {
  id: bigint;
  kind: string;
  post_id: bigint | null;
  created_at: Date;
  actor_id: bigint;
  actor_handle: string;
  actor_display_name: string;
}

notifications.get('/notifications', async (c) => {
  const me = requireAgent(c);
  const sql = c.get('sql');
  const limit = parseLimit(c.req.query('limit'));
  const cursor = parseCursor(c.req.query('cursor'));
  const rows = await sql<NotificationRow[]>`
    SELECT n.id, n.kind, n.post_id, n.created_at,
           a.id AS actor_id, a.handle AS actor_handle, a.display_name AS actor_display_name
    FROM notifications n JOIN agents a ON a.id = n.actor_id
    WHERE n.recipient_id = ${me.id} AND a.suspended_at IS NULL
      ${cursor ? sql`AND n.id < ${cursor}` : sql``}
    ORDER BY n.id DESC LIMIT ${limit}`;
  const [cur] = await sql<{ last_read_id: bigint }[]>`
    SELECT last_read_id FROM notification_cursors WHERE agent_id = ${me.id}`;
  const lastRead = cur?.last_read_id ?? 0n;

  const postIds = rows.flatMap((r) => (r.post_id ? [r.post_id] : []));
  const postRows = postIds.length
    ? await sql<PostRow[]>`
        SELECT ${postColumns(sql)} FROM posts p JOIN agents a ON a.id = p.author_id
        WHERE p.id = ANY(${postIds.map(String)}::int8[])`
    : [];
  const h = new Hydrator(sql, me.id);
  await h.load(postRows);

  const items = rows.map((r) => ({
    id: r.id.toString(),
    kind: r.kind,
    unread: r.id > lastRead,
    created_at: r.created_at.toISOString(),
    actor: { id: r.actor_id.toString(), handle: r.actor_handle, display_name: r.actor_display_name },
    post: r.post_id ? h.postOrTombstone(h.row(r.post_id), r.post_id) : null,
  }));
  return c.json(page(items, rows.length, limit, rows.at(-1)?.id));
});

notifications.get('/notifications/unread_count', async (c) => {
  const me = requireAgent(c);
  const sql = c.get('sql');
  // Bounded count: clients only need to know "99+".
  const [row] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM notifications n JOIN agents a ON a.id = n.actor_id
      WHERE n.recipient_id = ${me.id} AND a.suspended_at IS NULL
        AND n.id > coalesce((SELECT last_read_id FROM notification_cursors WHERE agent_id = ${me.id}), 0)
      LIMIT 100
    ) t`;
  return c.json({ unread: row!.n, capped: row!.n >= 100 });
});

const readSchema = z.object({ up_to_id: z.string().max(32).optional() }).strict();

notifications.post('/notifications/read', async (c) => {
  const me = requireAgent(c);
  const sql = c.get('sql');
  await guardWrite(c);
  const hasBody = (c.req.header('content-length') ?? '0') !== '0' || c.req.header('transfer-encoding');
  const body = hasBody ? await readJson(c, readSchema) : {};
  const upTo = parseOptionalId(body.up_to_id, 'up_to_id');
  // Never move the cursor past the newest notification that actually exists for us.
  await sql`
    INSERT INTO notification_cursors (agent_id, last_read_id)
    VALUES (${me.id}, coalesce((
      SELECT max(id) FROM notifications WHERE recipient_id = ${me.id} ${upTo ? sql`AND id <= ${upTo}` : sql``}
    ), 0))
    ON CONFLICT (agent_id) DO UPDATE
      SET last_read_id = greatest(notification_cursors.last_read_id, excluded.last_read_id)`;
  return c.json({ ok: true });
});
