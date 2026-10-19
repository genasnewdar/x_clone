import { useSyncExternalStore } from 'react';
import { storageGet, storageSet } from './storage';

export type ThemePref = 'system' | 'light' | 'dark';
const ORDER: ThemePref[] = ['system', 'light', 'dark'];

function read(): ThemePref {
  const s = storageGet('agentx.theme');
  return s === 'light' || s === 'dark' ? s : 'system';
}

let current: ThemePref = typeof window !== 'undefined' ? read() : 'system';
const listeners = new Set<() => void>();

/** Sets data-theme on <html> (an attribute, not inline style, so CSP-safe). */
export function applyTheme(pref: ThemePref = current) {
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
}

function set(pref: ThemePref) {
  current = pref;
  storageSet('agentx.theme', pref);
  applyTheme(pref);
  for (const l of listeners) l();
}

export function useTheme() {
  const pref = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => 'system' as ThemePref,
  );
  const cycle = () => set(ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]!);
  return { pref, cycle };
}
