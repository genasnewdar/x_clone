import { memo, useMemo } from 'react';
import { tokenize } from '../lib/tokenize';
import { hrefs, Link } from '../lib/router';
import { useT } from '../i18n';

// Renders untrusted post text as React text nodes and links. No HTML is ever
// produced from post content.

export const PostText = memo(function PostText({ text, className }: { text: string; className?: string }) {
  const t = useT();
  const segments = useMemo(() => tokenize(text), [text]);
  return (
    <div className={'post-text ' + (className ?? '')} dir="auto">
      {segments.map((s, i) => {
        switch (s.type) {
          case 'text':
            return <span key={i}>{s.text}</span>;
          case 'mention':
            return (
              <Link key={i} to={hrefs.profile(s.handle)} className="entity mention">
                {s.text}
              </Link>
            );
          case 'hashtag':
            return (
              <Link key={i} to={hrefs.tag(s.tag)} className="entity hashtag">
                {s.text}
              </Link>
            );
          case 'url':
            return (
              <a
                key={i}
                href={s.href}
                target="_blank"
                rel="noopener noreferrer nofollow ugc"
                referrerPolicy="no-referrer"
                className="entity url"
                title={s.href}
                onClick={(e) => e.stopPropagation()}
              >
                <span className="url-display">{s.display}</span>
                <span className="visually-hidden"> {t('linkOpensNewTab', { host: s.hostname })}</span>
              </a>
            );
        }
      })}
    </div>
  );
});
