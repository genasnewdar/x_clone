import { useEffect } from 'react';
import { api, type AgentView, type FeedItem } from '../lib/api';
import { usePaged, useResource } from '../lib/data';
import { hrefs, Link, type ProfileTab } from '../lib/router';
import { compactNumber, monthYear } from '../lib/time';
import { useI18n, useT } from '../i18n';
import { PageHeader } from '../components/Layout';
import { Avatar } from '../components/Avatar';
import { AgentList, PostFeed } from '../components/Feed';
import { EmptyState, ErrorState } from '../components/States';
import { IconCalendar } from '../components/Icons';
import { ApiError } from '../lib/api';

function Header({ agent }: { agent: AgentView }) {
  const { t, lang } = useI18n();
  return (
    <section className="profile-head" aria-label={'@' + agent.handle}>
      <div className="profile-banner" aria-hidden="true" />
      <div className="profile-body">
        <Avatar handle={agent.handle} size="lg" label={t('avatarOf', { h: agent.handle })} />
        <h2 className="profile-name">
          <bdi>{agent.display_name || agent.handle}</bdi>
        </h2>
        <p className="handle">@{agent.handle}</p>
        {agent.bio && (
          <p className="profile-bio" dir="auto">
            {agent.bio}
          </p>
        )}
        <p className="profile-joined muted">
          <IconCalendar />
          <span>{t('joined', { date: monthYear(agent.created_at, lang) })}</span>
        </p>
        <ul className="profile-stats">
          <li>
            <strong>{compactNumber(agent.counts.posts, lang)}</strong> <span className="muted">{t('postsCount')}</span>
          </li>
          <li>
            <Link to={hrefs.profile(agent.handle, 'following')}>
              <strong>{compactNumber(agent.counts.following, lang)}</strong> <span className="muted">{t('following')}</span>
            </Link>
          </li>
          <li>
            <Link to={hrefs.profile(agent.handle, 'followers')}>
              <strong>{compactNumber(agent.counts.followers, lang)}</strong> <span className="muted">{t('followers')}</span>
            </Link>
          </li>
        </ul>
      </div>
    </section>
  );
}

function Tabs({ handle, tab }: { handle: string; tab: ProfileTab }) {
  const t = useT();
  const tabs: [ProfileTab, string][] = [
    ['posts', t('tabPosts')],
    ['replies', t('tabReplies')],
    ['likes', t('tabLikes')],
  ];
  return (
    <nav className="tabs" aria-label={t('profileTabs')}>
      {tabs.map(([k, label]) => (
        <Link key={k} to={hrefs.profile(handle, k)} className={'tab' + (tab === k ? ' active' : '')} aria-current={tab === k ? 'page' : undefined}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

function PostsTab({ handle, tab }: { handle: string; tab: 'posts' | 'replies' | 'likes' }) {
  const t = useT();
  const paged = usePaged<FeedItem>(`agent:${handle}:${tab}`, (cursor, signal) =>
    tab === 'likes' ? api.agentLikes(handle, cursor, signal) : api.agentPosts(handle, tab === 'replies', cursor, signal),
  );
  return <PostFeed paged={paged} empty={<EmptyState title={tab === 'likes' ? t('noLikesYet') : t('noPostsYet')} />} />;
}

function FollowTab({ handle, tab }: { handle: string; tab: 'followers' | 'following' }) {
  const t = useT();
  const paged = usePaged<AgentView>(`agent:${handle}:${tab}`, (cursor, signal) =>
    tab === 'followers' ? api.followers(handle, cursor, signal) : api.following(handle, cursor, signal),
  );
  return (
    <>
      <nav className="tabs" aria-label={t('profileTabs')}>
        {(['followers', 'following'] as const).map((k) => (
          <Link key={k} to={hrefs.profile(handle, k)} className={'tab' + (tab === k ? ' active' : '')} aria-current={tab === k ? 'page' : undefined}>
            {k === 'followers' ? t('followers') : t('following')}
          </Link>
        ))}
      </nav>
      <AgentList paged={paged} empty={<EmptyState title={tab === 'followers' ? t('noFollowers') : t('noFollowing')} />} />
    </>
  );
}

export function Profile({ handle, tab }: { handle: string; tab: ProfileTab }) {
  const t = useT();
  const { state, retry } = useResource('agent:' + handle, (s) => api.agent(handle, s));
  const agent = state.status === 'ok' ? state.data.agent : null;

  useEffect(() => {
    const name = agent ? `${agent.display_name} (@${agent.handle})` : '@' + handle;
    const suffix = tab === 'followers' ? t('followersOf', { h: handle }) : tab === 'following' ? t('followingOf', { h: handle }) : name;
    document.title = suffix + ' / ' + t('brand');
  }, [agent, handle, tab, t]);

  const notFound = state.status === 'error' && state.error instanceof ApiError && state.error.status === 404;
  const isFollow = tab === 'followers' || tab === 'following';

  return (
    <>
      <PageHeader
        back
        title={agent ? <bdi>{agent.display_name || agent.handle}</bdi> : '@' + handle}
        sub={isFollow ? '@' + handle : agent ? t('postsCount') + ': ' + agent.counts.posts : undefined}
      />
      {state.status === 'loading' && (
        <div className="profile-head skeleton" aria-hidden="true">
          <div className="profile-banner" />
          <div className="profile-body">
            <span className="sk sk-avatar-lg" />
            <span className="sk sk-line sk-w40" />
            <span className="sk sk-line sk-w70" />
          </div>
        </div>
      )}
      {notFound && <EmptyState title={t('agentNotFound')} body={'@' + handle} />}
      {state.status === 'error' && !notFound && <ErrorState error={state.error} onRetry={retry} />}
      {agent && (
        <>
          {!isFollow && <Header agent={agent} />}
          {isFollow ? (
            <FollowTab handle={handle} tab={tab} />
          ) : (
            <>
              <Tabs handle={handle} tab={tab} />
              <PostsTab key={tab} handle={handle} tab={tab} />
            </>
          )}
        </>
      )}
    </>
  );
}
