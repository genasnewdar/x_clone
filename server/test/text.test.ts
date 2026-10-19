import { describe, expect, it } from 'vitest';
import { resolveClientIp, ipBucket } from '../src/lib/ip.js';
import {
  cleanMultiline,
  cleanSingleLine,
  escapeLike,
  extractHashtags,
  extractMentions,
  graphemeLength,
  hasVisibleContent,
  normalizeHandle,
  normalizeTag,
} from '../src/lib/text.js';
import { checkSolution, leadingZeroBits, solve } from '../src/lib/pow.js';
import { bearerKey, generateApiKey, safeEqual } from '../src/lib/auth.js';

describe('text sanitizer', () => {
  it('removes NUL, C0/C1 controls and keeps newlines', () => {
    expect(cleanMultiline('a\u0000b\u0007c\u009Bd\ne')).toBe('abcd\ne');
  });

  it('repairs lone surrogates instead of passing them to Postgres', () => {
    const s = cleanMultiline('x\uD800y\uDFFFz');
    expect(s.isWellFormed()).toBe(true);
  });

  it('strips bidi overrides and isolates (Trojan Source / spoofing)', () => {
    expect(cleanSingleLine('admin\u202Egnp.exe')).toBe('admingnp.exe');
    expect(cleanSingleLine('\u2066x\u2069\u200E\u200F')).toBe('x');
  });

  it('strips zero-width spaces, BOM, soft hyphens, word joiners', () => {
    expect(cleanSingleLine('a\u200Bb\uFEFFc\u00ADd\u2060e')).toBe('abcde');
  });

  it('strips Unicode tag characters used for hidden-prompt smuggling', () => {
    // "hi" followed by TAG LATIN SMALL LETTER I, G, N, O, R, E
    const hidden = [0xe0069, 0xe0067, 0xe006e, 0xe006f, 0xe0072, 0xe0065].map((c) => String.fromCodePoint(c)).join('');
    expect(cleanSingleLine('hi' + hidden)).toBe('hi');
  });

  it('strips variation-selector smuggling but keeps emoji presentation', () => {
    const vs17 = String.fromCodePoint(0xe0100);
    expect(cleanSingleLine('a' + vs17 + vs17 + 'b')).toBe('ab');
    expect(cleanSingleLine('\u2764\uFE0F')).toBe('\u2764\uFE0F');
    expect(cleanSingleLine('\u2764\uFE0F\uFE0F\uFE0F')).toBe('\u2764\uFE0F');
  });

  it('keeps emoji ZWJ sequences intact', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect(cleanSingleLine(family)).toBe(family);
    expect(graphemeLength(family)).toBe(1);
  });

  it('keeps Mongolian free variation selectors after Mongolian letters', () => {
    const mongol = '\u182D\u180B\u1820\u180E\u1820';
    expect(cleanSingleLine(mongol)).toBe(mongol);
  });

  it('drops Mongolian FVS when stray or repeated', () => {
    expect(cleanSingleLine('a\u180Bb')).toBe('ab');
    expect(cleanSingleLine('\u182D\u180B\u180C\u180D')).toBe('\u182D\u180B');
  });

  it('keeps Mongolian Cyrillic text', () => {
    const s = '\u0421\u0430\u0439\u043D \u0431\u0430\u0439\u043D\u0430 \u0443\u0443';
    expect(cleanMultiline(s)).toBe(s);
  });

  it('caps zalgo combining-mark stacks', () => {
    const zalgo = 'a' + '\u0301'.repeat(50);
    expect(cleanSingleLine(zalgo)).toBe(('a' + '\u0301'.repeat(7)).normalize('NFC'));
  });

  it('collapses excessive newlines and normalizes CRLF and separators', () => {
    expect(cleanMultiline('a\r\n\r\n\r\n\r\nb\u2028c')).toBe('a\n\nb\nc');
  });

  it('normalizes to NFC so lookalike encodings compare equal', () => {
    expect(cleanSingleLine('e\u0301')).toBe('\u00E9');
  });

  it('detects content that is only invisible', () => {
    expect(hasVisibleContent(cleanSingleLine('\u200B\u200D \u3164'))).toBe(false);
    expect(hasVisibleContent('\u{1F600}')).toBe(true);
  });

  it('counts graphemes, not code units', () => {
    expect(graphemeLength('\u{1F1F2}\u{1F1F3}')).toBe(1); // flag
    expect(graphemeLength('abc')).toBe(3);
  });
});

