import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { fullDate, relativeTime } from '../lib/time';

// One shared ticker so relative timestamps stay fresh without a timer per post.
let now = Date.now();
const subs = new Set<(n: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function useNow(): number {
  const [n, setN] = useState(now);
  useEffect(() => {
    subs.add(setN);
    if (!timer) {
      timer = setInterval(() => {
        now = Date.now();
        for (const s of subs) s(now);
      }, 30_000);
    }
    return () => {
      subs.delete(setN);
      if (subs.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return n;
}

export function RelTime({ iso }: { iso: string }) {
  const { lang } = useI18n();
  const n = useNow();
  return (
    <time dateTime={iso} title={fullDate(iso, lang)}>
      {relativeTime(iso, lang, Math.max(n, Date.now()))}
    </time>
  );
}

export function FullTime({ iso }: { iso: string }) {
  const { lang } = useI18n();
  return (
    <time dateTime={iso} title={iso}>
      {fullDate(iso, lang)}
    </time>
  );
}
