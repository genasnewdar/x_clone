import { isIP } from 'node:net';

// Resolves the client address and turns it into a rate-limit bucket.
//
// X-Forwarded-For is a comma-separated list where each proxy APPENDS the
// address it received the request from. Only the right-most `hops` entries
// were written by infrastructure we trust; anything to their left was sent
// by the client and is attacker-controlled. With hops = 1 (Caddy, or Cloud
// Run's front end) the client is the last entry.

export function resolveClientIp(xff: string | undefined, peer: string | undefined, hops: number): string {
  if (hops > 0 && xff) {
    // Bound the work an attacker can cause with a huge header.
    const parts = xff.slice(-2048).split(',').map((p) => p.trim()).filter(Boolean);
    const candidate = parts[parts.length - hops];
    if (candidate) {
      const ip = stripPort(candidate);
      if (isIP(ip)) return canonical(ip);
    }
  }
  if (peer && isIP(peer)) return canonical(peer);
  return 'unknown';
}

function stripPort(s: string): string {
  // [v6]:port
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  if (bracket) return bracket[1]!;
  // v4:port
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
  if (v4port) return v4port[1]!;
  return s;
}

function canonical(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped ? mapped[1]! : ip.toLowerCase();
}

/**
 * Rate-limit bucket for an address. IPv6 is bucketed by /64, since anyone
 * holding a single IPv6 subnet controls 2^64 addresses.
 */
export function ipBucket(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const groups = expandV6(ip);
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : ip;
}

function expandV6(ip: string): string[] | null {
  const noZone = ip.split('%')[0]!;
  const [head, tail] = noZone.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  if (t.some((g) => g.includes('.')) || h.some((g) => g.includes('.'))) return null;
  const missing = 8 - h.length - t.length;
  if (noZone.includes('::') ? missing < 0 : h.length !== 8) return null;
  const all = [...h, ...Array(Math.max(missing, 0)).fill('0'), ...t];
  return all.map((g) => g.padStart(4, '0').toLowerCase());
}
