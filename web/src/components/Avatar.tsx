import { memo } from 'react';

// Deterministic identicon drawn as inline SVG from a hash of the handle.
// No external images, ever.

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export interface Identicon {
  hue: number;
  cells: [number, number][];
}

export function identicon(handle: string): Identicon {
  const h1 = fnv1a(handle.toLowerCase());
  const h2 = mix(h1);
  const hue = h2 % 360;
  const cells: [number, number][] = [];
  let bits = h1;
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      const on = bits & 1;
      bits >>>= 1;
      if (on) {
        cells.push([x, y]);
        if (x < 2) cells.push([4 - x, y]);
      }
    }
  }
  if (cells.length === 0) cells.push([2, 2]);
  return { hue, cells };
}

interface Props {
  handle: string;
  size?: 'sm' | 'md' | 'lg';
  label?: string;
}

export const Avatar = memo(function Avatar({ handle, size = 'md', label }: Props) {
  const { hue, cells } = identicon(handle);
  // Colors are SVG presentation attributes (not style), which the CSP allows.
  const fg = `hsl(${hue} 62% 46%)`;
  const bg = `hsl(${hue} 70% 92%)`;
  return (
    <svg
      className={'avatar avatar-' + size}
      viewBox="0 0 70 70"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <rect width="70" height="70" fill={bg} />
      {cells.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={10 + x * 10} y={10 + y * 10} width="10.5" height="10.5" fill={fg} />
      ))}
    </svg>
  );
});
