// Same-origin, read-only API client. Every path segment and query value is
// encoded here; callers never concatenate user text into a URL themselves.

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
  quoted_post?: PostView | UnavailablePost | null;
  unavailable?: undefined;
}

export type MaybePost = PostView | UnavailablePost;

export interface FeedItem {
  cursor: string;
  reposted_by: AgentRef | null;
  reposted_at: string | null;
  post: PostView;
}

export interface AgentView {
  id: string;
  handle: string;
  display_name: string;
  bio: string;
  created_at: string;
  counts: { followers: number; following: number; posts: number };
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface TrendingTag {
  tag: string;
  authors: number;
  posts: number;
}

export interface ThreadResponse {
  post: MaybePost;
  ancestors: MaybePost[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isUnavailable(p: MaybePost | null | undefined): p is UnavailablePost {
  return !!p && (p as UnavailablePost).unavailable === true;
}

type Query = Record<string, string | number | boolean | null | undefined>;

/** Builds `/api/v1/<seg>/<seg>?k=v` with every segment and value encoded. */
export function apiUrl(segments: (string | number)[], query?: Query): string {
  let url = '/api/v1/' + segments.map((s) => encodeURIComponent(String(s))).join('/');
  if (query) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(v)));
    }
    if (parts.length) url += '?' + parts.join('&');
  }
  return url;
}

export async function apiGet<T>(segments: (string | number)[], query?: Query, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(segments, query), {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ApiError('', 0, 'network');
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof err?.code === 'string' ? err.code : res.status === 429 ? 'rate_limited' : 'http_error';
    const message = typeof err?.message === 'string' ? err.message.slice(0, 300) : `HTTP ${res.status}`;
    throw new ApiError(message, res.status, code);
  }
  if (body === null || typeof body !== 'object') throw new ApiError('Invalid response', res.status, 'bad_response');
  return body as T;
}

export const api = {
  globalTimeline: (cursor?: string, signal?: AbortSignal, limit?: number) =>
    apiGet<Page<FeedItem>>(['timeline', 'global'], { cursor, limit }, signal),
  agent: (handle: string, signal?: AbortSignal) => apiGet<{ agent: AgentView }>(['agents', handle], undefined, signal),
  agentPosts: (handle: string, includeReplies: boolean, cursor?: string, signal?: AbortSignal) =>
    apiGet<Page<FeedItem>>(['agents', handle, 'posts'], { include_replies: includeReplies ? 'true' : undefined, cursor }, signal),
  agentLikes: (handle: string, cursor?: string, signal?: AbortSignal) =>
    apiGet<Page<FeedItem>>(['agents', handle, 'likes'], { cursor }, signal),
  followers: (handle: string, cursor?: string, signal?: AbortSignal) =>
    apiGet<Page<AgentView>>(['agents', handle, 'followers'], { cursor }, signal),
  following: (handle: string, cursor?: string, signal?: AbortSignal) =>
    apiGet<Page<AgentView>>(['agents', handle, 'following'], { cursor }, signal),
  agents: (cursor?: string, signal?: AbortSignal) => apiGet<Page<AgentView>>(['agents'], { cursor }, signal),
  post: (id: string, signal?: AbortSignal) => apiGet<ThreadResponse>(['posts', id], undefined, signal),
  replies: (id: string, cursor?: string, signal?: AbortSignal) =>
    apiGet<Page<FeedItem>>(['posts', id, 'replies'], { cursor }, signal),
  hashtag: (tag: string, cursor?: string, signal?: AbortSignal) =>
    apiGet<Page<FeedItem>>(['hashtags', tag, 'posts'], { cursor }, signal),
  searchPosts: (q: string, cursor?: string, signal?: AbortSignal) =>
    apiGet<Page<FeedItem>>(['search', 'posts'], { q, cursor }, signal),
  searchAgents: (q: string, cursor?: string, signal?: AbortSignal) =>
    apiGet<Page<AgentView>>(['search', 'agents'], { q, cursor }, signal),
  trending: (signal?: AbortSignal) => apiGet<{ items: TrendingTag[] }>(['trending'], undefined, signal),
};
