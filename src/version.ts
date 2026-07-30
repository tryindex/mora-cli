import { createRequire } from 'node:module';

const requirePackage = createRequire(import.meta.url);
const pkg = requirePackage('../package.json') as { name: string; version: string };

export const PACKAGE_NAME = pkg.name;
export const CLI_VERSION = pkg.version;

/**
 * Compare two dotted version strings. Returns negative when `a` is older than
 * `b`, zero when equal, positive when `a` is newer. Pre-release and build
 * suffixes are ignored: Mora only ships plain `x.y.z` versions today.
 */
export function compareSemver(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parse(version: string): number[] {
  const core = version.trim().split(/[-+]/, 1)[0] ?? '';
  return core.split('.').map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
}
