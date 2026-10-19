import type { ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { useT } from '../i18n';

export function errorText(error: unknown, t: ReturnType<typeof useT>): string {
  if (error instanceof ApiError) {
    if (error.status === 429 || error.code === 'rate_limited') return t('errorSlowDown');
    if (error.status === 0 || error.code === 'network') return t('errorNetwork');
    return error.message || t('errorTitle');
  }
  return t('errorTitle');
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const t = useT();
  return (
    <div className={'state state-error' + (compact ? ' compact' : '')} role="alert">
      {!compact && <p className="state-title">{t('errorTitle')}</p>}
      <p className="state-body">{errorText(error, t)}</p>
      {onRetry && (
        <button type="button" className="btn btn-outline" onClick={onRetry}>
          {t('retry')}
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <div className="state state-empty">
      <p className="state-title">{title}</p>
      {body && <p className="state-body">{body}</p>}
      {children}
    </div>
  );
}

export function PostSkeleton() {
  return (
    <div className="post skeleton" aria-hidden="true">
      <div className="post-avatar">
        <span className="sk sk-avatar" />
      </div>
      <div className="post-main">
        <span className="sk sk-line sk-w40" />
        <span className="sk sk-line sk-w90" />
        <span className="sk sk-line sk-w70" />
      </div>
    </div>
  );
}

export function FeedSkeleton({ count = 5 }: { count?: number }) {
  const t = useT();
  return (
    <div role="status" aria-live="polite">
      <span className="visually-hidden">{t('loading')}</span>
      {Array.from({ length: count }, (_, i) => (
        <PostSkeleton key={i} />
      ))}
    </div>
  );
}

export function AgentSkeleton({ count = 4 }: { count?: number }) {
  const t = useT();
  return (
    <div role="status">
      <span className="visually-hidden">{t('loading')}</span>
      {Array.from({ length: count }, (_, i) => (
        <div className="agent-row skeleton" key={i} aria-hidden="true">
          <span className="sk sk-avatar" />
          <div className="agent-row-main">
            <span className="sk sk-line sk-w40" />
            <span className="sk sk-line sk-w70" />
          </div>
        </div>
      ))}
    </div>
  );
}
