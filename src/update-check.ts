import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import pc from 'picocolors';
import { CLI_VERSION, compareSemver, PACKAGE_NAME } from './version.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

interface CacheFile {
  checkedAt: number;
  latestVersion: string;
}

export interface UpdateCheckOptions {
  /** Suppress when the command printed --json (agents must not see noise). */
  json?: boolean;
  /** Override for tests. */
  currentVersion?: string;
  /** Override cache directory for tests. */
  cacheDir?: string;
  /** Override fetch for tests. */
  fetchLatest?: () => Promise<string | undefined>;
  /** Override stderr writer for tests. */
  write?: (message: string) => void;
  /** Skip TTY/CI/json gates — for tests only. */
  force?: boolean;
}

/**
 * Optionally nudges that a newer Mora is on npm. Failures are silent: a
 * registry blip must never break a command that already succeeded.
 */
export async function maybeNotifyUpdate(options: UpdateCheckOptions = {}): Promise<void> {
  if (!options.force && !shouldCheck(options)) return;

  const currentVersion = options.currentVersion ?? CLI_VERSION;
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const write = options.write ?? ((message) => process.stderr.write(message));

  try {
    const latest =
      (await readCachedLatest(cacheDir)) ??
      (await fetchAndCache(cacheDir, options.fetchLatest ?? fetchLatestFromNpm));
    if (!latest) return;
    if (compareSemver(latest, currentVersion) <= 0) return;

    write(
      pc.dim(
        `Update available: Mora ${currentVersion} → ${latest}. ` +
          `Run \`npm i -g ${PACKAGE_NAME}@latest\`, then \`mora upgrade\` in each project.\n`,
      ),
    );
  } catch {
    // Network, cache, or parse failures must not surface.
  }
}

function shouldCheck(options: UpdateCheckOptions): boolean {
  if (options.json) return false;
  if (process.env.MORA_NO_UPDATE_CHECK) return false;
  if (process.env.CI) return false;
  if (!process.stdout.isTTY || !process.stderr.isTTY) return false;
  return true;
}

function defaultCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME ?? path.join(homedir(), '.cache');
  return path.join(base, 'mora');
}

async function readCachedLatest(cacheDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(cachePath(cacheDir), 'utf8');
    const cached = JSON.parse(raw) as CacheFile;
    if (
      typeof cached.checkedAt !== 'number' ||
      typeof cached.latestVersion !== 'string' ||
      Date.now() - cached.checkedAt > CACHE_TTL_MS
    ) {
      return undefined;
    }
    return cached.latestVersion;
  } catch {
    return undefined;
  }
}

async function fetchAndCache(
  cacheDir: string,
  fetchLatest: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const latest = await fetchLatest();
  if (!latest) return undefined;
  await mkdir(cacheDir, { recursive: true });
  const payload: CacheFile = { checkedAt: Date.now(), latestVersion: latest };
  await writeFile(cachePath(cacheDir), `${JSON.stringify(payload)}\n`, 'utf8');
  return latest;
}

async function fetchLatestFromNpm(): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : undefined;
  } finally {
    clearTimeout(timer);
  }
}

function cachePath(cacheDir: string): string {
  return path.join(cacheDir, 'update-check.json');
}
