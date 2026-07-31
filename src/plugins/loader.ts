import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ExitCode, MoraError } from '../errors.js';
import { BUILT_IN_PLUGINS, isBuiltInPlugin } from './registry.js';
import type { MoraPlugin } from './types.js';

const run = promisify(execFile);

/** Third-party plugins live here, per checkout, and the directory is gitignored. */
export const PLUGIN_INSTALL_DIR = path.join('.mora', 'plugins');

const PLUGIN_PACKAGE_PREFIX = 'mora-plugin-';

/** A name that can also be an npm package name, since that is what it becomes. */
const PLUGIN_NAME_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export function assertPluginName(name: string): void {
  if (PLUGIN_NAME_PATTERN.test(name)) return;
  throw new MoraError(`"${name}" cannot be a plugin name.`, {
    code: 'invalid-plugin-name',
    exitCode: ExitCode.usage,
    hint: `A plugin name is also an npm package name, so it is lowercase letters, digits, dots and dashes. Mora ships with: ${BUILT_IN_PLUGINS.map((plugin) => plugin.name).join(', ')}.`,
  });
}

/**
 * The npm package a plugin name refers to. A short name is expanded to the
 * conventional prefix, so `mora plugin add forecast` finds
 * `mora-plugin-forecast`, while a scoped or already-prefixed name is taken as
 * written.
 */
export function pluginPackageName(name: string): string {
  if (name.startsWith('@') || name.includes('/') || name.startsWith(PLUGIN_PACKAGE_PREFIX)) {
    return name;
  }
  return `${PLUGIN_PACKAGE_PREFIX}${name}`;
}

export function installedPluginDir(root: string, packageName: string): string {
  return path.join(root, PLUGIN_INSTALL_DIR, 'node_modules', ...packageName.split('/'));
}

export function isPluginInstalled(root: string, packageName: string): boolean {
  return existsSync(path.join(installedPluginDir(root, packageName), 'package.json'));
}

/**
 * Installs a plugin package into the project's own plugin directory. Kept out of
 * the project's `node_modules` so adding a plugin never touches the dependencies
 * a team committed, and out of the CLI's install so two projects can use
 * different versions.
 */
export async function installPlugin(root: string, packageName: string): Promise<void> {
  const target = path.join(root, PLUGIN_INSTALL_DIR);
  await mkdir(target, { recursive: true });

  // A manifest of our own stops npm walking up to the project's package.json and
  // installing the plugin as one of its dependencies.
  const manifest = path.join(target, 'package.json');
  if (!existsSync(manifest)) {
    await writeFile(
      manifest,
      `${JSON.stringify({ name: 'mora-plugins', private: true, description: 'Plugins installed by `mora plugin add`. Managed by Mora.' }, null, 2)}\n`,
      'utf8',
    );
  }

  try {
    await run('npm', ['install', packageName, '--prefix', target, '--no-audit', '--no-fund'], {
      cwd: root,
    });
  } catch (error) {
    const said = npmMessage(error);
    // A package that does not exist is a name someone got wrong, not a broken
    // tool, and the two need different exit codes to be actionable.
    if (/E404|404 Not Found/.test(said)) {
      throw new MoraError(`There is no plugin package published as "${packageName}".`, {
        code: 'unknown-plugin',
        exitCode: ExitCode.usage,
        hint: `Mora ships with: ${BUILT_IN_PLUGINS.map((plugin) => plugin.name).join(', ')}. A third-party plugin must be published as ${packageName}.`,
      });
    }
    throw new MoraError(`Could not install the plugin package "${packageName}".`, {
      code: 'plugin-install-failed',
      hint: `npm said:\n${said}`,
    });
  }
}

export async function uninstallPlugin(root: string, packageName: string): Promise<void> {
  const target = path.join(root, PLUGIN_INSTALL_DIR);
  if (!existsSync(path.join(target, 'package.json'))) return;

  try {
    await run('npm', ['uninstall', packageName, '--prefix', target, '--no-audit', '--no-fund'], {
      cwd: root,
    });
  } catch (error) {
    throw new MoraError(`Could not uninstall the plugin package "${packageName}".`, {
      code: 'plugin-uninstall-failed',
      hint: `npm said:\n${npmMessage(error)}`,
    });
  }
}

