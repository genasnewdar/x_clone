import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from './api';
import { navWasPop } from './router';

// Small in-memory cache so back/forward navigation renders instantly (and the
// router can restore the scroll position). Bounded LRU.

interface Entry {
  at: number;
  value: unknown;
}

const MAX_ENTRIES = 40;
const FRESH_MS = 30_000;
const cache = new Map<string, Entry>();

function cacheGet<T>(key: string): T | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  if (!navWasPop() && Date.now() - e.at > FRESH_MS) return undefined;
  cache.delete(key);
  cache.set(key, e);
  return e.value as T;
}

function cacheSet(key: string, value: unknown) {
  cache.delete(key);
  cache.set(key, { at: Date.now(), value });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ok'; data: T };

/** Fetches one resource, keyed by `key`. */
export function useResource<T>(key: string, fetcher: (signal: AbortSignal) => Promise<T>) {
  const initial = (): LoadState<T> => {
    const c = cacheGet<T>(key);
    return c !== undefined ? { status: 'ok', data: c } : { status: 'loading' };
  };
  const [state, setState] = useState<{ key: string; s: LoadState<T> }>(() => ({ key, s: initial() }));
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  let current = state;
  if (state.key !== key) {
    current = { key, s: initial() };
    setState(current);
  }

  useEffect(() => {
    if (nonce === 0 && cacheGet<T>(key) !== undefined) return;
    const ctl = new AbortController();
    setState((prev) => (prev.key === key && prev.s.status === 'ok' && nonce === 0 ? prev : { key, s: { status: 'loading' } }));
    fetcherRef
      .current(ctl.signal)
      .then((data) => {
        cacheSet(key, data);
        setState({ key, s: { status: 'ok', data } });
      })
      .catch((error: unknown) => {
        if ((error as Error)?.name === 'AbortError') return;
        setState({ key, s: { status: 'error', error } });
      });
    return () => ctl.abort();
  }, [key, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { state: current.s, retry };
}

interface PagedData<T> {
  items: T[];
  cursor: string | null;
}

export interface Paged<T> {
  items: T[];
  status: 'loading' | 'ok' | 'error';
  error: unknown;
  hasMore: boolean;
  loadingMore: boolean;
  moreError: unknown;
  loadMore: () => void;
  retry: () => void;
  /** Replaces the list with a fresh first page. */
  reset: (page: Page<T>) => void;
}

/** Cursor-paginated list keyed by `key`. */
export function usePaged<T>(key: string, fetchPage: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T>>): Paged<T> {
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const initial = () => cacheGet<PagedData<T>>(key) ?? null;
  const [data, setData] = useState<{ key: string; d: PagedData<T> | null }>(() => ({ key, d: initial() }));
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>(() => (data.d ? 'ok' : 'loading'));
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const moreCtl = useRef<AbortController | null>(null);

  let cur = data;
  if (data.key !== key) {
    cur = { key, d: initial() };
    setData(cur);
    setStatus(cur.d ? 'ok' : 'loading');
    setError(null);
    setMoreError(null);
    setLoadingMore(false);
  }

  useEffect(() => {
    moreCtl.current?.abort();
    if (nonce === 0 && cacheGet<PagedData<T>>(key)) return;
    const ctl = new AbortController();
    setStatus('loading');
    setError(null);
    fetchRef
      .current(undefined, ctl.signal)
      .then((p) => {
        const d = { items: p.items, cursor: p.next_cursor };
        cacheSet(key, d);
        setData({ key, d });
        setStatus('ok');
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name === 'AbortError') return;
        setError(e);
        setStatus('error');
      });
    return () => ctl.abort();
  }, [key, nonce]);

  useEffect(() => () => moreCtl.current?.abort(), []);

  const loadMore = useCallback(() => {
    const d = cur.d;
    if (!d || !d.cursor || moreCtl.current) return;
    const ctl = new AbortController();
    moreCtl.current = ctl;
    setLoadingMore(true);
    setMoreError(null);
    fetchRef
      .current(d.cursor, ctl.signal)
      .then((p) => {
        setData((prev) => {
          if (prev.key !== key || !prev.d) return prev;
          const next = { items: [...prev.d.items, ...p.items], cursor: p.next_cursor };
          cacheSet(key, next);
          return { key, d: next };
        });
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name !== 'AbortError') setMoreError(e);
      })
      .finally(() => {
        if (moreCtl.current === ctl) moreCtl.current = null;
        setLoadingMore(false);
      });
  }, [cur.d, key]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  const reset = useCallback(
    (p: Page<T>) => {
      const d = { items: p.items, cursor: p.next_cursor };
      cacheSet(key, d);
      setData({ key, d });
      setStatus('ok');
    },
    [key],
  );

  return {
    items: cur.d?.items ?? [],
    status: cur.d && status !== 'error' ? 'ok' : status,
    error,
    hasMore: !!cur.d?.cursor,
    loadingMore,
    moreError,
    loadMore,
    retry,
    reset,
  };
}
