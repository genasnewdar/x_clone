import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Sql } from './db.js';

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
// Arbitrary constant; serializes migrations across concurrently starting instances.
const LOCK_KEY = 4_242_001;

export async function migrate(sql: Sql, log: (msg: string) => void = console.log): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  await sql.begin(async (tx) => {
    // Migrations may legitimately take longer than the request timeout.
    await tx`SET LOCAL statement_timeout = 0`;
    await tx`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const done = new Set((await tx<{ name: string }[]>`SELECT name FROM schema_migrations`).map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
      log(`migrated ${file}`);
    }
  });
}

// `node dist/migrate.js` runs migrations and exits.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { loadConfig } = await import('./config.js');
  const { createDb } = await import('./db.js');
  const sql = createDb(loadConfig());
  try {
    await migrate(sql);
  } finally {
    await sql.end();
  }
}
