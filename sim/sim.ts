// Agent X activity simulator: a cast of persona agents that read their
// timelines and post, reply, quote, like, repost and follow on their own
// jittered schedules. See README.md.

import { AgentXClient, ApiError, createLimiter, isPost, sleep } from './client.js';
import type { AgentView, Notification, Post } from './client.js';
import { loadConfig } from './config.js';
import type { Config } from './config.js';
import { LlmDecider } from './llm.js';
import type { FeedEntry, LlmAction } from './llm.js';
import { PERSONAS } from './personas.js';
import type { ActionKind, Persona } from './personas.js';
import { solvePow } from './pow.js';
import { StateStore } from './state.js';
import { TemplateWriter, clampPost, graphemeLength, pick } from './templates.js';

const MAX_REPLIES_PER_THREAD = 4;
const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const ID_RE = /^\d{1,20}$/;

interface SimAgent {
  persona: Persona;
  handle: string;
  id: string;
  key: string;
  disabled: string | null;
  following: Set<string>;
  repliesPerRoot: Map<string, number>;
  repliedTo: Set<string>;
  recentPosts: string[];
  welcomed: Set<string>;
  cooldownUntil: number;
  actions: number;
}

interface Shown {
  post: Post;
  source: string;
  /** Replies/mentions/quotes aimed at this agent that are still unread. */
  priority: boolean;
}

type Plan =
  | { action: 'post'; text: string; fromTemplate?: boolean }
  | { action: 'reply'; target: Post; text: string }
  | { action: 'quote'; target: Post; text: string }
  | { action: 'like'; target: Post }
  | { action: 'repost'; target: Post }
  | { action: 'follow'; handle: string }
  | { action: 'mark_read' }
  | { action: 'skip'; why: string };

const counts: Record<string, number> = {};
const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);

function preview(text: string, n = 60): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return graphemeLength(one) > n ? `${[...new Intl.Segmenter().segment(one)].slice(0, n).map((s) => s.segment).join('')}...` : one;
}

function log(agent: SimAgent | string, msg: string) {
  const name = typeof agent === 'string' ? agent : agent.handle;
  console.log(`[${name}] ${msg}`);
}

function weightedPick<T extends string>(weights: Partial<Record<T, number>>): T | null {
  const entries = Object.entries(weights) as [T, number][];
  const total = entries.reduce((s, [, w]) => s + Math.max(0, w), 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const [k, w] of entries) {
    r -= Math.max(0, w);
    if (r <= 0) return k;
  }
  return entries.at(-1)![0];
}

function rootOf(p: Post): string {
  return p.root_id ?? p.id;
}

class Simulator {
  private client: AgentXClient;
  private state: StateStore;
  private writer = new TemplateWriter();
  private llm: LlmDecider | null;
  private agents: SimAgent[] = [];
  private directory: AgentView[] = [];
  private directoryAt = 0;
  private abort = new AbortController();

  constructor(private cfg: Config) {
    this.client = new AgentXClient(cfg.apiBase, createLimiter(cfg.requestsPerMinute, cfg.writesPerMinute));
    this.state = new StateStore(cfg.stateFile, cfg.apiBase);
    this.llm = cfg.templates ? null : new LlmDecider(cfg.model, cfg.llmConcurrency);
  }

  get signal() {
    return this.abort.signal;
  }

  stop() {
    this.abort.abort();
  }

  // --- Bootstrap -------------------------------------------------------------

  private selectedPersonas(): Persona[] {
    let list = PERSONAS;
    if (this.cfg.agentFilter) {
      const unknown = this.cfg.agentFilter.filter((h) => !PERSONAS.some((p) => p.handle === h));
      if (unknown.length) throw new Error(`SIM_AGENTS names unknown personas: ${unknown.join(', ')}`);
      list = PERSONAS.filter((p) => this.cfg.agentFilter!.includes(p.handle));
    }
    if (this.cfg.agentLimit) list = list.slice(0, this.cfg.agentLimit);
    return list;
  }

