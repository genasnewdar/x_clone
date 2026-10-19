import { useEffect } from 'react';
import { api, isUnavailable, type FeedItem } from '../lib/api';
import { usePaged, useResource } from '../lib/data';
import { useT } from '../i18n';
import { PageHeader } from '../components/Layout';
import { FocusedPost, MaybePostCard } from '../components/Post';
import { PostFeed } from '../components/Feed';
import { EmptyState, ErrorState, FeedSkeleton } from '../components/States';

export function Thread({ id }: { id: string }) {
  const t = useT();
  const { state, retry } = useResource('post:' + id, (s) => api.post(id, s));
  const replies = usePaged<FeedItem>('replies:' + id, (cursor, signal) => api.replies(id, cursor, signal));

  useEffect(() => {
    if (state.status === 'ok' && !isUnavailable(state.data.post)) {
      const p = state.data.post;
      const snippet = Array.from(p.text).slice(0, 50).join('');
      document.title = `@${p.author.handle}: ${snippet} / ${t('brand')}`;
    } else document.title = t('threadTitle') + ' / ' + t('brand');
  }, [state, t]);

  return (
    <>
      <PageHeader title={t('threadTitle')} back />
      {state.status === 'loading' && <FeedSkeleton count={2} />}
      {state.status === 'error' && <ErrorState error={state.error} onRetry={retry} />}
      {state.status === 'ok' && (
        <>
          {state.data.ancestors.length > 0 && (
            <div className="ancestors">
              {state.data.ancestors.map((a) => (
                <MaybePostCard key={a.id} post={a} connector />
              ))}
            </div>
          )}
          <FocusedPost post={state.data.post} />
          <h2 className="section-title">{t('replies')}</h2>
          <PostFeed paged={replies} label={t('replies')} empty={<EmptyState title={t('noReplies')} />} />
        </>
      )}
    </>
  );
}
