import { ExitCode, MoraError } from '../errors.js';
import {
  assertPluginName,
  installedPluginVersion,
  installPlugin,
  isPluginInstalled,
  loadInstalledPlugin,
  pluginPackageName,
} from './loader.js';
import { BUILT_IN_PLUGINS, builtInPlugin } from './registry.js';
import type { MoraPlugin } from './types.js';

export interface ResolvedPlugin {
  plugin: MoraPlugin;
  builtIn: boolean;
  /** The npm package it came from, or undefined for a built-in. */
  package: string | undefined;
  version: string | undefined;
}

/**
 * Finds the plugin a name refers to: a built-in first, then a package in this
 * checkout's plugin directory. `install` says whether a missing package may be
 * fetched, which is only true when someone asked for it by name.
 */
export async function resolvePlugin(
  root: string,
  name: string,
  options: { install: boolean },
): Promise<ResolvedPlugin> {
  assertPluginName(name);

  const built = builtInPlugin(name);
  if (built) {
    return { plugin: built, builtIn: true, package: undefined, version: undefined };
  }

  const packageName = pluginPackageName(name);
  if (!isPluginInstalled(root, packageName)) {
    if (!options.install) {
      throw new MoraError(`The plugin "${name}" is not installed in this checkout.`, {
        code: 'plugin-not-installed',
        exitCode: ExitCode.usage,
        hint: `Run \`mora plugin add ${name}\` to install it from ${packageName}.`,
      });
    }
    await installPlugin(root, packageName);
  }

  const plugin = await loadInstalledPlugin(root, packageName);
  if (!plugin) {
    throw new MoraError(`No plugin called "${name}" could be found.`, {
      code: 'unknown-plugin',
      exitCode: ExitCode.usage,
      hint: `Mora ships with: ${BUILT_IN_PLUGINS.map((entry) => entry.name).join(', ')}. Anything else must be published as an npm package (${packageName}).`,
    });
  }

  return {
    plugin,
    builtIn: false,
    package: packageName,
    version: await installedPluginVersion(root, packageName),
  };
}
