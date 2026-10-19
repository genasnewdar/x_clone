import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// Serves the built web UI from memory.
//
// Every file under the dist directory is read once at startup into a map
// keyed by its URL path. Request paths are only ever used as map keys, never
// joined onto a filesystem path, so path traversal ("../", encoded slashes,
// NUL bytes, symlink tricks) is impossible by construction.

export interface StaticFile {
  body: Buffer;
  type: string;
  cache: string;
  etag?: string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
};

export class StaticSite {
  private constructor(
    private readonly files: Map<string, StaticFile>,
    private readonly index: StaticFile | undefined,
  ) {}

  static async load(dir: string, extra: Record<string, { body: string; type: string }> = {}): Promise<StaticSite> {
    const files = new Map<string, StaticFile>();
    const root = path.resolve(dir);
    const walk = async (d: string) => {
      for (const entry of await readdir(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const type = TYPES[ext];
          if (!type) continue;
          if ((await stat(full)).size > 5 * 1024 * 1024) continue;
          const body = await readFile(full);
          const urlPath = '/' + path.relative(root, full).split(path.sep).join('/');
          // Vite puts content-hashed files under /assets: cache them forever.
          const cache = urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
          files.set(urlPath, { body, type, cache, etag: etag(body) });
        }
      }
    };
    try {
      await walk(root);
    } catch {
      // No built UI (e.g. API-only dev). The API still works.
    }
    for (const [urlPath, f] of Object.entries(extra)) {
      const body = Buffer.from(f.body, 'utf8');
      files.set(urlPath, { body, type: f.type, cache: 'no-cache', etag: etag(body) });
    }
    return new StaticSite(files, files.get('/index.html'));
  }

  lookup(urlPath: string): StaticFile | undefined {
    const exact = this.files.get(urlPath);
    if (exact) return exact;
    // SPA routes (/@handle, /post/123, ...) get index.html; missing assets 404.
    if (!/\.[a-z0-9]+$/i.test(urlPath) && !urlPath.startsWith('/api/')) return this.index;
    return undefined;
  }
}

function etag(body: Buffer): string {
  return `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
}
