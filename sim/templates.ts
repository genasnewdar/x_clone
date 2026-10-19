// Offline text generator: per-persona word-level markov chain over seed lines,
// plus reply/quote templates. No network, no cost.

import type { Persona } from './personas.js';
import type { Post } from './client.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function graphemeLength(s: string): number {
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

export function truncateGraphemes(s: string, max: number): string {
  let out = '';
  let n = 0;
  for (const { segment } of segmenter.segment(s)) {
    if (++n > max) return out.trimEnd() + '…';
    out += segment;
  }
  return out;
}

/** Clamps to 280 graphemes, cutting at a word boundary when possible. */
export function clampPost(s: string, max = 280): string {
  const t = s.trim();
  if (graphemeLength(t) <= max) return t;
  const cut = truncateGraphemes(t, max - 1).replace(/…$/, '');
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

const STOP = new Set(
  'about above after again against because been before being below between both could does doing down during each from further have having here hers herself himself into itself just more most myself once only other ought ours ourselves over same should some such than that their theirs them themselves then there these they this those through under until very were what when where which while whom with would your yours yourself yourselves still really thing things think'.split(
    ' ',
  ),
);

/** A salient word from a post, for templates like "what do you mean by {topic}?" */
export function topicOf(text: string): string {
  const tag = text.match(/#([\p{L}\p{N}_]{3,30})/u);
  if (tag && Math.random() < 0.5) return tag[1]!;
  const words = text
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[@#]+/, '').replace(/[^\p{L}\p{N}_'-]/gu, ''))
    .filter((w) => graphemeLength(w) >= 5 && !STOP.has(w.toLowerCase()) && !/^\d+$/.test(w));
  if (!words.length) return tag?.[1] ?? 'this';
  words.sort((a, b) => b.length - a.length);
  return pick(words.slice(0, 3)).toLowerCase();
}

class Markov {
  private next = new Map<string, string[]>();
  private starts: string[] = [];

  constructor(lines: string[]) {
    for (const line of lines) {
      const words = line.split(/\s+/).filter(Boolean);
      if (!words.length) continue;
      this.starts.push(words[0]!);
      for (let i = 0; i < words.length; i++) {
        const key = words[i]!;
        const nxt = words[i + 1] ?? '\u0000';
        const arr = this.next.get(key) ?? [];
        arr.push(nxt);
        this.next.set(key, arr);
      }
    }
  }

  generate(maxWords = 40): string {
    if (!this.starts.length) return '';
    const out: string[] = [];
    let w = pick(this.starts);
    while (out.length < maxWords) {
      out.push(w);
      const options = this.next.get(w);
      if (!options) break;
      const n = pick(options);
      if (n === '\u0000') {
        if (out.length >= 6) break;
        w = pick(this.starts);
        continue;
      }
      w = n;
    }
    return out.join(' ');
  }
}

export class TemplateWriter {
  private chains = new Map<string, Markov>();
  private recent = new Map<string, string[]>();

  private chain(p: Persona): Markov {
    let m = this.chains.get(p.handle);
    if (!m) {
      m = new Markov(p.corpus);
      this.chains.set(p.handle, m);
    }
    return m;
  }

  private remember(p: Persona, text: string): string {
    const r = this.recent.get(p.handle) ?? [];
    r.push(text);
    if (r.length > 30) r.shift();
    this.recent.set(p.handle, r);
    return text;
  }

  private usedRecently(p: Persona, text: string): boolean {
    return (this.recent.get(p.handle) ?? []).includes(text);
  }

  private withHashtag(p: Persona, text: string, chance: number): string {
    if (!p.hashtags.length || Math.random() > chance || /#\S/.test(text)) return text;
    const tag = `#${pick(p.hashtags)}`;
    return graphemeLength(text) + tag.length + 1 <= 280 ? `${text} ${tag}` : text;
  }

  post(p: Persona): string {
    for (let attempt = 0; attempt < 8; attempt++) {
      let text: string;
      if (p.wholeLines || Math.random() < 0.4) text = pick(p.corpus);
      else text = this.chain(p).generate();
      text = this.withHashtag(p, text, p.wholeLines ? 0.35 : 0.55);
      text = clampPost(text);
      if (!this.usedRecently(p, text)) return this.remember(p, text);
    }
    // Everything recent: let the markov chain run longer for something new.
    return this.remember(p, clampPost(`${this.chain(p).generate(25)} ${this.chain(p).generate(15)}`));
  }

  reply(p: Persona, target: Post, opts: { welcome?: boolean } = {}): string {
    const disagree = p.rebuttals?.length && Math.random() < p.argumentativeness;
    let pool = disagree ? p.rebuttals! : p.replies;
    if (opts.welcome) pool = p.replies.filter((r) => r.includes('{handle}'));
    for (let attempt = 0; attempt < 5; attempt++) {
      let text = pick(pool).replaceAll('{topic}', topicOf(target.text)).replaceAll('{handle}', target.author.handle);
      if (!opts.welcome && !p.wholeLines && Math.random() < 0.3) text = `${text} ${this.chain(p).generate(14)}`;
      text = clampPost(text);
      if (!this.usedRecently(p, text)) return this.remember(p, text);
    }
    return this.remember(p, clampPost(`${pick(pool).replaceAll('{topic}', topicOf(target.text)).replaceAll('{handle}', target.author.handle)} ${this.chain(p).generate(10)}`));
  }

  quote(p: Persona, target: Post): string {
    let text = pick(p.quotes).replaceAll('{topic}', topicOf(target.text)).replaceAll('{handle}', target.author.handle);
    if (this.usedRecently(p, text) || Math.random() < 0.3) text = `${text} ${this.chain(p).generate(12)}`;
    return this.remember(p, clampPost(this.withHashtag(p, text, 0.3)));
  }
}
