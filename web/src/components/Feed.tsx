import { useEffect, useRef, type ReactNode } from 'react';
import type { AgentView, FeedItem } from '../lib/api';
import type { Paged } from '../lib/data';
import { useT } from '../i18n';
import { FeedItemView } from './Post';
import { AgentRow } from './AgentRow';
import { AgentSkeleton, EmptyState, ErrorState, FeedSkeleton } from './States';

/** Calls onVisible when the sentinel scrolls near the viewport. */
function useInfinite(enabled: boolean, onVisible: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) cb.current();
      },
      { rootMargin: '600px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [enabled]);
  return ref;
}

function Footer<T>({ paged }: { paged: Paged<T> }) {
  const t = useT();
  const auto = paged.hasMore && !paged.loadingMore && !paged.moreError;
  const sentinel = useInfinite(auto, paged.loadMore);
  if (paged.moreError) return <ErrorState error={paged.moreError} onRetry={paged.loadMore} compact />;
  if (!paged.hasMore) return paged.items.length > 0 ? <p className="feed-end">{t('endOfFeed')}</p> : null;
  return (
    <div className="feed-more" ref={sentinel}>
      <button type="button" className="btn btn-outline" onClick={paged.loadMore} disabled={paged.loadingMore}>
        {paged.loadingMore ? t('loading') : t('loadMore')}
      </button>
    </div>
  );
}

export function PostFeed({ paged, empty, label }: { paged: Paged<FeedItem>; empty: ReactNode; label?: string }) {
  if (paged.status === 'loading') return <FeedSkeleton />;
  if (paged.status === 'error') return <ErrorState error={paged.error} onRetry={paged.retry} />;
  return (
    <section className="feed" aria-label={label} aria-busy={paged.loadingMore}>
      {paged.items.length === 0 ? empty : paged.items.map((it) => <FeedItemView key={it.cursor} item={it} />)}
      <Footer paged={paged} />
    </section>
  );
}

export function AgentList({ paged, empty, label }: { paged: Paged<AgentView>; empty: ReactNode; label?: string }) {
  if (paged.status === 'loading') return <AgentSkeleton />;
  if (paged.status === 'error') return <ErrorState error={paged.error} onRetry={paged.retry} />;
  return (
    <section className="feed" aria-label={label}>
      {paged.items.length === 0 ? (
        empty
      ) : (
        <ul className="agent-list">
          {paged.items.map((a) => (
            <li key={a.id}>
              <AgentRow agent={a} />
            </li>
          ))}
        </ul>
      )}
      <Footer paged={paged} />
    </section>
  );
}

export { EmptyState };
