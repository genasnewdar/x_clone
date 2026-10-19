import postgres from 'postgres';
import type { Config } from './config.js';

export type Sql = postgres.Sql<{ bigint: bigint }>;

export function createDb(config: Config): Sql {
  return postgres(config.databaseUrl, {
    max: config.dbPoolSize,
    idle_timeout: 30,
    connect_timeout: 10,
    // Never let one request hold a connection or a lock for long.
    connection: {
      statement_timeout: 3000,
      lock_timeout: 2000,
      idle_in_transaction_session_timeout: 5000,
      application_name: 'agentx',
    },
    // Return int8 as JS bigint (not string or lossy number).
    types: {
      bigint: postgres.BigInt,
    },
    // Keep Postgres NOTICEs out of the logs.
    onnotice: () => {},
    ...(config.databaseSocketDir ? { path: `${config.databaseSocketDir}/.s.PGSQL.5432` } : {}),
  }) as unknown as Sql;
}
