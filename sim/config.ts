// Runtime configuration, read once from the environment and the command line.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface Config {
  /** Origin plus "/api/v1", without a trailing slash. */
  apiBase: string;
  adminToken: string | null;
  stateFile: string;
  paceSeconds: number;
  writesPerMinute: number;
  requestsPerMinute: number;
  once: boolean;
  rounds: number | null;
  templates: boolean;
  model: string;
  agentFilter: string[] | null;
  agentLimit: number | null;
  llmConcurrency: number;
  verbose: boolean;
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number between ${min} and ${max} (got ${JSON.stringify(raw)})`);
  }
  return n;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Normalizes AGENTX_BASE_URL and refuses plain http to a remote host unless ALLOW_INSECURE=1. */
export function resolveApiBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`AGENTX_BASE_URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('AGENTX_BASE_URL must be http(s)');
  }
  if (url.username || url.password) throw new Error('AGENTX_BASE_URL must not contain credentials');
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname) && process.env.ALLOW_INSECURE !== '1') {
    throw new Error(
      `Refusing to send API keys over plain http to ${url.hostname}. Use https, or set ALLOW_INSECURE=1 if you really mean it.`,
    );
  }
  let p = url.pathname.replace(/\/+$/, '');
  if (p.endsWith('/api/v1')) p = p.slice(0, -'/api/v1'.length);
  return `${url.origin}${p}/api/v1`;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  let once = false;
  let rounds: number | null = null;
  let templates = process.env.SIM_TEMPLATES === '1';
  let verbose = process.env.SIM_VERBOSE === '1';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--once') once = true;
    else if (a === '--templates') templates = true;
    else if (a === '--verbose' || a === '-v') verbose = true;
    else if (a === '--rounds') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1) throw new Error('--rounds needs a positive integer');
      rounds = n;
    } else if (a.startsWith('--rounds=')) {
      const n = Number(a.slice('--rounds='.length));
      if (!Number.isInteger(n) || n < 1) throw new Error('--rounds needs a positive integer');
      rounds = n;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: tsx sim.ts [--once | --rounds N] [--templates] [--verbose]\nSee README.md for environment variables.');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (once) rounds = 1;

  const filterRaw = process.env.SIM_AGENTS?.trim();
  let agentFilter: string[] | null = null;
  let agentLimit: number | null = null;
  if (filterRaw) {
    if (/^\d+$/.test(filterRaw)) agentLimit = Number(filterRaw);
    else agentFilter = filterRaw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  const stateFile = process.env.SIM_STATE_FILE
    ? path.resolve(process.env.SIM_STATE_FILE)
    : path.join(here, '.agents.json');

  return {
    apiBase: resolveApiBase(process.env.AGENTX_BASE_URL ?? 'http://127.0.0.1:8090'),
    adminToken: process.env.ADMIN_TOKEN?.trim() || null,
    stateFile,
    paceSeconds: num('SIM_PACE_SECONDS', 45, 1, 86_400),
    writesPerMinute: num('SIM_WRITES_PER_MIN', 8, 0.1, 600),
    requestsPerMinute: num('SIM_REQUESTS_PER_MIN', 60, 1, 6000),
    once,
    rounds,
    templates,
    model: process.env.SIM_MODEL?.trim() || 'claude-opus-5-5',
    agentFilter,
    agentLimit,
    llmConcurrency: num('SIM_LLM_CONCURRENCY', 2, 1, 32),
    verbose,
  };
}
