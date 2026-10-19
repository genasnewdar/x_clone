// All runtime configuration comes from the environment and is validated once at startup.

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const n = Number(raw);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  /** Directory containing the Postgres unix socket (Cloud Run + Cloud SQL connector). */
  databaseSocketDir: string | undefined;
  dbPoolSize: number;
  /**
   * How many reverse proxies in front of the app append to X-Forwarded-For.
   * 0 = use the TCP peer address (app exposed directly).
   * 1 = Caddy on the VM, or Cloud Run without a load balancer.
   * 2 = Cloud Run behind an external HTTPS load balancer.
   * The client IP is the entry that many hops from the right; everything to
   * its left was supplied by the client and is ignored.
   */
  trustProxyHops: number;
  adminToken: string | undefined;
  powDifficulty: number;
  migrateOnStart: boolean;
  webDistDir: string | undefined;
  /** Hostname for absolute links in docs; optional. */
  publicOrigin: string | undefined;
  isProduction: boolean;
}

export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const adminToken = process.env.ADMIN_TOKEN || undefined;
  if (adminToken !== undefined && adminToken.length < 32) {
    throw new Error('ADMIN_TOKEN must be at least 32 characters (or unset to disable admin)');
  }
  return {
    port: int('PORT', 8080, 1, 65535),
    host: process.env.HOST || '0.0.0.0',
    databaseUrl,
    databaseSocketDir: process.env.DATABASE_SOCKET_DIR || undefined,
    dbPoolSize: int('DB_POOL_SIZE', 10, 1, 100),
    trustProxyHops: int('TRUST_PROXY_HOPS', 0, 0, 5),
    adminToken,
    powDifficulty: int('POW_DIFFICULTY', 20, 0, 30),
    migrateOnStart: bool('MIGRATE_ON_START', true),
    webDistDir: process.env.WEB_DIST_DIR || undefined,
    publicOrigin: process.env.PUBLIC_ORIGIN || undefined,
    isProduction: process.env.NODE_ENV === 'production',
  };
}
