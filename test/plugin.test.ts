import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { runInit } from '../src/commands/init.js';
import {
  type PluginRemoveReport,
  runPluginAdd,
  runPluginList,
  runPluginRemove,
} from '../src/commands/plugin.js';
import { loadConfig } from '../src/config.js';
import { ExitCode } from '../src/errors.js';

const MANIFEST = 'metrics/publisher.json';
const SERVER_CONFIG = 'publisher.config.json';

async function project(name = 'analytics'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mora-plugin-'));
  await runInit(root, { example: true, compile: false, json: true, yes: true, name, test: false });
  return root;
}

async function readJson(root: string, file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(root, file), 'utf8'));
}

async function config(root: string): Promise<Record<string, unknown>> {
  return parseYaml(await readFile(path.join(root, 'mora.yaml'), 'utf8')) as Record<string, unknown>;
}

describe('mora plugin add publisher', () => {
  it('writes the files Publisher needs and records the plugin', async () => {
    const root = await project();

    const report = await runPluginAdd(root, 'publisher', { json: true });

    expect(report.ok).toBe(true);
    expect(report.plugin).toEqual({
      name: 'publisher',
      builtIn: true,
      package: null,
      version: null,
    });
    expect(report.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([MANIFEST, SERVER_CONFIG, 'mora.yaml']),
    );

    // The manifest makes the models directory a package; the config says which
    // packages a server should load.
    await expect(readJson(root, MANIFEST)).resolves.toEqual({
      name: 'analytics',
      version: '0.0.1',
      description: expect.stringContaining('analytics'),
    });
    await expect(readJson(root, SERVER_CONFIG)).resolves.toEqual({
      frozenConfig: false,
      environments: [{ name: 'default', packages: [{ name: 'analytics', location: './metrics' }] }],
    });

    await expect(config(root)).resolves.toMatchObject({ plugins: ['publisher'] });
    expect((await loadConfig(root)).plugins).toEqual([
      { name: 'publisher', package: undefined, version: undefined },
    ]);
  });

  it('turns a project name into a package identifier', async () => {
    const root = await project('Retail Analytics');

    await runPluginAdd(root, 'publisher', { json: true });

    await expect(readJson(root, MANIFEST)).resolves.toMatchObject({ name: 'retail-analytics' });
  });

  it('contributes its gitignore lines without disturbing the project’s', async () => {
    const root = await project();

    await runPluginAdd(root, 'publisher', { json: true });

    const lines = (await readFile(path.join(root, '.gitignore'), 'utf8')).split('\n');
    expect(lines).toContain('publisher.db');
    expect(lines).toContain('publisher_data/');
    expect(lines).toContain('.env');
  });

  it('notes itself in the managed block of AGENTS.md, leaving the team section alone', async () => {
    const root = await project();
    const agentsPath = path.join(root, 'AGENTS.md');
    const rule = 'Ask before renaming a measure.';
    await writeFile(agentsPath, `${await readFile(agentsPath, 'utf8')}\n${rule}\n`, 'utf8');

    await runPluginAdd(root, 'publisher', { json: true });

    const agents = await readFile(agentsPath, 'utf8');
    expect(agents).toContain('publisher.config.json');
    expect(agents).toContain(rule);
  });

  it('preserves the comments in mora.yaml', async () => {
    const root = await project();

    await runPluginAdd(root, 'publisher', { json: true });

    const contents = await readFile(path.join(root, 'mora.yaml'), 'utf8');
    expect(contents).toContain('mora connection add');
    expect(contents).toContain('mora plugin add');
  });

  it('is idempotent: a second add changes nothing', async () => {
    const root = await project();
    await runPluginAdd(root, 'publisher', { json: true });
    const before = await readFile(path.join(root, SERVER_CONFIG), 'utf8');

    const report = await runPluginAdd(root, 'publisher', { json: true });

    expect(report.ok).toBe(true);
    expect(report.files).toEqual([]);
    await expect(readFile(path.join(root, SERVER_CONFIG), 'utf8')).resolves.toBe(before);
    // Recorded once, not once per run.
    expect((await loadConfig(root)).plugins).toHaveLength(1);
  });

  it('refuses to overwrite a file it did not write', async () => {
    const root = await project();
    await writeFile(path.join(root, SERVER_CONFIG), '{ "mine": true }\n', 'utf8');

    await expect(runPluginAdd(root, 'publisher', { json: true })).rejects.toMatchObject({
      code: 'files-exist',
      exitCode: ExitCode.conflict,
    });
    // Refused means nothing was written, including the record in mora.yaml.
    expect((await loadConfig(root)).plugins).toEqual([]);
    await expect(readFile(path.join(root, SERVER_CONFIG), 'utf8')).resolves.toBe(
      '{ "mine": true }\n',
    );
  });

  it('keeps an edited file when the plugin is already added, and overwrites under --force', async () => {
    const root = await project();
    await runPluginAdd(root, 'publisher', { json: true });
    const edited = '{ "frozenConfig": true }\n';
    await writeFile(path.join(root, SERVER_CONFIG), edited, 'utf8');

    const kept = await runPluginAdd(root, 'publisher', { json: true });
    expect(kept.files).toContainEqual({ path: SERVER_CONFIG, action: 'kept' });
    await expect(readFile(path.join(root, SERVER_CONFIG), 'utf8')).resolves.toBe(edited);

    const forced = await runPluginAdd(root, 'publisher', { json: true, force: true });
    expect(forced.files).toContainEqual({ path: SERVER_CONFIG, action: 'overwritten' });
    await expect(readFile(path.join(root, SERVER_CONFIG), 'utf8')).resolves.not.toBe(edited);
  });

  it('rejects a name that could never be a package, without asking npm', async () => {
    const root = await project();

    await expect(runPluginAdd(root, 'Not A Plugin!', { json: true })).rejects.toMatchObject({
      code: 'invalid-plugin-name',
      exitCode: ExitCode.usage,
    });
  });
});

