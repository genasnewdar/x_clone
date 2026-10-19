import { randomInt } from 'node:crypto';
import type { Config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createDb, type Sql } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { solve } from '../src/lib/pow.js';

export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef0123456789';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: '127.0.0.1',
    databaseUrl: process.env.TEST_DATABASE_URL ?? 'postgres://agentx:agentx@127.0.0.1:5432/agentx_test',
    databaseSocketDir: undefined,
    dbPoolSize: 10,
    trustProxyHops: 0,
    adminToken: ADMIN_TOKEN,
    powDifficulty: 4,
    migrateOnStart: false,
    webDistDir: undefined,
    publicOrigin: undefined,
    isProduction: true,
    ...overrides,
  };
}

let shared: { sql: Sql } | null = null;

/** One database per test run: wiped and migrated on first use. */
export async function db(): Promise<Sql> {
  if (shared) return shared.sql;
  const sql = createDb(testConfig());
  await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(sql, () => {});
  shared = { sql };
  return sql;
}

export type App = ReturnType<typeof createApp>;

export async function makeApp(overrides: Partial<Config> = {}): Promise<{ app: App; sql: Sql }> {
  const sql = await db();
  const app = createApp({
    sql,
    config: testConfig(overrides),
    log: () => {},
    // Tests choose the TCP peer address with a header the real server never reads.
    peerAddress: (c) => c.req.header('x-test-peer'),
  });
  return { app, sql };
}

export function randomIp(): string {
  return `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
}

let seq = 0;
export function uniqueHandle(prefix = 'a'): string {
  seq++;
  return `${prefix}${Date.now().toString(36).slice(-5)}${seq}`.slice(0, 20).toLowerCase();
}

export interface ReqOpts {
  key?: string;
  body?: unknown;
  rawBody?: string;
  ip?: string;
  headers?: Record<string, string>;
}

export async function req(app: App, method: string, path: string, opts: ReqOpts = {}) {
  const headers: Record<string, string> = { 'x-test-peer': opts.ip ?? '127.0.0.1', ...(opts.headers ?? {}) };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  let body: string | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] ??= 'application/json';
  }
  const res = await app.request(path.startsWith('/') ? path : `/api/v1/${path}`, { method, headers, body });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}

export interface TestAgent {
  id: string;
  handle: string;
  key: string;
  ip: string;
}

export async function register(app: App, handle = uniqueHandle(), ip = randomIp()): Promise<TestAgent> {
  const ch = await req(app, 'POST', 'pow/challenge', { ip });
  if (ch.status !== 201) throw new Error(`challenge failed: ${ch.status} ${ch.text}`);
  const nonce = solve(ch.json.prefix, ch.json.difficulty);
  const r = await req(app, 'POST', 'agents', {
    ip,
    body: { handle, display_name: `Agent ${handle}`, challenge_id: ch.json.challenge_id, nonce },
  });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${r.text}`);
  return { id: r.json.agent.id, handle, key: r.json.api_key, ip };
}

export async function post(app: App, agent: TestAgent, text: string, extra: Record<string, unknown> = {}) {
  return req(app, 'POST', 'posts', { key: agent.key, ip: agent.ip, body: { text, ...extra } });
}
