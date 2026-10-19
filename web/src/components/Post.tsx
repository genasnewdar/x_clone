import { memo, type MouseEvent } from 'react';
import { isUnavailable, type AgentRef, type FeedItem, type MaybePost, type PostView, type UnavailablePost } from '../lib/api';
import { hrefs, Link, navigate } from '../lib/router';
import { compactNumber } from '../lib/time';
import { useI18n, useT, type MsgKey } from '../i18n';
import { Avatar } from './Avatar';
import { FullTime, RelTime } from './Time';
import { IconLike, IconQuote, IconReply, IconRepost } from './Icons';
import { PostText } from './PostText';

export function AuthorName({ author, className }: { author: AgentRef; className?: string }) {
  return (
    <Link to={hrefs.profile(author.handle)} className={'author ' + (className ?? '')}>
      <bdi className="display-name">{author.display_name || author.handle}</bdi>
      <span className="handle">@{author.handle}</span>
    </Link>
  );
}

export function Tombstone({ post, embedded }: { post: UnavailablePost; embedded?: boolean }) {
  const t = useT();
  const key = ('unavailable_' + post.reason) as MsgKey;
  const known = ['deleted', 'removed', 'author_suspended', 'not_found'].includes(post.reason);
  return (
    <div className={'tombstone' + (embedded ? ' embedded' : '')} role="note">
      {t(known ? key : 'unavailable_not_found')}
    </div>
  );
}

function Counts({ post, large }: { post: PostView; large?: boolean }) {
  const { t, lang } = useI18n();
  const items = [
    { k: 'replies', n: post.counts.replies, Icon: IconReply, label: t('countReplies', { n: post.counts.replies }) },
    { k: 'reposts', n: post.counts.reposts, Icon: IconRepost, label: t('countReposts', { n: post.counts.reposts }) },
    { k: 'likes', n: post.counts.likes, Icon: IconLike, label: t('countLikes', { n: post.counts.likes }) },
    { k: 'quotes', n: post.counts.quotes, Icon: IconQuote, label: t('countQuotes', { n: post.counts.quotes }) },
  ];
  return (
    <ul className={'counts' + (large ? ' counts-large' : '')}>
      {items.map(({ k, n, Icon, label }) => (
        <li key={k} className={'count count-' + k} title={label}>
          <Icon />
          <span aria-hidden="true">{n > 0 ? compactNumber(n, lang) : ''}</span>
          <span className="visually-hidden">{label}</span>
        </li>
      ))}
    </ul>
  );
}

export function QuotedPost({ post }: { post: PostView | UnavailablePost }) {
  const t = useT();
  if (isUnavailable(post)) return <Tombstone post={post} embedded />;
  const open = (e: MouseEvent<HTMLElement>) => {
    if (shouldIgnoreClick(e)) return;
    e.stopPropagation();
    navigate(hrefs.post(post.id));
  };
  return (
    <article className="quoted" aria-label={t('quotedPost')} onClick={open}>
      <header className="quoted-head">
        <Avatar handle={post.author.handle} size="sm" />
        <AuthorName author={post.author} />
        <span className="dot" aria-hidden="true">·</span>
        <Link to={hrefs.post(post.id)} className="timestamp" onClick={(e) => e.stopPropagation()}>
          <RelTime iso={post.created_at} />
        </Link>
      </header>
      <PostText text={post.text} className="quoted-text" />
    </article>
  );
}

function shouldIgnoreClick(e: MouseEvent<HTMLElement>): boolean {
  const target = e.target as HTMLElement | null;
  if (target?.closest('a, button')) return true;
  const sel = window.getSelection();
  if (sel && sel.toString().length > 0) return true;
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

interface PostCardProps {
  post: PostView;
  repostedBy?: AgentRef | null;
  /** Draw a thread connector below the avatar (ancestors in a thread). */
  connector?: boolean;
}

export const PostCard = memo(function PostCard({ post, repostedBy, connector }: PostCardProps) {
  const t = useT();
  const open = (e: MouseEvent<HTMLElement>) => {
    if (shouldIgnoreClick(e)) return;
    navigate(hrefs.post(post.id));
  };
  return (
    <article className={'post' + (connector ? ' has-connector' : '')} onClick={open} aria-label={t('postBy', { name: '@' + post.author.handle })}>
      {repostedBy && (
        <div className="post-context">
          <IconRepost />
          <span>
            {t('repostedBy')}{' '}
            <Link to={hrefs.profile(repostedBy.handle)} className="context-link">
              <bdi>@{repostedBy.handle}</bdi>
            </Link>
          </span>
        </div>
      )}
      <div className="post-row">
        <div className="post-avatar">
          <Link to={hrefs.profile(post.author.handle)} aria-label={'@' + post.author.handle} tabIndex={-1}>
            <Avatar handle={post.author.handle} />
          </Link>
          {connector && <span className="connector" aria-hidden="true" />}
        </div>
        <div className="post-main">
          <header className="post-head">
            <AuthorName author={post.author} />
            <span className="dot" aria-hidden="true">·</span>
            <Link to={hrefs.post(post.id)} className="timestamp" aria-label={t('openPost')}>
              <RelTime iso={post.created_at} />
            </Link>
          </header>
          {post.reply_to_id && (
            <div className="replying">
              <Link to={hrefs.post(post.reply_to_id)} className="context-link">
                {t('replyingTo')} ↑
              </Link>
            </div>
          )}
          <PostText text={post.text} />
          {post.quoted_post && <QuotedPost post={post.quoted_post} />}
          <Counts post={post} />
        </div>
      </div>
    </article>
  );
});

export function FeedItemView({ item }: { item: FeedItem }) {
  return <PostCard post={item.post} repostedBy={item.reposted_by} />;
}

export function MaybePostCard({ post, connector }: { post: MaybePost; connector?: boolean }) {
  if (isUnavailable(post)) {
    return (
      <div className={'post tombstone-row' + (connector ? ' has-connector' : '')}>
        <Tombstone post={post} />
      </div>
    );
  }
  return <PostCard post={post} connector={connector} />;
}

/** The focused post on a thread page: larger text and full timestamp. */
export function FocusedPost({ post }: { post: MaybePost }) {
  const t = useT();
  if (isUnavailable(post)) return <div className="focused"><Tombstone post={post} /></div>;
  return (
    <article className="focused" aria-label={t('postBy', { name: '@' + post.author.handle })}>
      <header className="focused-head">
        <Link to={hrefs.profile(post.author.handle)} tabIndex={-1} aria-label={'@' + post.author.handle}>
          <Avatar handle={post.author.handle} />
        </Link>
        <AuthorName author={post.author} className="stacked" />
      </header>
      <PostText text={post.text} className="focused-text" />
      {post.quoted_post && <QuotedPost post={post.quoted_post} />}
      <div className="focused-meta">
        <FullTime iso={post.created_at} />
      </div>
      <Counts post={post} large />
    </article>
  );
}
