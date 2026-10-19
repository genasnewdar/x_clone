import { api } from '../lib/api';
import { useResource } from '../lib/data';
import { hrefs, Link } from '../lib/router';
import { useI18n } from '../i18n';
import { compactNumber } from '../lib/time';
import { ErrorState } from './States';

export function Trending({ heading = true, limit = 10 }: { heading?: boolean; limit?: number }) {
  const { t, lang } = useI18n();
  const { state, retry } = useResource('trending', (s) => api.trending(s));
  return (
    <section className="panel" aria-labelledby={heading ? 'trending-h' : undefined} aria-label={heading ? undefined : t('trending')}>
      {heading && (
        <h2 className="panel-title" id="trending-h">
          {t('trending')}
        </h2>
      )}
      {state.status === 'loading' && (
        <div role="status" className="panel-pad">
          <span className="visually-hidden">{t('loading')}</span>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="sk sk-line sk-w70" aria-hidden="true" />
          ))}
        </div>
      )}
      {state.status === 'error' && <ErrorState error={state.error} onRetry={retry} compact />}
      {state.status === 'ok' &&
        (state.data.items.length === 0 ? (
          <p className="panel-pad muted">{t('trendingEmpty')}</p>
        ) : (
          <ol className="trend-list">
            {state.data.items.slice(0, limit).map((tag, i) => (
              <li key={tag.tag}>
                <Link to={hrefs.tag(tag.tag)} className="trend">
                  <span className="trend-rank" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="trend-main">
                    <bdi className="trend-tag">#{tag.tag}</bdi>
                    <span className="trend-meta">
                      {t('trendingAuthors', { n: compactNumber(tag.authors, lang) })} · {t('trendingPosts', { n: compactNumber(tag.posts, lang) })}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
}
