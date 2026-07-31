import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../src/commands/init.js';
import { runPluginAdd, runPluginList, runPluginRemove } from '../src/commands/plugin.js';
import { loadConfig } from '../src/config.js';
import { ExitCode } from '../src/errors.js';
import {
  assertPlugin,
  installedPluginVersion,
  installPlugin,
  isPluginInstalled,
  loadInstalledPlugin,
  pluginPackageName,
} from '../src/plugins/loader.js';

const PACKAGE_NAME = 'mora-plugin-fixture';
/** npm reaches the network for a registry name; a path is resolved on disk. */
const NPM_TIMEOUT = 120_000;

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function project(): Promise<string> {
  const root = await tempDir('mora-plugin-3p-');
  await runInit(root, {
    example: true,
    compile: false,
    json: true,
    yes: true,
    name: 'analytics',
    test: false,
  });
  return root;
}

const PLUGIN_MODULE = `export default {
  name: 'fixture',
  description: 'A plugin that exists to be installed by a test',
  setup({ projectName, modelsDir }) {
    return {
      files: [
        {
          path: modelsDir + '/fixture.json',
          strategy: 'replace',
          contents: JSON.stringify({ project: projectName }, null, 2) + '\\n',
        },
      ],
      gitignore: ['fixture-cache/'],
      nextSteps: ['Read the file it just wrote.'],
    };
  },
};
`;

/** A real package on disk, so npm has something to install from a local path. */
async function fixturePackage(module: string): Promise<string> {
  const dir = await tempDir('mora-plugin-pkg-');
  await writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      { name: PACKAGE_NAME, version: '1.2.3', type: 'module', main: 'index.js' },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(path.join(dir, 'index.js'), module, 'utf8');
  return dir;
}

describe('installing a plugin package', () => {
  it(
    'installs into the project, not into its node_modules, and loads what it exports',
    async () => {
      const root = await project();

      await installPlugin(root, `file:${await fixturePackage(PLUGIN_MODULE)}`);

      // npm records it under its real name, which is how Mora refers to it later.
      expect(isPluginInstalled(root, PACKAGE_NAME)).toBe(true);
      await expect(installedPluginVersion(root, PACKAGE_NAME)).resolves.toBe('1.2.3');
      // A plugin must never end up among the dependencies a team committed.
      expect(existsSync(path.join(root, 'node_modules'))).toBe(false);

      const plugin = await loadInstalledPlugin(root, PACKAGE_NAME);
      expect(plugin?.name).toBe('fixture');
      expect(plugin?.description).toContain('installed by a test');
    },
    NPM_TIMEOUT,
  );

  it(
    'reports a package that is not a plugin instead of running it',
    async () => {
      const root = await project();
      const broken = await fixturePackage('export default { name: "broken" };\n');

      await installPlugin(root, `file:${broken}`);

      await expect(loadInstalledPlugin(root, PACKAGE_NAME)).rejects.toMatchObject({
        code: 'invalid-plugin',
      });
    },
    NPM_TIMEOUT,
  );

  it('treats a package that is not installed as absent rather than an error', async () => {
    const root = await project();
    await expect(loadInstalledPlugin(root, PACKAGE_NAME)).resolves.toBeUndefined();
  });
});

describe('a third-party plugin in a project', () => {
  async function withFixtureInstalled(): Promise<string> {
    const root = await project();
    await installPlugin(root, `file:${await fixturePackage(PLUGIN_MODULE)}`);
    return root;
  }

  it(
    'is added by its short name, and recorded with the package it came from',
    async () => {
      const root = await withFixtureInstalled();

      const report = await runPluginAdd(root, 'fixture', { json: true });

      expect(report.ok).toBe(true);
      expect(report.plugin).toEqual({
        name: 'fixture',
        builtIn: false,
        package: PACKAGE_NAME,
        version: '1.2.3',
      });
      await expect(readFile(path.join(root, 'metrics/fixture.json'), 'utf8')).resolves.toContain(
        'analytics',
      );
      expect((await loadConfig(root)).plugins).toEqual([
        { name: 'fixture', package: PACKAGE_NAME, version: '1.2.3' },
      ]);
      expect(report.nextSteps[0]).toBe('Read the file it just wrote.');

      const listed = await runPluginList(root, { json: true });
      expect(listed.plugins).toContainEqual(
        expect.objectContaining({ name: 'fixture', added: true, installed: true }),
      );
    },
    NPM_TIMEOUT,
  );

  it(
    'is removed along with its files, its gitignore lines and its package',
    async () => {
      const root = await withFixtureInstalled();
      await runPluginAdd(root, 'fixture', { json: true });

      const report = await runPluginRemove(root, 'fixture', { json: true, yes: true });

      expect(report.ok).toBe(true);
      expect(report.files).toContainEqual({ path: 'metrics/fixture.json', action: 'deleted' });
      expect(existsSync(path.join(root, 'metrics/fixture.json'))).toBe(false);
      expect((await loadConfig(root)).plugins).toEqual([]);
      await expect(readFile(path.join(root, '.gitignore'), 'utf8')).resolves.not.toContain(
        'fixture-cache/',
      );
      expect(isPluginInstalled(root, PACKAGE_NAME)).toBe(false);
    },
    NPM_TIMEOUT,
  );

  it(
    'writes nothing when the package cannot be installed',
    async () => {
      const root = await project();

      // A name npm cannot resolve is bad usage; a registry it cannot reach is a
      // failure. The test does not care which happened here, only that a plugin
      // Mora could not load leaves no trace of itself.
      await expect(runPluginAdd(root, 'fixture', { json: true })).rejects.toThrowError(
        expect.objectContaining({ name: 'MoraError' }),
      );
      expect((await loadConfig(root)).plugins).toEqual([]);
      expect(existsSync(path.join(root, 'metrics/fixture.json'))).toBe(false);
    },
    NPM_TIMEOUT,
  );
});

describe('plugin package names', () => {
  it('expands a short name to the conventional prefix and leaves others alone', () => {
    expect(pluginPackageName('forecast')).toBe('mora-plugin-forecast');
    expect(pluginPackageName('mora-plugin-forecast')).toBe('mora-plugin-forecast');
    expect(pluginPackageName('@acme/mora-plugin-forecast')).toBe('@acme/mora-plugin-forecast');
  });
});

describe('assertPlugin', () => {
  const valid = { name: 'forecast', description: 'Forecasts', setup: () => ({ files: [] }) };

  it('accepts a well-formed plugin', () => {
    expect(assertPlugin(valid, PACKAGE_NAME)).toBe(valid);
  });

  it.each([
    ['no setup function', { name: 'forecast', description: 'Forecasts' }],
    ['no name', { description: 'Forecasts', setup: () => ({ files: [] }) }],
    ['no description', { name: 'forecast', setup: () => ({ files: [] }) }],
    ['nothing useful at all', 'a string'],
    // A package claiming a built-in name would shadow the plugin Mora ships.
    ['a built-in name', { ...valid, name: 'publisher' }],
  ])('refuses a package with %s', (_reason, value) => {
    expect(() => assertPlugin(value, PACKAGE_NAME)).toThrowError(
      expect.objectContaining({ code: 'invalid-plugin', exitCode: ExitCode.failure }),
    );
  });
});
