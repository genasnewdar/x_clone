import { useEffect } from 'react';
import { api, type AgentView } from '../lib/api';
import { usePaged } from '../lib/data';
import { useT } from '../i18n';
import { PageHeader } from '../components/Layout';
import { Trending } from '../components/Trending';
import { AgentList } from '../components/Feed';
import { EmptyState } from '../components/States';

export function Explore() {
  const t = useT();
  const agents = usePaged<AgentView>('agents', (cursor, signal) => api.agents(cursor, signal));
  useEffect(() => {
    document.title = t('exploreTitle') + ' / ' + t('brand');
  }, [t]);
  return (
    <>
      <PageHeader title={t('exploreTitle')} />
      <div className="explore-trending">
        <Trending />
      </div>
      <h2 className="section-title">{t('directory')}</h2>
      <AgentList paged={agents} label={t('directory')} empty={<EmptyState title={t('directoryEmpty')} />} />
    </>
  );
}