/** The version npm actually installed, for the record kept in mora.yaml. */
export async function installedPluginVersion(
  root: string,
  packageName: string,
): Promise<string | undefined> {
  try {
    const manifest = await readFile(
      path.join(installedPluginDir(root, packageName), 'package.json'),
      'utf8',
    );
    const version = (JSON.parse(manifest) as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Imports an installed plugin package. This executes third-party code, so it
 * only ever happens because someone named the plugin on the command line.
 */
export async function loadInstalledPlugin(
  root: string,
  packageName: string,
): Promise<MoraPlugin | undefined> {
  const directory = installedPluginDir(root, packageName);
  if (!existsSync(path.join(directory, 'package.json'))) return undefined;

  const entry = await resolveEntry(root, directory, packageName);
  let module: unknown;
  try {
    module = await import(pathToFileURL(entry).href);
  } catch (error) {
    throw new MoraError(`The plugin package "${packageName}" could not be loaded.`, {
      code: 'plugin-load-failed',
      hint: `Importing ${entry} failed with:\n${message(error)}`,
    });
  }

  return assertPlugin(exported(module), packageName);
}

/**
 * The module a package should be imported from. `require.resolve` handles the
 * common cases; the fallback covers an ESM-only package whose entry point is
 * declared under `exports` and therefore invisible to it.
 */
async function resolveEntry(root: string, directory: string, packageName: string): Promise<string> {
  try {
    const resolve = createRequire(path.join(root, PLUGIN_INSTALL_DIR, 'package.json'));
    return resolve.resolve(packageName);
  } catch {
    // Fall through to the manifest.
  }

  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as {
    exports?: unknown;
    module?: unknown;
    main?: unknown;
  };

  const candidate =
    exportPath(manifest.exports) ??
    (typeof manifest.module === 'string' ? manifest.module : undefined) ??
    (typeof manifest.main === 'string' ? manifest.main : undefined) ??
    'index.js';

  return path.join(directory, candidate);
}

function exportPath(exports: unknown): string | undefined {
  if (typeof exports === 'string') return exports;
  if (typeof exports !== 'object' || exports === null) return undefined;

  const record = exports as Record<string, unknown>;
  const root = record['.'] ?? record;
  if (typeof root === 'string') return root;
  if (typeof root !== 'object' || root === null) return undefined;

  const conditions = root as Record<string, unknown>;
  for (const key of ['import', 'module', 'default', 'require']) {
    const value = conditions[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function exported(module: unknown): unknown {
  const record = module as Record<string, unknown> | null;
  if (record === null || typeof record !== 'object') return module;
  return record.default ?? record.plugin ?? record;
}

/**
 * A plugin is executed against a team's repository, so what a package exports is
 * checked before it is trusted rather than after it has half-written a project.
 */
export function assertPlugin(value: unknown, packageName: string): MoraPlugin {
  const candidate = value as Partial<MoraPlugin> | null;

  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof candidate.setup !== 'function'
  ) {
    throw invalidPlugin(packageName, 'it does not export a plugin with a `setup` function');
  }
  if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0) {
    throw invalidPlugin(packageName, 'the plugin has no `name`');
  }
  if (typeof candidate.description !== 'string' || candidate.description.trim().length === 0) {
    throw invalidPlugin(packageName, `plugin "${candidate.name}" has no \`description\``);
  }
  if (isBuiltInPlugin(candidate.name)) {
    throw invalidPlugin(
      packageName,
      `it claims the name "${candidate.name}", which is a plugin that ships with Mora`,
    );
  }

  return candidate as MoraPlugin;
}

function invalidPlugin(packageName: string, detail: string): MoraError {
  return new MoraError(`"${packageName}" is not a usable Mora plugin: ${detail}.`, {
    code: 'invalid-plugin',
    exitCode: ExitCode.failure,
    hint: 'A plugin package must default-export `{ name, description, setup }`. Report this to whoever publishes it.',
  });
}

function npmMessage(error: unknown): string {
  const details = error as { stderr?: unknown; stdout?: unknown };
  const output = [details?.stderr, details?.stdout]
    .filter((stream): stream is string => typeof stream === 'string' && stream.trim().length > 0)
    .join('\n')
    .trim();
  return output.length > 0 ? output : message(error);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
