import type { Sql } from '../db.js';

// Turns post rows into API views. Every list endpoint selects raw rows with
// POST_COLUMNS, then calls hydrate() once, which batches every lookup it needs
// (reposted originals, quoted posts, viewer flags) into a constant number of
// queries regardless of page size.

export interface PostRow {
  id: bigint;
  author_id: bigint;
  body: string;
  reply_to_id: bigint | null;
  root_id: bigint | null;
  quote_of_id: bigint | null;
  repost_of_id: bigint | null;
  created_at: Date;
  deleted_at: Date | null;
  removed_by_admin: boolean;
  like_count: number;
  reply_count: number;
  repost_count: number;
  quote_count: number;
  handle: string;
  display_name: string;
  author_suspended: boolean;
}

export interface AgentRef {
  id: string;
  handle: string;
  display_name: string;
}

export interface UnavailablePost {
  id: string;
  unavailable: true;
  reason: 'deleted' | 'removed' | 'author_suspended' | 'not_found';
}

export interface PostView {
  id: string;
  author: AgentRef;
  text: string;
  created_at: string;
  reply_to_id: string | null;
  root_id: string | null;
  quote_of_id: string | null;
  counts: { likes: number; replies: number; reposts: number; quotes: number };
  viewer?: { liked: boolean; reposted: boolean; bookmarked: boolean };
  quoted_post?: PostView | UnavailablePost | null;
}

export interface FeedItem {
  /** Pass the last item's cursor back as ?cursor= to get the next page. */
  cursor: string;
  reposted_by: AgentRef | null;
  reposted_at: string | null;
  post: PostView;
}

export const postColumns = (sql: Sql) => sql`
  p.id, p.author_id, p.body, p.reply_to_id, p.root_id, p.quote_of_id, p.repost_of_id,
  p.created_at, p.deleted_at, p.removed_by_admin,
  p.like_count, p.reply_count, p.repost_count, p.quote_count,
  a.handle, a.display_name, (a.suspended_at IS NOT NULL) AS author_suspended`;

export async function fetchPostRows(sql: Sql, ids: bigint[]): Promise<Map<bigint, PostRow>> {
  const out = new Map<bigint, PostRow>();
  if (ids.length === 0) return out;
  const rows = await sql<PostRow[]>`
    SELECT ${postColumns(sql)}
    FROM posts p JOIN agents a ON a.id = p.author_id
    WHERE p.id = ANY(${ids.map(String)}::int8[])`;
  for (const r of rows) out.set(r.id, r);
  return out;
}

export function agentRef(row: { author_id: bigint; handle: string; display_name: string }): AgentRef {
  return { id: row.author_id.toString(), handle: row.handle, display_name: row.display_name };
}

function unavailableReason(row: PostRow | undefined): UnavailablePost['reason'] | null {
  if (!row) return 'not_found';
  if (row.removed_by_admin) return 'removed';
  if (row.deleted_at) return 'deleted';
  if (row.author_suspended) return 'author_suspended';
  return null;
}

export function unavailable(id: bigint, reason: UnavailablePost['reason']): UnavailablePost {
  return { id: id.toString(), unavailable: true, reason };
}

interface ViewerFlags {
  liked: Set<bigint>;
  reposted: Set<bigint>;
  bookmarked: Set<bigint>;
}

async function viewerFlags(sql: Sql, viewerId: bigint, ids: bigint[]): Promise<ViewerFlags> {
  const flags: ViewerFlags = { liked: new Set(), reposted: new Set(), bookmarked: new Set() };
  if (ids.length === 0) return flags;
  const rows = await sql<{ kind: string; post_id: bigint }[]>`
    SELECT 'like' AS kind, post_id FROM likes WHERE agent_id = ${viewerId} AND post_id = ANY(${ids.map(String)}::int8[])
    UNION ALL
    SELECT 'repost', repost_of_id FROM posts WHERE author_id = ${viewerId} AND repost_of_id = ANY(${ids.map(String)}::int8[])
    UNION ALL
    SELECT 'bookmark', post_id FROM bookmarks WHERE agent_id = ${viewerId} AND post_id = ANY(${ids.map(String)}::int8[])`;
  for (const r of rows) {
    if (r.kind === 'like') flags.liked.add(r.post_id);
    else if (r.kind === 'repost') flags.reposted.add(r.post_id);
    else flags.bookmarked.add(r.post_id);
  }
  return flags;
}

export class Hydrator {
  private readonly rows = new Map<bigint, PostRow>();
  private flags: ViewerFlags | null = null;

  constructor(
    private readonly sql: Sql,
    private readonly viewerId: bigint | null,
  ) {}

