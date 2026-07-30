import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { type InitFlags, runInit } from '../src/commands/init.js';
import { runUpgrade, type UpgradeFlags } from '../src/commands/upgrade.js';
import type { MoraError } from '../src/errors.js';
import { MANAGED_BEGIN, MANAGED_END } from '../src/scaffold.js';
import { CLI_VERSION, compareSemver } from '../src/version.js';

function initFlags(overrides: Partial<InitFlags> = {}): InitFlags {
  return { example: true, compile: false, json: true, yes: true, ...overrides };
}

function upgradeFlags(overrides: Partial<UpgradeFlags> = {}): UpgradeFlags {
  return { json: true, yes: true, ...overrides };
}

async function tempDir(prefix = 'mora-upgrade-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function scaffoldedProject(): Promise<string> {
  const root = await tempDir();
  await runInit(root, initFlags({ name: 'retail' }));
  return root;
}

describe('compareSemver', () => {
  it('orders dotted versions', () => {
    expect(compareSemver('0.1.0', '0.2.0')).toBeLessThan(0);
    expect(compareSemver('0.2.0', '0.1.0')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('1.2.3', '1.2.3-beta')).toBe(0);
  });
});

describe('mora upgrade', () => {
  it('stamps cli_version on a fresh scaffold and reports up to date', async () => {
    const root = await scaffoldedProject();
    const config = parseYaml(await readFile(path.join(root, 'mora.yaml'), 'utf8')) as {
      cli_version: string;
    };
    expect(config.cli_version).toBe(CLI_VERSION);

    const check = await runUpgrade(root, upgradeFlags({ check: true }));
    expect(check.ok).toBe(true);
    expect(check.status).toBe('up-to-date');
    expect(check.fromVersion).toBe(CLI_VERSION);
    expect(check.toVersion).toBe(CLI_VERSION);
  });

  it('treats a missing stamp as pending, then writes one', async () => {
    const root = await scaffoldedProject();
    const configPath = path.join(root, 'mora.yaml');
    const original = await readFile(configPath, 'utf8');
    await writeFile(configPath, original.replace(/^cli_version:.*\n/m, ''), 'utf8');

    const check = await runUpgrade(root, upgradeFlags({ check: true }));
    expect(check.ok).toBe(false);
    expect(check.status).toBe('pending');
    expect(check.fromVersion).toBeNull();

    const upgraded = await runUpgrade(root, upgradeFlags());
    expect(upgraded.ok).toBe(true);
    expect(upgraded.status).toBe('up-to-date');
    expect(upgraded.files.some((file) => file.path === 'mora.yaml')).toBe(true);

    const stamped = parseYaml(await readFile(configPath, 'utf8')) as { cli_version: string };
    expect(stamped.cli_version).toBe(CLI_VERSION);
  });

  it('refuses to downgrade when the project stamp is newer', async () => {
    const root = await scaffoldedProject();
    const configPath = path.join(root, 'mora.yaml');
    const original = await readFile(configPath, 'utf8');
    await writeFile(
      configPath,
      original.replace(/^cli_version:.*/m, 'cli_version: 99.0.0'),
      'utf8',
    );

    const check = await runUpgrade(root, upgradeFlags({ check: true }));
    expect(check.ok).toBe(false);
    expect(check.status).toBe('cli-behind');
    expect(check.fromVersion).toBe('99.0.0');

    await expect(runUpgrade(root, upgradeFlags())).rejects.toMatchObject({
      code: 'cli-behind',
    } satisfies Partial<MoraError>);
  });

  it('rewrites Mora-owned docs and the AGENTS.md managed block', async () => {
    const root = await scaffoldedProject();
    const agentsPath = path.join(root, 'AGENTS.md');
    const rule = 'Ask before renaming a measure.';
    const agents = await readFile(agentsPath, 'utf8');
    const start = agents.indexOf(MANAGED_BEGIN);
    const end = agents.indexOf(MANAGED_END);
    // Stale body between the markers, team rule after them.
    await writeFile(
      agentsPath,
      `${agents.slice(0, start)}${MANAGED_BEGIN}\nstale managed body\n${MANAGED_END}${agents.slice(end + MANAGED_END.length)}\n${rule}\n`,
      'utf8',
    );
    await writeFile(path.join(root, '.agents/malloy.md'), 'stale guidance\n', 'utf8');
    await writeFile(path.join(root, '.agents/mora.md'), 'stale commands\n', 'utf8');

    // Make the stamp look older so upgrade has work to do beyond content drift.
    const configPath = path.join(root, 'mora.yaml');
    const original = await readFile(configPath, 'utf8');
    await writeFile(configPath, original.replace(/^cli_version:.*/m, 'cli_version: 0.0.1'), 'utf8');

    const report = await runUpgrade(root, upgradeFlags());
    expect(report.ok).toBe(true);
    expect(report.files.map((file) => file.path).sort()).toEqual([
      '.agents/malloy.md',
      '.agents/mora.md',
      'AGENTS.md',
      'mora.yaml',
    ]);

    await expect(readFile(path.join(root, '.agents/malloy.md'), 'utf8')).resolves.toContain(
      'source:',
    );
    await expect(readFile(path.join(root, '.agents/mora.md'), 'utf8')).resolves.toContain(
      'mora upgrade',
    );

    const updated = await readFile(agentsPath, 'utf8');
    expect(updated).not.toContain('stale managed body');
    expect(updated).toContain('Why this exists');
    expect(updated).toContain(rule);
    expect(updated.indexOf(MANAGED_BEGIN)).toBeLessThan(updated.indexOf(MANAGED_END));
    expect(updated.indexOf(rule)).toBeGreaterThan(updated.indexOf(MANAGED_END));
    expect(updated).toContain('## Team conventions');
  });

  it('preserves comments in mora.yaml when stamping', async () => {
    const root = await scaffoldedProject();
    const configPath = path.join(root, 'mora.yaml');
    const withComment = (await readFile(configPath, 'utf8')).replace(
      /^cli_version:.*/m,
      'cli_version: 0.0.1',
    );
    expect(withComment).toContain('# Mora semantic layer configuration.');
    await writeFile(configPath, withComment, 'utf8');

    await runUpgrade(root, upgradeFlags());

    const updated = await readFile(configPath, 'utf8');
    expect(updated).toContain('# Mora semantic layer configuration.');
    expect(updated).toContain(`cli_version: ${CLI_VERSION}`);
  });

  it('is a no-op when already current', async () => {
    const root = await scaffoldedProject();
    const before = await readFile(path.join(root, 'mora.yaml'), 'utf8');

    const report = await runUpgrade(root, upgradeFlags());
    expect(report.ok).toBe(true);
    expect(report.status).toBe('up-to-date');
    expect(report.files).toEqual([]);
    await expect(readFile(path.join(root, 'mora.yaml'), 'utf8')).resolves.toBe(before);
  });

  it('--check does not write', async () => {
    const root = await scaffoldedProject();
    const configPath = path.join(root, 'mora.yaml');
    const original = await readFile(configPath, 'utf8');
    await writeFile(configPath, original.replace(/^cli_version:.*/m, 'cli_version: 0.0.1'), 'utf8');
    const beforeAgents = await readFile(path.join(root, '.agents/mora.md'), 'utf8');
    await writeFile(path.join(root, '.agents/mora.md'), 'stale\n', 'utf8');

    const check = await runUpgrade(root, upgradeFlags({ check: true }));
    expect(check.ok).toBe(false);
    expect(check.status).toBe('pending');
    expect(check.files).toEqual([]);

    await expect(readFile(configPath, 'utf8')).resolves.toContain('cli_version: 0.0.1');
    await expect(readFile(path.join(root, '.agents/mora.md'), 'utf8')).resolves.toBe('stale\n');
    // Restore so the temp dir is not confusing if reused.
    await writeFile(path.join(root, '.agents/mora.md'), beforeAgents, 'utf8');
  });
});
