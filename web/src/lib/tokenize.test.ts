import { describe, expect, it } from 'vitest';
import { tokenize, trimUrl, safeHttpUrl, type Segment } from './tokenize';

const types = (segs: Segment[]) => segs.map((s) => s.type);
const linked = (segs: Segment[]) => segs.filter((s) => s.type !== 'text');
const joined = (segs: Segment[]) => segs.map((s) => s.text).join('');

describe('tokenize', () => {
  it('returns nothing for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('keeps plain text as a single segment', () => {
    expect(tokenize('hello world')).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('round-trips the original text exactly', () => {
    const s = 'hi @agent_one see https://example.com/a?b=1, and #tag! (https://x.org/w_(x)) end.';
    expect(joined(tokenize(s))).toBe(s);
  });

  it('does not link javascript: URLs', () => {
    for (const s of [
      'javascript:alert(1)',
      'click JavaScript:alert(document.cookie)',
      'javascript://example.com/%0Aalert(1)',
      'x javascript:https://example.com',
    ]) {
      const segs = tokenize(s);
      expect(segs.some((x) => x.type === 'url' && !x.href.startsWith('http'))).toBe(false);
      for (const x of segs) if (x.type === 'url') expect(x.href).toMatch(/^https?:\/\//);
    }
    expect(linked(tokenize('javascript:alert(1)'))).toEqual([]);
  });

  it('does not link data:, vbscript:, file: or protocol-relative URLs', () => {
    for (const s of [
      'data:text/html,<script>alert(1)</script>',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '//evil.example/path',
      'ftp://example.com',
    ]) {
      expect(linked(tokenize(s)).filter((x) => x.type === 'url')).toEqual([]);
    }
  });

  it('keeps <script> and HTML as plain text', () => {
    const s = '<script>alert(1)</script><img src=x onerror=alert(1)>';
    expect(tokenize(s)).toEqual([{ type: 'text', text: s }]);
  });

  it('links http and https URLs and reports the real hostname', () => {
    const segs = tokenize('see https://Example.com/path?q=1 now');
    expect(types(segs)).toEqual(['text', 'url', 'text']);
    const u = segs[1]!;
    if (u.type !== 'url') throw new Error('expected url');
    expect(u.href).toBe('https://example.com/path?q=1');
    expect(u.hostname).toBe('example.com');
    expect(u.display).toBe('example.com/path?q=1');
  });

  it('shows the actual host when userinfo tries to spoof it', () => {
    const segs = linked(tokenize('https://google.com@evil.example/login'));
    expect(segs).toHaveLength(1);
    const u = segs[0]!;
    if (u.type !== 'url') throw new Error('expected url');
    expect(u.hostname).toBe('evil.example');
    expect(u.display.startsWith('evil.example')).toBe(true);
  });

  it('excludes trailing punctuation from URLs', () => {
    for (const p of ['.', ',', ';', ':', '!', '?', ')', ']', '}', "'", '"', '...', '!?', ').']) {
      const segs = tokenize(`go to https://example.com/a${p}`);
      const u = segs.find((x) => x.type === 'url');
      expect(u?.text).toBe('https://example.com/a');
      expect(joined(segs)).toBe(`go to https://example.com/a${p}`);
    }
  });

  it('keeps balanced parentheses in URLs', () => {
    expect(trimUrl('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(trimUrl('https://en.wikipedia.org/wiki/Foo_(bar))')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    const segs = tokenize('(see https://example.com/x)');
    expect(segs.find((x) => x.type === 'url')?.text).toBe('https://example.com/x');
  });

  it('does not link URLs glued to a preceding word', () => {
    expect(linked(tokenize('xhttps://example.com'))).toEqual([]);
  });

  it('does not link URLs over 500 chars', () => {
    const long = 'https://example.com/' + 'a'.repeat(600);
    expect(linked(tokenize(long))).toEqual([]);
    expect(safeHttpUrl(long)).toBeNull();
  });

  it('truncates long URL display text', () => {
    const segs = linked(tokenize('https://example.com/' + 'b'.repeat(200)));
    const u = segs[0]!;
    if (u.type !== 'url') throw new Error('expected url');
    expect(Array.from(u.display).length).toBeLessThanOrEqual(40);
    expect(u.display.endsWith('\u2026')).toBe(true);
  });

  it('links mentions', () => {
    const segs = tokenize('hi @Agent_One and @bo');
    expect(linked(segs)).toEqual([{ type: 'mention', text: '@Agent_One', handle: 'agent_one' }]);
  });

  it('does not match mentions inside emails or URLs', () => {
    expect(linked(tokenize('mail me at someone@example.com'))).toEqual([]);
    expect(linked(tokenize('a@@double_at'))).toEqual([]);
    expect(linked(tokenize('path/@handle_x'))).toEqual([]);
    expect(linked(tokenize('@toolonghandle_123456789 x'))).toEqual([]);
    expect(linked(tokenize('@handle@example.com'))).toEqual([]);
  });

  it('links Latin, Cyrillic and Mongolian-script hashtags', () => {
    const latin = linked(tokenize('#agents rock'));
    expect(latin).toEqual([{ type: 'hashtag', text: '#agents', tag: 'agents' }]);

    // Cyrillic: #\u041C\u043E\u043D\u0433\u043E\u043B (Mongol)
    const cyr = '\u041C\u043E\u043D\u0433\u043E\u043B';
    expect(linked(tokenize(`\u0421\u0430\u0439\u043D #${cyr}!`))).toEqual([
      { type: 'hashtag', text: `#${cyr}`, tag: cyr },
    ]);

    // Traditional Mongolian script with a free variation selector (Mn).
    const mong = '\u182E\u1823\u1829\u182D\u1823\u182F\u180B';
    expect(linked(tokenize(`#${mong} \u1825`))).toEqual([{ type: 'hashtag', text: `#${mong}`, tag: mong }]);
  });

  it('does not link digit-only, glued or overlong hashtags', () => {
    expect(linked(tokenize('#123'))).toEqual([]);
    expect(linked(tokenize('abc#tag'))).toEqual([]);
    expect(linked(tokenize('&#39;'))).toEqual([]);
    expect(linked(tokenize('#' + 'a'.repeat(51)))).toEqual([]);
    expect(linked(tokenize('#' + 'a'.repeat(50)))).toHaveLength(1);
  });

  it('handles 100KB of adversarial input quickly', () => {
    const inputs = [
      'a'.repeat(100_000),
      '@'.repeat(100_000),
      '#'.repeat(100_000),
      '#a'.repeat(50_000),
      'https://' + 'a'.repeat(100_000),
      'https://a' + ')'.repeat(100_000),
      'https://a' + '.'.repeat(100_000),
      'http://'.repeat(15_000),
      '@ab_'.repeat(25_000),
      ('x '.repeat(10) + 'https://example.com/a #tag @someone ').repeat(1500),
      '\u0301'.repeat(100_000),
    ];
    for (const s of inputs) {
      const t0 = performance.now();
      const segs = tokenize(s);
      const dt = performance.now() - t0;
      expect(joined(segs)).toBe(s);
      expect(dt).toBeLessThan(500);
    }
  });
});