describe('mora plugin remove', () => {
  async function added(): Promise<string> {
    const root = await project();
    await runPluginAdd(root, 'publisher', { json: true });
    return root;
  }

  function actionFor(report: PluginRemoveReport, file: string): string | undefined {
    return report.files.find((entry) => entry.path === file)?.action;
  }

  it('deletes the files, unrecords the plugin and strips its gitignore lines', async () => {
    const root = await added();

    const report = await runPluginRemove(root, 'publisher', { json: true, yes: true });

    expect(report.ok).toBe(true);
    expect(actionFor(report, MANIFEST)).toBe('deleted');
    expect(actionFor(report, SERVER_CONFIG)).toBe('deleted');
    expect(existsSync(path.join(root, SERVER_CONFIG))).toBe(false);
    expect(existsSync(path.join(root, MANIFEST))).toBe(false);

    expect((await loadConfig(root)).plugins).toEqual([]);
    // An empty list says nothing a missing key does not, and the comment that
    // introduced it must not outlive it.
    expect(await config(root)).not.toHaveProperty('plugins');
    const contents = await readFile(path.join(root, 'mora.yaml'), 'utf8');
    expect(contents).not.toContain('mora plugin add');
    // The team's own comments are untouched.
    expect(contents).toContain('mora connection add');

    const lines = (await readFile(path.join(root, '.gitignore'), 'utf8')).split('\n');
    expect(lines).not.toContain('publisher.db');
    expect(lines).not.toContain('publisher_data/');
    // Everything else in the file survives.
    expect(lines).toContain('.env');
    expect(lines).toContain('.mora/');

    // And the note is gone from AGENTS.md.
    await expect(readFile(path.join(root, 'AGENTS.md'), 'utf8')).resolves.not.toContain(
      'publisher.config.json',
    );
  });

  it('leaves the models alone', async () => {
    const root = await added();
    const model = path.join(root, 'metrics/example.malloy');
    const before = await readFile(model, 'utf8');

    await runPluginRemove(root, 'publisher', { json: true, yes: true });

    await expect(readFile(model, 'utf8')).resolves.toBe(before);
  });

  it('refuses an edited file and writes nothing at all', async () => {
    const root = await added();
    const edited = '{ "frozenConfig": true }\n';
    await writeFile(path.join(root, SERVER_CONFIG), edited, 'utf8');

    await expect(
      runPluginRemove(root, 'publisher', { json: true, yes: true }),
    ).rejects.toMatchObject({ code: 'files-modified', exitCode: ExitCode.conflict });

    // Nothing removed: not the untouched file, not the record, not the gitignore.
    await expect(readFile(path.join(root, SERVER_CONFIG), 'utf8')).resolves.toBe(edited);
    expect(existsSync(path.join(root, MANIFEST))).toBe(true);
    expect((await loadConfig(root)).plugins).toHaveLength(1);
    await expect(readFile(path.join(root, '.gitignore'), 'utf8')).resolves.toContain(
      'publisher.db',
    );
  });

  it('deletes an edited file when forced', async () => {
    const root = await added();
    await writeFile(path.join(root, SERVER_CONFIG), '{ "frozenConfig": true }\n', 'utf8');

    const report = await runPluginRemove(root, 'publisher', { json: true, yes: true, force: true });

    expect(actionFor(report, SERVER_CONFIG)).toBe('deleted');
    expect(existsSync(path.join(root, SERVER_CONFIG))).toBe(false);
  });

  it('unrecords without touching files under --keep-files', async () => {
    const root = await added();

    const report = await runPluginRemove(root, 'publisher', {
      json: true,
      yes: true,
      keepFiles: true,
    });

    expect(actionFor(report, SERVER_CONFIG)).toBe('kept-by-flag');
    expect(existsSync(path.join(root, SERVER_CONFIG))).toBe(true);
    expect((await loadConfig(root)).plugins).toEqual([]);
    // The files stay, so their gitignore lines have to stay with them.
    await expect(readFile(path.join(root, '.gitignore'), 'utf8')).resolves.toContain(
      'publisher.db',
    );
    expect(report.nextSteps.some((step) => step.includes('left in place'))).toBe(true);
  });

  it('reports a file that is already gone rather than failing', async () => {
    const root = await added();
    await rm(path.join(root, SERVER_CONFIG));

    const report = await runPluginRemove(root, 'publisher', { json: true, yes: true });

    expect(report.ok).toBe(true);
    expect(actionFor(report, SERVER_CONFIG)).toBe('missing');
    expect(actionFor(report, MANIFEST)).toBe('deleted');
  });

  it('treats a plugin the project never added as bad usage', async () => {
    const root = await project();

    await expect(
      runPluginRemove(root, 'publisher', { json: true, yes: true }),
    ).rejects.toMatchObject({ code: 'plugin-not-added', exitCode: ExitCode.usage });
  });
});

