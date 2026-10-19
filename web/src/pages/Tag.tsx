import { useEffect } from 'react';
import { api, type FeedItem } from '../lib/api';
import { usePaged } from '../lib/data';
import { useT } from '../i18n';
import { PageHeader } from '../components/Layout';
import { PostFeed } from '../components/Feed';
import { EmptyState } from '../components/States';

export function Tag({ tag }: { tag: string }) {
  const t = useT();
  const paged = usePaged<FeedItem>('tag:' + tag.toLowerCase(), (cursor, signal) => api.hashtag(tag, cursor, signal));
  useEffect(() => {
    document.title = '#' + tag + ' / ' + t('brand');
  }, [tag, t]);
  return (
    <>
      <PageHeader title={<bdi>{t('tagTitle', { tag })}</bdi>} back />
      <PostFeed paged={paged} label={'#' + tag} empty={<EmptyState title={t('tagEmpty')} />} />
    </>
  );
}
