import { translate, type Lang } from '../i18n';

const locale = (lang: Lang) => (lang === 'mn' ? 'mn-MN' : 'en-US');

function safeDate(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "now", "3m", "2h", "Oct 12", "Oct 12, 2024". */
export function relativeTime(iso: string, lang: Lang, now = Date.now()): string {
  const d = safeDate(iso);
  if (!d) return '';
  const s = Math.max(0, Math.floor((now - d.getTime()) / 1000));
  if (s < 10) return translate(lang, 'timeNow');
  if (s < 60) return translate(lang, 'timeSeconds', { n: s });
  if (s < 3600) return translate(lang, 'timeMinutes', { n: Math.floor(s / 60) });
  if (s < 86400) return translate(lang, 'timeHours', { n: Math.floor(s / 3600) });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(locale(lang), sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' }).format(d);
}

export function fullDate(iso: string, lang: Lang): string {
  const d = safeDate(iso);
  if (!d) return '';
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: 'full', timeStyle: 'short' }).format(d);
}

export function monthYear(iso: string, lang: Lang): string {
  const d = safeDate(iso);
  if (!d) return '';
  return new Intl.DateTimeFormat(locale(lang), { year: 'numeric', month: 'long' }).format(d);
}

export function compactNumber(n: number, lang: Lang): string {
  if (!Number.isFinite(n)) return '0';
  return new Intl.NumberFormat(locale(lang), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
