import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maybeNotifyUpdate } from '../src/update-check.js';

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mora-update-'));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('maybeNotifyUpdate', () => {
  it('prints a nudge when a newer version is available', async () => {
    const cacheDir = await tempDir();
    const lines: string[] = [];

    await maybeNotifyUpdate({
      force: true,
      currentVersion: '0.1.0',
      cacheDir,
      fetchLatest: async () => '0.2.0',
      write: (message) => lines.push(message),
    });

    expect(lines.join('')).toContain('0.1.0 → 0.2.0');
    expect(lines.join('')).toContain('mora upgrade');

    const cached = JSON.parse(await readFile(path.join(cacheDir, 'update-check.json'), 'utf8')) as {
      latestVersion: string;
    };
    expect(cached.latestVersion).toBe('0.2.0');
  });

  it('is silent when already on the latest version', async () => {
    const cacheDir = await tempDir();
    const lines: string[] = [];

    await maybeNotifyUpdate({
      force: true,
      currentVersion: '0.2.0',
      cacheDir,
      fetchLatest: async () => '0.2.0',
      write: (message) => lines.push(message),
    });

    expect(lines).toEqual([]);
  });

  it('reuses a fresh cache instead of fetching again', async () => {
    const cacheDir = await tempDir();
    const lines: string[] = [];
    const fetchLatest = vi.fn(async () => '0.3.0');

    await maybeNotifyUpdate({
      force: true,
      currentVersion: '0.1.0',
      cacheDir,
      fetchLatest,
      write: (message) => lines.push(message),
    });
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    lines.length = 0;
    await maybeNotifyUpdate({
      force: true,
      currentVersion: '0.1.0',
      cacheDir,
      fetchLatest,
      write: (message) => lines.push(message),
    });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(lines.join('')).toContain('0.1.0 → 0.3.0');
  });

  it('is silent under --json, CI, and MORA_NO_UPDATE_CHECK', async () => {
    const cacheDir = await tempDir();
    const lines: string[] = [];
    const fetchLatest = vi.fn(async () => '9.9.9');

    await maybeNotifyUpdate({
      currentVersion: '0.1.0',
      cacheDir,
      json: true,
      fetchLatest,
      write: (message) => lines.push(message),
    });
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(lines).toEqual([]);

    vi.stubEnv('CI', 'true');
    await maybeNotifyUpdate({
      currentVersion: '0.1.0',
      cacheDir,
      fetchLatest,
      write: (message) => lines.push(message),
    });
    expect(fetchLatest).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
    vi.stubEnv('MORA_NO_UPDATE_CHECK', '1');
    await maybeNotifyUpdate({
      currentVersion: '0.1.0',
      cacheDir,
      fetchLatest,
      write: (message) => lines.push(message),
    });
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it('swallows fetch failures', async () => {
    const cacheDir = await tempDir();
    const lines: string[] = [];

    await maybeNotifyUpdate({
      force: true,
      currentVersion: '0.1.0',
      cacheDir,
      fetchLatest: async () => {
        throw new Error('network down');
      },
      write: (message) => lines.push(message),
    });

    expect(lines).toEqual([]);
  });
});