describe('handles, mentions, hashtags', () => {
  it('accepts only ascii handles', () => {
    expect(normalizeHandle('@Some_Agent')).toBe('some_agent');
    expect(normalizeHandle('\u0430dmin')).toBeNull(); // Cyrillic a
    expect(normalizeHandle('ab')).toBeNull();
    expect(normalizeHandle('a'.repeat(21))).toBeNull();
    expect(normalizeHandle('a b c')).toBeNull();
    expect(normalizeHandle({})).toBeNull();
  });

  it('extracts mentions but not emails or URL paths', () => {
    expect(extractMentions('hi @alice and @Bob_2, mail me@example.com or see x.com/@carol')).toEqual(['alice', 'bob_2']);
  });

  it('extracts hashtags in any script', () => {
    expect(extractHashtags('#AI #\u041D\u0430\u0430\u0434\u0430\u043C #123 #\u182D\u1820')).toEqual([
      'ai',
      '\u043D\u0430\u0430\u0434\u0430\u043C',
      '\u182D\u1820',
    ]);
  });

  it('caps extraction counts', () => {
    const many = Array.from({ length: 50 }, (_, i) => `#t${i}x`).join(' ');
    expect(extractHashtags(many)).toHaveLength(10);
  });

  it('normalizes tags from URLs', () => {
    expect(normalizeTag('#Agents')).toBe('agents');
    expect(normalizeTag("x' OR 1=1")).toBeNull();
    expect(normalizeTag('')).toBeNull();
  });

  it('escapes LIKE metacharacters', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
  });

  it('extraction regexes are linear on hostile input', () => {
    const evil = '#'.repeat(50_000) + '@'.repeat(50_000) + 'a'.repeat(50_000);
    const t = performance.now();
    extractHashtags(evil);
    extractMentions(evil);
    cleanMultiline(evil);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe('client IP resolution', () => {
  it('ignores X-Forwarded-For when no proxy is trusted', () => {
    expect(resolveClientIp('1.2.3.4', '9.9.9.9', 0)).toBe('9.9.9.9');
  });

  it('takes the entry appended by the trusted proxy, not client-supplied ones', () => {
    // Client sent "X-Forwarded-For: 6.6.6.6"; the proxy appended the real 5.5.5.5.
    expect(resolveClientIp('6.6.6.6, 5.5.5.5', '10.0.0.1', 1)).toBe('5.5.5.5');
    expect(resolveClientIp('6.6.6.6, 5.5.5.5, 35.191.0.1', '10.0.0.1', 2)).toBe('5.5.5.5');
  });

  it('falls back to the peer on garbage', () => {
    expect(resolveClientIp('not-an-ip', '9.9.9.9', 1)).toBe('9.9.9.9');
    expect(resolveClientIp(',,,', '9.9.9.9', 1)).toBe('9.9.9.9');
  });

  it('canonicalizes IPv4-mapped IPv6 and strips ports', () => {
    expect(resolveClientIp(undefined, '::ffff:1.2.3.4', 0)).toBe('1.2.3.4');
    expect(resolveClientIp('1.2.3.4:5678', undefined, 1)).toBe('1.2.3.4');
    expect(resolveClientIp('[2001:db8::1]:443', undefined, 1)).toBe('2001:db8::1');
  });

  it('buckets IPv6 by /64', () => {
    expect(ipBucket('2001:db8:1:2:3:4:5:6')).toBe('2001:0db8:0001:0002::/64');
    expect(ipBucket('2001:db8:1:2::ffff')).toBe(ipBucket('2001:db8:1:2:aaaa::1'));
    expect(ipBucket('1.2.3.4')).toBe('1.2.3.4');
  });
});

describe('proof of work and keys', () => {
  it('counts leading zero bits', () => {
    expect(leadingZeroBits(Buffer.from([0, 0, 0x10]))).toBe(19);
    expect(leadingZeroBits(Buffer.from([0x80]))).toBe(0);
  });

  it('solves and verifies', () => {
    const nonce = solve('abc', 10);
    expect(checkSolution('abc', nonce, 10)).toBe(true);
  });

  it('generates well-formed keys and parses bearer headers strictly', () => {
    const key = generateApiKey();
    expect(bearerKey(`Bearer ${key}`)).toBe(key);
    expect(bearerKey(`bearer ${key}`)).toBe(key);
    expect(bearerKey(`Bearer ${key} extra`)).toBeNull();
    expect(bearerKey(`Basic ${key}`)).toBeNull();
    expect(bearerKey('Bearer axk_short')).toBeNull();
    expect(safeEqual('a', 'a')).toBe(true);
    expect(safeEqual('a', 'ab')).toBe(false);
  });
});
