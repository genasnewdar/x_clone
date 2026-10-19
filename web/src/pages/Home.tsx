import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type FeedItem } from '../lib/api';
import { usePaged } from '../lib/data';
import { useT } from '../i18n';
import { PageHeader } from '../components/Layout';
import { PostFeed } from '../components/Feed';
import { EmptyState } from '../components/States';

const POLL_MS = 15_000;

function newer(a: string, b: string): boolean {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return false;
  }
}

export function Home() {
  const t = useT();
  const paged = usePaged<FeedItem>('global', (cursor, signal) => api.globalTimeline(cursor, signal));
  const [fresh, setFresh] = useState<{ count: number; capped: boolean }>({ count: 0, capped: false });
  const top = paged.items[0]?.cursor ?? null;
  const topRef = useRef(top);
  topRef.current = top;

  // Poll for new posts only while the tab is visible.
  useEffect(() => {
    if (paged.status !== 'ok') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ctl: AbortController | null = null;
    const tick = async () => {
      timer = null;
      if (document.visibilityState === 'visible') {
        ctl = new AbortController();
        try {
          const p = await api.globalTimeline(undefined, ctl.signal, 50);
          const cur = topRef.current;
          const n = cur ? p.items.filter((i) => newer(i.cursor, cur)).length : p.items.length;
          setFresh({ count: n, capped: n >= 50 });
        } catch {
          // Polling errors are silent; the next tick retries.
        }
      }
      schedule();
    };
    const schedule = () => {
      if (timer === null && document.visibilityState === 'visible') timer = setTimeout(tick, POLL_MS);
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') schedule();
      else if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    document.addEventListener('visibilitychange', onVis);
    schedule();
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      if (timer !== null) clearTimeout(timer);
      ctl?.abort();
    };
  }, [paged.status]);

  const [refreshing, setRefreshing] = useState(false);
  const showNew = useCallback(async () => {
    setRefreshing(true);
    try {
      const p = await api.globalTimeline();
      paged.reset(p);
      setFresh({ count: 0, capped: false });
      window.scrollTo({ top: 0 });
      document.getElementById('main')?.focus({ preventScroll: true });
    } catch {
      paged.retry();
    } finally {
      setRefreshing(false);
    }
  }, [paged]);

  useEffect(() => {
    document.title = t('globalTimeline') + ' / ' + t('brand');
  }, [t]);

  return (
    <>
      <PageHeader title={t('homeTitle')} sub={t('globalTimeline')} />
      {fresh.count > 0 && (
        <div className="pill-wrap">
          <button type="button" className="new-pill" onClick={showNew} disabled={refreshing} aria-live="polite">
            ↑ {fresh.count === 1 ? t('newPost') : t('newPosts', { n: fresh.capped ? '50+' : fresh.count })}
          </button>
        </div>
      )}
      <PostFeed paged={paged} label={t('globalTimeline')} empty={<EmptyState title={t('emptyFeed')} body={t('emptyFeedHint')} />} />
    </>
  );
}
