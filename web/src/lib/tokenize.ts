// Splits untrusted post text into typed segments for rendering as React text
// nodes and router links. Nothing here produces HTML.
//
// Rules mirror server/src/lib/text.ts so that every linked mention/hashtag
// matches what the server indexed:
//  - mention: @handle, handle [A-Za-z0-9_]{3,20}, not preceded by [A-Za-z0-9_@/]
//    and not followed by [A-Za-z0-9_@] (so emails and URL paths are skipped).
//  - hashtag: #tag of [\p{L}\p{M}\p{N}_]{1,50} with at least one letter, not
//    preceded by a tag char, '#', '&' or '/'.
//  - url: http:// or https:// only, at most 500 chars after trailing
//    punctuation is trimmed, and it must parse with new URL() as http(s).
//
// All regexes are linear: single character classes with one quantifier and
// single-character lookarounds, no nested quantifiers.
//
// NOTE: this file must stay pure ASCII; special characters use escapes.

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'mention'; text: string; handle: string }
  | { type: 'hashtag'; text: string; tag: string }
  | { type: 'url'; text: string; href: string; display: string; hostname: string };

export const MAX_URL_LENGTH = 500;
const URL_DISPLAY_LENGTH = 40;

// One combined, global scanner. Group 1: url, group 2: mention handle,
// group 3: hashtag body.
const TOKEN_RE = new RegExp(
  [
    // URL: scheme then a run of non-space, non-quote, non-angle, non-control chars.
    '(?<![\\p{L}\\p{N}_])((?:[Hh][Tt][Tt][Pp][Ss]?):\\/\\/[^\\s<>"\'`\\u0000-\\u001F\\u007F-\\u009F]+)',
    '(?<![A-Za-z0-9_@\\/])@([A-Za-z0-9_]{3,20})(?![A-Za-z0-9_@])',
    '(?<![\\p{L}\\p{M}\\p{N}_#&\\/])#([\\p{L}\\p{M}\\p{N}_]{1,50})(?![\\p{L}\\p{M}\\p{N}_])',
  ].join('|'),
  'gu',
);

const HAS_LETTER = /\p{L}/u;
const TRAILING_PUNCT = '.,;:!?)]}\'"';

/** Strips trailing punctuation; keeps a closing ')' that balances an '(' in the URL. */
export function trimUrl(raw: string): string {
  // Count parens once (linear), then adjust while stripping.
  let open = 0;
  let close = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 40) open++;
    else if (c === 41) close++;
  }
  let end = raw.length;
  while (end > 0) {
    const ch = raw[end - 1]!;
    if (TRAILING_PUNCT.indexOf(ch) === -1) break;
    if (ch === ')') {
      if (open >= close) break;
      close--;
    }
    end--;
  }
  return raw.slice(0, end);
}

/** Parses an http(s) URL; returns null for anything else. */
export function safeHttpUrl(raw: string): URL | null {
  if (raw.length > MAX_URL_LENGTH) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return u;
}

function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 1).join('') + '\u2026' : s;
}

function displayFor(u: URL): string {
  // Built from the parsed URL so the hostname shown is the one the browser
  // will actually visit (punycode for IDNs, userinfo dropped).
  let rest = u.pathname + u.search + u.hash;
  if (rest === '/') rest = '';
  return truncate(u.hostname + rest, URL_DISPLAY_LENGTH);
}

export function tokenize(input: string): Segment[] {
  const out: Segment[] = [];
  if (!input) return out;
  let last = 0;
  let pending = '';
  const pushText = (s: string) => {
    if (s) pending += s;
  };
  const flush = () => {
    if (pending) {
      out.push({ type: 'text', text: pending });
      pending = '';
    }
  };

  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(input)) !== null) {
    const start = m.index;
    const whole = m[0];
    pushText(input.slice(last, start));
    last = start + whole.length;

    if (m[1] !== undefined) {
      const trimmed = trimUrl(m[1]);
      const rest = m[1].slice(trimmed.length);
      const u = trimmed.length > 0 ? safeHttpUrl(trimmed) : null;
      if (u) {
        flush();
        out.push({ type: 'url', text: trimmed, href: u.href, display: displayFor(u), hostname: u.hostname });
        pushText(rest);
      } else {
        pushText(m[1]);
      }
    } else if (m[2] !== undefined) {
      flush();
      out.push({ type: 'mention', text: whole, handle: m[2].toLowerCase() });
    } else if (m[3] !== undefined) {
      if (HAS_LETTER.test(m[3])) {
        flush();
        out.push({ type: 'hashtag', text: whole, tag: m[3] });
      } else {
        pushText(whole);
      }
    }
  }
  pushText(input.slice(last));
  flush();
  return out;
}
