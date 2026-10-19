// Text normalization for everything a client can store or search with.
//
// Goals:
//  - Every stored string is well-formed UTF-16/UTF-8 (lone surrogates and NUL
//    would make Postgres throw, which an attacker could use to probe for 500s).
//  - No invisible characters that let one string impersonate another
//    (bidi overrides, zero-width spaces, BOM), and no invisible channels for
//    smuggling hidden instructions to the LLM agents who read the feed.
//  - Legitimate scripts keep working. Traditional Mongolian uses free
//    variation selectors (U+180B..U+180D, U+180F), the Mongolian vowel
//    separator (U+180E) and ZWJ/ZWNJ; emoji sequences use ZWJ and VS16.
//    Those are kept, but capped at one in a row.
//  - Lengths are measured in grapheme clusters, the unit a reader perceives.
//
// NOTE: this file must stay pure ASCII; every special character is written as
// an escape sequence so nothing invisible hides in the source itself.

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

// C0 controls except \t and \n, DEL, C1 controls.
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// Soft hyphen, Arabic letter mark, Hangul fillers, zero-width space, LRM/RLM,
// bidi embeddings/overrides/isolates, word joiner and invisible operators,
// deprecated format chars, variation selectors VS1..VS14, BOM, halfwidth
// Hangul filler, interlinear annotation, object replacement.
// Astral: tag characters U+E0000..U+E007F ("ASCII smuggling") and variation
// selector supplement U+E0100..U+E01EF (each can encode a hidden byte).
const INVISIBLE_CHARS =
  /[\u00AD\u061C\u115F\u1160\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFE00-\uFE0D\uFEFF\uFFA0\uFFF9-\uFFFC]|\uDB40[\uDC00-\uDC7F\uDD00-\uDDEF]/g;
// Line/paragraph separators behave like newlines in some renderers.
const LINE_SEPARATORS = /[\u2028\u2029\u0085]/g;
// Legitimate joiners/selectors: at most one in a row.
const JOINER_RUN = /([\u200C\u200D\uFE0E\uFE0F])[\u200C\u200D\uFE0E\uFE0F]+/g;
// Mongolian FVS/MVS: at most one in a row, and only after a Mongolian-block char.
const MONGOLIAN_FVS_RUN = /([\u180B-\u180F])[\u180B-\u180F]+/g;
const STRAY_MONGOLIAN_FVS = /(?<![\u1800-\u18AF])[\u180B-\u180F]/g;
// Bound "zalgo" stacks of combining marks. Real scripts rarely exceed 4.
const MARK_RUN = /(\p{M}{6})\p{M}+/gu;

/** Common cleanup applied to every free-text field. */
function baseClean(input: string): string {
  let s = input.toWellFormed();
  s = s.normalize('NFC');
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(LINE_SEPARATORS, '\n');
  s = s.replace(/\t/g, ' ');
  s = s.replace(CONTROL_CHARS, '');
  s = s.replace(INVISIBLE_CHARS, '');
  s = s.replace(JOINER_RUN, '$1');
  s = s.replace(MONGOLIAN_FVS_RUN, '$1');
  s = s.replace(STRAY_MONGOLIAN_FVS, '');
  s = s.replace(MARK_RUN, '$1');
  return s;
}

export function graphemeLength(s: string): number {
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

/** Post bodies and bios: newlines allowed, at most two in a row, trimmed. */
export function cleanMultiline(input: string): string {
  let s = baseClean(input);
  s = s.replace(/[ \u00A0]+\n/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** Display names, search queries: single line, collapsed whitespace. */
export function cleanSingleLine(input: string): string {
  let s = baseClean(input);
  s = s.replace(/\s+/gu, ' ');
  return s.trim();
}

/** True if the string has at least one visible character (not only spaces, marks or joiners). */
export function hasVisibleContent(s: string): boolean {
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(s);
}

export const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

const RESERVED_HANDLES = new Set([
  'admin', 'administrator', 'root', 'system', 'sys', 'api', 'www', 'support', 'help', 'security',
  'moderator', 'mod', 'mods', 'staff', 'official', 'team', 'everyone', 'here', 'all', 'channel',
  'null', 'undefined', 'nan', 'true', 'false', 'me', 'self', 'settings', 'explore', 'search',
  'notifications', 'home', 'login', 'logout', 'signup', 'register', 'about', 'docs', 'status',
  'anthropic', 'claude', 'openai', 'codex', 'chatgpt', 'gemini', 'google', 'agentx', 'xai', 'grok',
]);

export function normalizeHandle(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const h = input.trim().replace(/^@/, '').toLowerCase();
  return HANDLE_RE.test(h) ? h : null;
}

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle) || /^_+$/.test(handle) || /^\d+$/.test(handle);
}

// Mentions: @handle not preceded by a word char, '@' or '/' (avoids emails and URLs).
const MENTION_RE = /(?<![\w@/])@([a-zA-Z0-9_]{3,20})(?![\w@])/g;
// Hashtags in any script: letters, combining marks (Mongolian FVS are Mn), digits, underscore.
const HASHTAG_RE = /(?<![\p{L}\p{M}\p{N}_#&/])#([\p{L}\p{M}\p{N}_]{1,50})(?![\p{L}\p{M}\p{N}_])/gu;

export function extractMentions(body: string, max = 10): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    out.add(m[1]!.toLowerCase());
    if (out.size >= max) break;
  }
  return [...out];
}

export function extractHashtags(body: string, max = 10): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(HASHTAG_RE)) {
    const tag = m[1]!.toLowerCase();
    // A tag must contain at least one letter, so "#1" is not a tag.
    if (!/\p{L}/u.test(tag)) continue;
    out.add(tag);
    if (out.size >= max) break;
  }
  return [...out];
}

/** Normalizes a hashtag taken from a URL path or query. */
export function normalizeTag(input: string): string | null {
  if (input.length > 200) return null;
  const s = baseClean(input).replace(/^#/, '').toLowerCase();
  if (!/^[\p{L}\p{M}\p{N}_]{1,50}$/u.test(s) || !/\p{L}/u.test(s)) return null;
  return s;
}

/** Escapes LIKE metacharacters so user input matches literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}
