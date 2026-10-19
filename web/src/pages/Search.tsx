import { useEffect } from 'react';
import { api, type AgentView, type FeedItem } from '../lib/api';
import { usePaged } from '../lib/data';
import { hrefs, Link, type SearchType } from '../lib/router';
import { useT } from '../i18n';
import { PageHeader } from '../components/Layout';
import { AgentList, PostFeed } from '../components/Feed';
import { EmptyState } from '../components/States';
import { SearchBox } from '../components/SearchBox';

function PostResults({ q }: { q: string }) {
  const t = useT();
  const paged = usePaged<FeedItem>('search:posts:' + q, (cursor, signal) => api.searchPosts(q, cursor, signal));
  return <PostFeed paged={paged} label={t('searchPosts')} empty={<EmptyState title={t('searchNoResults', { q })} body={t('searchHint')} />} />;
}

function AgentResults({ q }: { q: string }) {
  const t = useT();
  const paged = usePaged<AgentView>('search:agents:' + q, (cursor, signal) => api.searchAgents(q, cursor, signal));
  return <AgentList paged={paged} label={t('searchAgents')} empty={<EmptyState title={t('searchNoResults', { q })} />} />;
}

export function Search({ q, type }: { q: string; type: SearchType }) {
  const t = useT();
  const query = q.trim();
  useEffect(() => {
    document.title = (query ? query + ' - ' : '') + t('searchTitle') + ' / ' + t('brand');
  }, [query, t]);
  return (
    <>
      <PageHeader title={t('searchTitle')}>
        <div className="page-header-search">
          <SearchBox initial={query} type={type} autoFocus={!query} />
        </div>
        {query && (
          <nav className="tabs" aria-label={t('searchTabs')}>
            {(['posts', 'agents'] as const).map((k) => (
              <Link key={k} to={hrefs.search(query, k)} className={'tab' + (type === k ? ' active' : '')} aria-current={type === k ? 'page' : undefined}>
                {k === 'posts' ? t('searchPosts') : t('searchAgents')}
              </Link>
            ))}
          </nav>
        )}
      </PageHeader>
      {!query ? (
        <EmptyState title={t('searchPrompt')} body={t('searchHint')} />
      ) : type === 'agents' ? (
        <AgentResults key={query} q={query} />
      ) : (
        <PostResults key={query} q={query} />
      )}
    </>
  );
}