describe('mora plugin list', () => {
  it('shows what Mora offers before anything is added', async () => {
    const root = await project();

    const report = await runPluginList(root, { json: true });

    expect(report.plugins).toEqual([
      {
        name: 'publisher',
        builtIn: true,
        package: null,
        version: null,
        description: expect.stringContaining('Publisher'),
        added: false,
        installed: true,
      },
    ]);
  });

  it('marks a plugin as added once it is', async () => {
    const root = await project();
    await runPluginAdd(root, 'publisher', { json: true });

    const report = await runPluginList(root, { json: true });

    expect(report.plugins[0]).toMatchObject({ name: 'publisher', added: true, installed: true });
  });

  it('reports a third-party plugin recorded by a teammate as not installed here', async () => {
    const root = await project();
    const configPath = path.join(root, 'mora.yaml');
    await writeFile(
      configPath,
      `${await readFile(configPath, 'utf8')}\nplugins:\n  - name: forecast\n    package: mora-plugin-forecast\n    version: 1.2.0\n`,
      'utf8',
    );

    const report = await runPluginList(root, { json: true });

    expect(report.plugins).toContainEqual({
      name: 'forecast',
      builtIn: false,
      package: 'mora-plugin-forecast',
      version: '1.2.0',
      description: null,
      added: true,
      installed: false,
    });
  });
});
