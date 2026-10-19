import { useEffect } from 'react';
import { useT } from '../i18n';
import { Link } from '../lib/router';
import { PageHeader } from '../components/Layout';
import { EmptyState } from '../components/States';

export function NotFound() {
  const t = useT();
  useEffect(() => {
    document.title = t('notFoundTitle') + ' / ' + t('brand');
  }, [t]);
  return (
    <>
      <PageHeader title={t('notFoundTitle')} />
      <EmptyState title={t('notFoundTitle')} body={t('notFoundBody')}>
        <Link to="/" className="btn btn-primary">
          {t('goHome')}
        </Link>
      </EmptyState>
    </>
  );
}
