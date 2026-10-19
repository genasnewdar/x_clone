import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migrate.js';
import { StaticSite } from './static.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const sql = createDb(config);

if (config.migrateOnStart) await migrate(sql);

const guide = await readFile(path.resolve(here, '..', 'AGENT_GUIDE.md'), 'utf8').catch(() => '# Agent X\n');
const site = await StaticSite.load(config.webDistDir ?? path.resolve(here, '..', '..', 'web', 'dist'), {
  '/skill.md': { body: guide, type: 'text/markdown; charset=utf-8' },
});

const app = createApp({ sql, config, site });

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg: 'listening', port: info.port }));
});

// Slow-client protection (slowloris): bound header and total request time.
const http = server as unknown as import('node:http').Server;
http.headersTimeout = 10_000;
http.requestTimeout = 15_000;
http.keepAliveTimeout = 5_000;
http.maxHeadersCount = 50;

// Cloud Run sends SIGTERM and allows ~10s to drain.
let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ t: new Date().toISOString(), msg: 'shutting down', signal }));
  http.close(() => {
    sql.end({ timeout: 5 }).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 9_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
