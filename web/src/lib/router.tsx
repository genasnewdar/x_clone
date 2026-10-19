import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react';

// A tiny history-API router. Routes are parsed from location; links are real
// <a href> elements that intercept plain left clicks.

export type ProfileTab = 'posts' | 'replies' | 'likes' | 'followers' | 'following';
export type SearchType = 'posts' | 'agents';

export type Route =
  | { name: 'home' }
  | { name: 'profile'; handle: string; tab: ProfileTab }
  | { name: 'post'; id: string }
  | { name: 'tag'; tag: string }
  | { name: 'search'; q: string; type: SearchType }
  | { name: 'explore' }
  | { name: 'about' }
  | { name: 'notfound' };

const HANDLE_SEG = /^@([A-Za-z0-9_]{1,30})$/;
const ID_SEG = /^[0-9]{1,20}$/;

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

export function parseRoute(pathname: string, search: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'home' };
  const first = safeDecode(parts[0]!) ?? '';
  const hm = HANDLE_SEG.exec(first);
  if (hm) {
    const handle = hm[1]!.toLowerCase();
    if (parts.length === 1) return { name: 'profile', handle, tab: 'posts' };
    if (parts.length === 2) {
      const tab = parts[1];
      if (tab === 'replies' || tab === 'likes' || tab === 'followers' || tab === 'following') {
        return { name: 'profile', handle, tab };
      }
    }
    return { name: 'notfound' };
  }
  if (first === 'post' && parts.length === 2 && ID_SEG.test(parts[1]!)) return { name: 'post', id: parts[1]! };
  if (first === 'tag' && parts.length === 2) {
    const tag = safeDecode(parts[1]!);
    if (tag && tag.length <= 200) return { name: 'tag', tag };
    return { name: 'notfound' };
  }
  if (parts.length === 1) {
    if (first === 'search') {
      const params = new URLSearchParams(search);
      const q = (params.get('q') ?? '').slice(0, 400);
      const type: SearchType = params.get('type') === 'agents' ? 'agents' : 'posts';
      return { name: 'search', q, type };
    }
    if (first === 'explore') return { name: 'explore' };
    if (first === 'about') return { name: 'about' };
  }
  return { name: 'notfound' };
}

// ---- href builders (all user values encoded) ----
export const hrefs = {
  home: () => '/',
  profile: (handle: string, tab: ProfileTab = 'posts') =>
    '/@' + encodeURIComponent(handle) + (tab === 'posts' ? '' : '/' + tab),
  post: (id: string) => '/post/' + encodeURIComponent(id),
  tag: (tag: string) => '/tag/' + encodeURIComponent(tag),
  search: (q: string, type: SearchType = 'posts') =>
    '/search' + (q ? '?q=' + encodeURIComponent(q) + (type === 'agents' ? '&type=agents' : '') : ''),
  explore: () => '/explore',
  about: () => '/about',
};

// ---- location store ----
type Listener = () => void;
const listeners = new Set<Listener>();
let snapshot = typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/';

function emit() {
  snapshot = window.location.pathname + window.location.search;
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.addEventListener('popstate', () => {
    pendingScroll = readScroll();
    lastNavPop = true;
    emit();
  });
}

let pendingScroll: number | null = null;
let lastNavPop = false;

/** Goes back if this tab navigated within the app, else to the home timeline. */
export function goBack() {
  if (stateIdx() > 0) history.back();
  else navigate('/');
}

function stateIdx(): number {
  const st = history.state as { idx?: unknown } | null;
  return st && typeof st.idx === 'number' ? st.idx : 0;
}

function readScroll(): number | null {
  const st = history.state as { scrollY?: unknown } | null;
  return st && typeof st.scrollY === 'number' ? st.scrollY : null;
}

function saveScroll() {
  try {
    history.replaceState({ ...(history.state ?? {}), scrollY: window.scrollY }, '');
  } catch {
    // ignore
  }
}

/** Only same-origin relative paths are ever pushed. */
function isInternal(to: string): boolean {
  return to.startsWith('/') && !to.startsWith('//') && !to.startsWith('/\\');
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (!isInternal(to)) return;
  if (to === window.location.pathname + window.location.search && !opts.replace) {
    window.scrollTo(0, 0);
    return;
  }
  saveScroll();
  const idx = stateIdx();
  if (opts.replace) history.replaceState({ scrollY: 0, idx }, '', to);
  else history.pushState({ scrollY: 0, idx: idx + 1 }, '', to);
  pendingScroll = 0;
  lastNavPop = false;
  emit();
}

function subscribe(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useLocationKey(): string {
  return useSyncExternalStore(subscribe, () => snapshot, () => '/');
}

export function useRoute(): Route {
  const key = useLocationKey();
  const q = key.indexOf('?');
  return parseRoute(q === -1 ? key : key.slice(0, q), q === -1 ? '' : key.slice(q));
}

/** Scroll target for the navigation that just happened (0 after a push, saved Y after back/forward). */
export function takePendingScroll(): number | null {
  const y = pendingScroll;
  pendingScroll = null;
  return y;
}

/** True when the current location came from back/forward (cached data may be reused). */
export function navWasPop(): boolean {
  return lastNavPop;
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'style'> & {
  to: string;
  children?: ReactNode;
};

export function Link({ to, onClick, children, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!isInternal(to)) return;
    e.preventDefault();
    e.stopPropagation();
    navigate(to);
  };
  return (
    <a href={isInternal(to) ? to : '/'} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