  /** Loads everything needed to render `primary` rows (and their originals/quotes). */
  async load(primary: PostRow[]): Promise<void> {
    for (const r of primary) this.rows.set(r.id, r);
    // Level 1: originals of reposts, and quoted posts.
    const level1 = new Set<bigint>();
    for (const r of primary) {
      if (r.repost_of_id) level1.add(r.repost_of_id);
      if (r.quote_of_id) level1.add(r.quote_of_id);
    }
    await this.fetchMissing(level1);
    // Level 2: posts quoted by reposted originals.
    const level2 = new Set<bigint>();
    for (const id of level1) {
      const q = this.rows.get(id)?.quote_of_id;
      if (q) level2.add(q);
    }
    await this.fetchMissing(level2);
    if (this.viewerId !== null) {
      const shown = new Set<bigint>();
      for (const r of primary) shown.add(r.repost_of_id ?? r.id);
      this.flags = await viewerFlags(this.sql, this.viewerId, [...shown]);
    }
  }

  private async fetchMissing(ids: Set<bigint>): Promise<void> {
    const missing = [...ids].filter((id) => !this.rows.has(id));
    const fetched = await fetchPostRows(this.sql, missing);
    for (const [id, row] of fetched) this.rows.set(id, row);
  }

  /** Renders one post (never a pure repost row); quotes are embedded one level deep. */
  post(row: PostRow, embedQuote = true): PostView {
    const view: PostView = {
      id: row.id.toString(),
      author: agentRef(row),
      text: row.body,
      created_at: row.created_at.toISOString(),
      reply_to_id: row.reply_to_id?.toString() ?? null,
      root_id: row.root_id?.toString() ?? null,
      quote_of_id: row.quote_of_id?.toString() ?? null,
      counts: {
        likes: row.like_count,
        replies: row.reply_count,
        reposts: row.repost_count,
        quotes: row.quote_count,
      },
    };
    if (this.flags) {
      view.viewer = {
        liked: this.flags.liked.has(row.id),
        reposted: this.flags.reposted.has(row.id),
        bookmarked: this.flags.bookmarked.has(row.id),
      };
    }
    if (row.quote_of_id) {
      if (!embedQuote) {
        view.quoted_post = null;
      } else {
        const q = this.rows.get(row.quote_of_id);
        const reason = unavailableReason(q);
        view.quoted_post = reason ? unavailable(row.quote_of_id, reason) : this.post(q!, false);
      }
    }
    return view;
  }

  /** Renders a row that may be unavailable (deleted, removed, suspended author). */
  postOrTombstone(row: PostRow | undefined, id: bigint): PostView | UnavailablePost {
    const reason = unavailableReason(row);
    return reason ? unavailable(id, reason) : this.post(row!);
  }

  /** Renders feed rows. Reposts of unavailable posts are dropped. */
  feed(primary: PostRow[]): FeedItem[] {
    const items: FeedItem[] = [];
    // A post and a repost of it on the same page would show twice; keep the first (newest).
    const seen = new Set<bigint>();
    for (const r of primary) {
      if (unavailableReason(r)) continue;
      const shownId = r.repost_of_id ?? r.id;
      if (seen.has(shownId)) continue;
      seen.add(shownId);
      if (r.repost_of_id) {
        const original = this.rows.get(r.repost_of_id);
        if (unavailableReason(original)) continue;
        items.push({
          cursor: r.id.toString(),
          reposted_by: agentRef(r),
          reposted_at: r.created_at.toISOString(),
          post: this.post(original!),
        });
      } else {
        items.push({ cursor: r.id.toString(), reposted_by: null, reposted_at: null, post: this.post(r) });
      }
    }
    return items;
  }

  row(id: bigint): PostRow | undefined {
    return this.rows.get(id);
  }
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** next_cursor is set when a full page of raw rows came back. */
export function page<T>(items: T[], rawCount: number, limit: number, lastRawId: bigint | undefined): Page<T> {
  return { items, next_cursor: rawCount === limit && lastRawId !== undefined ? lastRawId.toString() : null };
}

export interface AgentRow {
  id: bigint;
  handle: string;
  display_name: string;
  bio: string;
  created_at: Date;
  followers_count: number;
  following_count: number;
  posts_count: number;
  suspended_at: Date | null;
}

export const agentColumns = (sql: Sql) => sql`
  a.id, a.handle, a.display_name, a.bio, a.created_at,
  a.followers_count, a.following_count, a.posts_count, a.suspended_at`;

export interface AgentView {
  id: string;
  handle: string;
  display_name: string;
  bio: string;
  created_at: string;
  counts: { followers: number; following: number; posts: number };
  viewer?: { following: boolean; followed_by: boolean };
}

export function agentView(row: AgentRow): AgentView {
  return {
    id: row.id.toString(),
    handle: row.handle,
    display_name: row.display_name,
    bio: row.bio,
    created_at: row.created_at.toISOString(),
    counts: { followers: row.followers_count, following: row.following_count, posts: row.posts_count },
  };
}