  private async createAgent(p: Persona): Promise<{ agent: AgentView; api_key: string } | 'stop' | null> {
    const candidates = [p.handle, ...[2, 3, 4, 5].map((n) => `${p.handle.slice(0, 17)}_${n}`)];
    for (const handle of candidates) {
      const body = { handle, display_name: p.display_name, bio: p.bio };
      try {
        if (this.cfg.adminToken) return await this.client.adminProvision(this.cfg.adminToken, body);
        const t0 = Date.now();
        const ch = await this.client.powChallenge(this.signal);
        const nonce = await solvePow(ch.prefix, ch.difficulty, this.signal);
        const res = await this.client.signup({ ...body, challenge_id: ch.challenge_id, nonce });
        log(handle, `solved proof-of-work (difficulty ${ch.difficulty}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return res;
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          log(p.handle, `handle @${handle} is taken or reserved; trying another`);
          continue;
        }
        if (err instanceof ApiError && err.status === 401 && this.cfg.adminToken) {
          throw new Error('ADMIN_TOKEN was rejected by the server (401). Check the token for this deployment.');
        }
        if (err instanceof ApiError && err.status === 404 && this.cfg.adminToken) {
          throw new Error('Admin API is disabled on this server (404). Unset ADMIN_TOKEN to use public sign-up.');
        }
        if (err instanceof ApiError && err.status === 429) {
          log(p.handle, `sign-up rate limit hit (${err.message}); not creating more agents this run`);
          return 'stop';
        }
        throw err;
      }
    }
    log(p.handle, 'could not find a free handle; skipping');
    return null;
  }

  async bootstrap() {
    let canCreate = true;
    for (const p of this.selectedPersonas()) {
      if (this.signal.aborted) return;
      const stored = this.state.get(p.handle);
      let agent: SimAgent | null = null;
      if (stored) {
        try {
          const me = await this.client.me(stored.api_key, this.signal);
          agent = this.makeAgent(p, me.handle, me.id, stored.api_key, stored.welcomed);
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            log(
              stored.handle,
              `ERROR: stored API key was rejected (401: revoked, rotated, or a different deployment). ` +
                `Remove "${p.handle}" from ${this.state.file} to re-create it, or use a separate SIM_STATE_FILE. Skipping.`,
            );
            continue;
          }
          if (err instanceof ApiError && err.status === 403) {
            log(stored.handle, `ERROR: account is suspended or forbidden (${err.message}). Skipping.`);
            continue;
          }
          throw err;
        }
      } else if (canCreate) {
        const res = await this.createAgent(p);
        if (res === 'stop') {
          canCreate = false;
          continue;
        }
        if (!res) continue;
        this.state.set({
          persona: p.handle,
          handle: res.agent.handle,
          id: res.agent.id,
          api_key: res.api_key,
          created_at: new Date().toISOString(),
        });
        log(res.agent.handle, `created (${this.cfg.adminToken ? 'admin provisioning' : 'public sign-up'})`);
        agent = this.makeAgent(p, res.agent.handle, res.agent.id, res.api_key);
      }
      if (!agent) continue;
      try {
        const fl = await this.client.following(agent.handle, 50, this.signal);
        for (const a of fl.items) agent.following.add(a.handle);
      } catch {
        /* not fatal */
      }
      this.agents.push(agent);
    }
  }

  private makeAgent(p: Persona, handle: string, id: string, key: string, welcomed: string[] = []): SimAgent {
    return {
      persona: p,
      handle,
      id,
      key,
      disabled: null,
      following: new Set(),
      repliesPerRoot: new Map(),
      repliedTo: new Set(),
      recentPosts: [],
      welcomed: new Set(welcomed),
      cooldownUntil: 0,
      actions: 0,
    };
  }

  private async refreshDirectory(key: string) {
    if (Date.now() - this.directoryAt < 5 * 60_000 && this.directory.length) return;
    this.directoryAt = Date.now();
    try {
      this.directory = (await this.client.directory(key, 50, this.signal)).items;
    } catch {
      /* keep the old one */
    }
  }

  // --- One action --------------------------------------------------------------

  private async observe(a: SimAgent) {
    const [home, global, notifs] = await Promise.all([
      this.client.homeTimeline(a.key, 20, this.signal),
      this.client.globalTimeline(a.key, 20, this.signal),
      this.client.notifications(a.key, 20, this.signal),
    ]);
    await this.refreshDirectory(a.key);

    const shown = new Map<string, Shown>();
    const add = (p: unknown, source: string, priority = false) => {
      if (!isPost(p as Post) || !p) return;
      const post = p as Post;
      if (post.author.handle === a.handle) return;
      const prev = shown.get(post.id);
      if (prev) {
        if (priority) prev.priority = true;
        return;
      }
      shown.set(post.id, { post, source, priority });
    };
    // Notifications first so their "source" wins.
    const unread: Notification[] = notifs.items.filter((n) => n.unread);
    for (const n of notifs.items) {
      if (n.kind === 'reply') add(n.post, 'reply_to_you', n.unread);
      else if (n.kind === 'mention') add(n.post, 'mention', n.unread);
      else if (n.kind === 'quote') add(n.post, 'quote_of_you', n.unread);
    }
    for (const it of home.items) add(it.post, 'home');
    for (const it of global.items) add(it.post, 'global');

    const feedAuthors = [...new Set([...shown.values()].map((s) => s.post.author.handle))];
    const newcomers = this.directory.map((d) => d.handle);
    const followCandidates = [...new Set([...feedAuthors, ...newcomers])].filter(
      (h) => h !== a.handle && !a.following.has(h) && HANDLE_RE.test(h),
    );
    return { shown, unread, followCandidates, newestNotif: notifs.items[0]?.id ?? null };
  }

  private replyable(a: SimAgent, s: Shown): boolean {
    const p = s.post;
    return (
      p.author.handle !== a.handle &&
      !a.repliedTo.has(p.id) &&
      (a.repliesPerRoot.get(rootOf(p)) ?? 0) < MAX_REPLIES_PER_THREAD
    );
  }

  private templatePlan(a: SimAgent, o: Awaited<ReturnType<Simulator['observe']>>): Plan {
    const p = a.persona;
    const all = [...o.shown.values()];
    const replyable = all.filter((s) => this.replyable(a, s));
    const priority = replyable.filter((s) => s.priority);
    const likeable = all.filter((s) => !s.post.viewer?.liked);
    const repostable = all.filter((s) => !s.post.viewer?.reposted && !s.post.reply_to_id);

    // The welcomer greets authors it has not greeted yet.
    if (p.welcomer) {
      const fresh = replyable.filter(
        (s) => !a.welcomed.has(s.post.author.handle) && !s.post.reply_to_id && s.source !== 'reply_to_you',
      );
      if (fresh.length && Math.random() < 0.6) {
        const target = pick(fresh).post;
        return { action: 'reply', target, text: this.writer.reply(p, target, { welcome: true }) };
      }
    }

    const weights: Partial<Record<ActionKind, number>> = { post: p.weights.post };
    if (replyable.length) weights.reply = p.weights.reply * (priority.length ? 3 : 1);
    if (replyable.length) weights.quote = p.weights.quote;
    if (likeable.length) weights.like = p.weights.like;
    if (repostable.length) weights.repost = p.weights.repost;
    if (o.followCandidates.length) weights.follow = p.weights.follow * (a.following.size < 3 ? 5 : 1);
    if (o.unread.length) weights.mark_read = p.weights.mark_read * (o.unread.length > 5 ? 2 : 0.5);

    const action = weightedPick(weights) ?? 'post';
    const byLikes = <T extends Shown>(xs: T[]) =>
      // Bias toward popular posts, but keep it random.
      xs.length ? xs.reduce((best, s) => (Math.random() * (s.post.counts.likes + 1) > Math.random() * (best.post.counts.likes + 1) ? s : best)) : undefined;

    switch (action) {
      case 'reply': {
        const target = (priority.length && Math.random() < 0.8 ? pick(priority) : pick(replyable)).post;
        return { action: 'reply', target, text: this.writer.reply(p, target) };
      }
      case 'quote': {
        const target = byLikes(replyable)!.post;
        return { action: 'quote', target, text: this.writer.quote(p, target) };
      }
      case 'like':
        return { action: 'like', target: byLikes(likeable)!.post };
      case 'repost':
        return { action: 'repost', target: byLikes(repostable)!.post };
      case 'follow':
        return { action: 'follow', handle: pick(o.followCandidates) };
      case 'mark_read':
        return { action: 'mark_read' };
      default:
        return { action: 'post', text: this.writer.post(p) };
    }
  }

  private async llmPlan(a: SimAgent, o: Awaited<ReturnType<Simulator['observe']>>): Promise<Plan | null> {
    if (!this.llm?.enabled) return null;
    const all = [...o.shown.values()];
    // Unread items aimed at us first, then the rest; at most 30 posts of context.
    all.sort((x, y) => Number(y.priority) - Number(x.priority));
    const shownList = all.slice(0, 30);
    const shownIds = new Map(shownList.map((s) => [s.post.id, s]));

    const allowed: LlmAction[] = ['post', 'skip'];
    const replyable = shownList.filter((s) => this.replyable(a, s));
    if (replyable.length) allowed.push('reply', 'quote');
    if (shownList.some((s) => !s.post.viewer?.liked)) allowed.push('like');
    if (shownList.some((s) => !s.post.viewer?.reposted)) allowed.push('repost');
    if (o.followCandidates.length) allowed.push('follow');

    const notes: string[] = [];
    const prio = replyable.filter((s) => s.priority).length;
    if (prio) notes.push(`${prio} unread post(s) reply to, mention or quote you (source reply_to_you/mention/quote_of_you). Prefer answering them.`);
    const capped = shownList.filter((s) => !this.replyable(a, s) && s.post.author.handle !== a.handle).map((s) => s.post.id);
    if (capped.length) notes.push(`Do not reply to these ids (thread limit reached or already answered): ${capped.slice(0, 15).join(', ')}`);
    if (a.following.size < 3) notes.push('You follow very few agents; following someone interesting is a good idea.');
    if (a.persona.welcomer) {
      const unwelcomed = [...new Set(shownList.map((s) => s.post.author.handle))].filter((h) => !a.welcomed.has(h));
      if (unwelcomed.length) notes.push(`Not yet welcomed: ${unwelcomed.slice(0, 10).map((h) => '@' + h).join(' ')}`);
    }

    const feed: FeedEntry[] = shownList.map((s) => ({
      id: s.post.id,
      author: s.post.author.handle,
      text: s.post.text,
      source: s.source,
      likes: s.post.counts.likes,
      replies: s.post.counts.replies,
      you_liked: !!s.post.viewer?.liked,
      you_reposted: !!s.post.viewer?.reposted,
      is_reply: !!s.post.reply_to_id,
    }));

    const res = await this.llm.decide({
      persona: a.persona,
      feed,
      followCandidates: o.followCandidates,
      allowed,
      recentOwnPosts: a.recentPosts,
      notes,
    });
    if (res.kind === 'refusal') {
      log(a, `model refused (category ${res.category ?? 'none'}); falling back to a template post`);
      bump('llm_refusal_fallback');
      return { action: 'post', text: this.writer.post(a.persona), fromTemplate: true };
    }
    if (res.kind !== 'ok') return null;

    // Validate everything the model chose. Anything off -> template fallback.
    const d = res.decision;
    const invalid = (why: string): null => {
      log(a, `invalid model decision (${why}); using templates`);
      bump('llm_invalid');
      return null;
    };
    if (!allowed.includes(d.action)) return invalid(`action ${d.action} not allowed`);
    const text = d.text?.trim() ?? '';
    const needText = d.action === 'post' || d.action === 'reply' || d.action === 'quote';
    if (needText) {
      if (!text) return invalid('empty text');
      if (graphemeLength(text) > 280) return invalid('text over 280 characters');
      if (/axk_[A-Za-z0-9_-]{8,}/.test(text)) return invalid('text looks like it contains a key');
      if (a.recentPosts.includes(text)) return invalid('duplicate of a recent post');
    }
    let target: Shown | undefined;
    if (d.action === 'reply' || d.action === 'quote' || d.action === 'like' || d.action === 'repost') {
      if (!d.target_post_id || !ID_RE.test(d.target_post_id)) return invalid('missing/bad target_post_id');
      target = shownIds.get(d.target_post_id);
      if (!target) return invalid(`target ${d.target_post_id} was not shown`);
      if (d.action === 'reply' && !this.replyable(a, target)) return invalid('reply target is capped');
    }
    switch (d.action) {
      case 'post':
        return { action: 'post', text };
      case 'reply':
        return { action: 'reply', target: target!.post, text };
      case 'quote':
        return { action: 'quote', target: target!.post, text };
      case 'like':
        return target!.post.viewer?.liked ? invalid('already liked') : { action: 'like', target: target!.post };
      case 'repost':
        return target!.post.viewer?.reposted ? invalid('already reposted') : { action: 'repost', target: target!.post };
      case 'follow': {
        const h = d.handle_to_follow?.trim().replace(/^@/, '').toLowerCase() ?? '';
        if (!HANDLE_RE.test(h) || !o.followCandidates.includes(h)) return invalid(`follow target ${JSON.stringify(h).slice(0, 30)}`);
        return { action: 'follow', handle: h };
      }
      case 'skip':
        return { action: 'skip', why: 'model chose to skip' };
    }
  }

  private rememberPost(a: SimAgent, text: string) {
    a.recentPosts.unshift(text);
    if (a.recentPosts.length > 10) a.recentPosts.pop();
  }

  private async execute(a: SimAgent, plan: Plan, via: string, retry = true): Promise<void> {
    const sig = this.signal;
    const tag = via === 'llm' ? ' (llm)' : '';
    try {
      switch (plan.action) {
        case 'post': {
          const { post } = await this.client.createPost(a.key, { text: clampPost(plan.text) }, sig);
          this.rememberPost(a, post.text);
          log(a, `posted #${post.id} "${preview(post.text)}"${tag}`);
          break;
        }
        case 'reply': {
          const { post } = await this.client.createPost(a.key, { text: clampPost(plan.text), reply_to_id: plan.target.id }, sig);
          a.repliedTo.add(plan.target.id);
          const root = rootOf(plan.target);
          a.repliesPerRoot.set(root, (a.repliesPerRoot.get(root) ?? 0) + 1);
          if (a.persona.welcomer && !a.welcomed.has(plan.target.author.handle)) {
            a.welcomed.add(plan.target.author.handle);
            const stored = this.state.get(a.persona.handle);
            if (stored) this.state.set({ ...stored, welcomed: [...a.welcomed].slice(-500) });
          }
          this.rememberPost(a, post.text);
          log(a, `replied #${post.id} -> #${plan.target.id} (@${plan.target.author.handle}) "${preview(post.text)}"${tag}`);
          break;
        }
        case 'quote': {
          const { post } = await this.client.createPost(a.key, { text: clampPost(plan.text), quote_of_id: plan.target.id }, sig);
          this.rememberPost(a, post.text);
          log(a, `quoted #${plan.target.id} (@${plan.target.author.handle}) as #${post.id} "${preview(post.text)}"${tag}`);
          break;
        }
        case 'like': {
          const r = await this.client.like(a.key, plan.target.id, sig);
          log(a, `liked #${plan.target.id} (@${plan.target.author.handle})${r.changed ? '' : ' (already)'}${tag}`);
          break;
        }
        case 'repost': {
          const r = await this.client.repost(a.key, plan.target.id, sig);
          log(a, `reposted #${plan.target.id} (@${plan.target.author.handle})${r.changed ? '' : ' (already)'}${tag}`);
          break;
        }
        case 'follow': {
          const r = await this.client.follow(a.key, plan.handle, sig);
          a.following.add(plan.handle);
          log(a, `followed @${plan.handle}${r.changed ? '' : ' (already)'}${tag}`);
          break;
        }
        case 'mark_read':
          await this.client.markNotificationsRead(a.key, undefined, sig);
          log(a, `marked notifications read`);
          break;
        case 'skip':
          log(a, `skipped (${plan.why})`);
          break;
      }
      bump(plan.action);
      a.actions++;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.code === 'aborted') return;
      bump(`error_${err.status}`);
      if (err.status === 401) {
        a.disabled = 'API key rejected (401)';
        log(a, `ERROR: API key rejected (401). It was revoked or rotated; remove "${a.persona.handle}" from ${this.state.file} to re-create. Stopping this agent.`);
      } else if (err.status === 403) {
        log(a, `forbidden: ${err.message}`);
        if (/suspend/i.test(err.message)) a.disabled = 'suspended';
      } else if (err.status === 409 && retry && (plan.action === 'post' || plan.action === 'reply' || plan.action === 'quote')) {
        // Duplicate text: write something else from templates.
        const p = a.persona;
        const again: Plan =
          plan.action === 'post'
            ? { action: 'post', text: this.writer.post(p) }
            : plan.action === 'reply'
              ? { action: 'reply', target: plan.target, text: this.writer.reply(p, plan.target) }
              : { action: 'quote', target: plan.target, text: this.writer.quote(p, plan.target) };
        return this.execute(a, again, 'tpl', false);
      } else if (err.status === 429) {
        const wait = err.retryAfterMs ?? 60_000;
        a.cooldownUntil = Date.now() + wait;
        log(a, `rate limited (${err.message}); cooling down ${Math.round(wait / 1000)}s`);
      } else if (err.status === 404) {
        log(a, `target gone (${plan.action}): ${err.message}`);
      } else {
        log(a, `${plan.action} failed: ${err.message}`);
      }
    }
  }

  private async tick(a: SimAgent) {
    if (Date.now() < a.cooldownUntil) {
      log(a, 'cooling down; skipping this turn');
      return;
    }
    let o: Awaited<ReturnType<Simulator['observe']>>;
    try {
      o = await this.observe(a);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'aborted') return;
      if (err instanceof ApiError && err.status === 401) {
        a.disabled = 'API key rejected (401)';
        log(a, `ERROR: API key rejected (401) while reading. Remove "${a.persona.handle}" from ${this.state.file} to re-create. Stopping this agent.`);
        return;
      }
      bump('read_error');
      log(a, `read failed: ${(err as Error).message}`);
      return;
    }
    if (this.signal.aborted) return;

    let plan: Plan | null = null;
    let via = 'tpl';
    if (this.llm?.enabled) {
      plan = await this.llmPlan(a, o);
      if (plan) via = plan.action === 'post' && plan.fromTemplate ? 'tpl' : 'llm';
    }
    plan ??= this.templatePlan(a, o);
    if (this.signal.aborted) return;
    await this.execute(a, plan, via);

    // LLM mode never picks mark_read itself; tidy up the inbox now and then.
    if (via === 'llm' && o.unread.length && Math.random() < 0.3 && !this.signal.aborted) {
      await this.execute(a, { action: 'mark_read' }, via);
    }
  }

  private async runAgent(a: SimAgent) {
    const mean = this.cfg.paceSeconds * a.persona.pace * 1000;
    // Stagger start so agents don't move in lockstep.
    await sleep(Math.random() * Math.min(mean, this.cfg.rounds ? 5_000 : mean), this.signal);
    let round = 0;
    while (!this.signal.aborted && !a.disabled) {
      await this.tick(a);
      round++;
      if (this.cfg.rounds && round >= this.cfg.rounds) break;
      // Jittered: uniform in [0.5, 1.5] x mean.
      await sleep(mean * (0.5 + Math.random()), this.signal);
    }
  }

  async run() {
    await this.bootstrap();
    if (!this.agents.length) {
      console.error('[sim] no usable agents; nothing to do');
      process.exitCode = 1;
      return;
    }
    const mode = this.llm?.enabled ? `llm (${this.cfg.model})` : 'templates';
    console.log(
      `[sim] ${this.agents.length} agents, mode ${mode}, pace ~${this.cfg.paceSeconds}s, ` +
        `budget ${this.cfg.writesPerMinute} writes/min and ${this.cfg.requestsPerMinute} req/min, ` +
        `${this.cfg.rounds ? `${this.cfg.rounds} round(s)` : 'until stopped'}; API ${this.cfg.apiBase}`,
    );
    await Promise.all(this.agents.map((a) => this.runAgent(a)));
  }

  summary() {
    const s = this.client.stats;
    console.log(
      `[sim] done. actions ${JSON.stringify(counts)}; http requests ${s.requests} (writes ${s.writes}), ` +
        `429s ${s.status429}, 5xx ${s.status5xx}, network errors ${s.networkErrors}`,
    );
    if (this.llm && this.llm.stats.calls) {
      const l = this.llm.stats;
      console.log(
        `[llm] calls ${l.calls}, ok ${l.ok}, refusals ${l.refusals}, errors ${l.errors}; tokens in ${l.inputTokens} ` +
          `(cache read ${l.cacheReadTokens}, cache write ${l.cacheWriteTokens}), out ${l.outputTokens}`,
      );
    }
  }
}

async function main() {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`[sim] ${(err as Error).message}`);
    process.exit(2);
  }
  const sim = new Simulator(cfg);
  let signals = 0;
  const onSignal = (sig: string) => {
    signals++;
    if (signals > 1) {
      console.log(`[sim] second ${sig}, exiting now`);
      process.exit(130);
    }
    console.log(`[sim] ${sig} received, finishing in-flight actions...`);
    sim.stop();
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  try {
    await sim.run();
  } catch (err) {
    if (!sim.signal.aborted) {
      console.error(`[sim] fatal: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  } finally {
    sim.summary();
  }
}

await main();
