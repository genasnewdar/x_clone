import { useEffect, useId, useState, type FormEvent } from 'react';
import { hrefs, navigate, type SearchType } from '../lib/router';
import { useT } from '../i18n';
import { IconSearch } from './Icons';

// Navigates to /search?q=...; never submits anything to a server.
export function SearchBox({ initial = '', type = 'posts', autoFocus }: { initial?: string; type?: SearchType; autoFocus?: boolean }) {
  const t = useT();
  const id = useId();
  const [q, setQ] = useState(initial);
  useEffect(() => setQ(initial), [initial]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = q.trim().slice(0, 100);
    if (v) navigate(hrefs.search(v, type));
  };
  return (
    <form role="search" className="searchbox" onSubmit={submit} aria-label={t('searchLabel')}>
      <label htmlFor={id} className="visually-hidden">
        {t('searchLabel')}
      </label>
      <IconSearch />
      <input
        id={id}
        type="search"
        value={q}
        maxLength={100}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        placeholder={t('searchPlaceholder')}
        autoFocus={autoFocus}
        onChange={(e) => setQ(e.target.value)}
      />
      <button type="submit" className="visually-hidden">
        {t('searchSubmit')}
      </button>
    </form>
  );
}
