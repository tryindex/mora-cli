import type { PluginEntry } from '../config.js';
import { publisherPlugin } from './publisher.js';
import type { MoraPlugin, PluginContext } from './types.js';

/**
 * Plugins that ship with the CLI. One place, like `databases.ts`, so the command
 * that adds them, the one that lists them and the docs cannot drift apart.
 */
export const BUILT_IN_PLUGINS: MoraPlugin[] = [publisherPlugin];

export function builtInPlugin(name: string): MoraPlugin | undefined {
  return BUILT_IN_PLUGINS.find((plugin) => plugin.name === name);
}

export function isBuiltInPlugin(name: string): boolean {
  return builtInPlugin(name) !== undefined;
}

/**
 * Layout notes for the managed block of AGENTS.md, in the order the project
 * records its plugins.
 *
 * Only built-in plugins contribute a note. Rendering the docs must not execute
 * third-party code: `mora upgrade` refreshes this block, and an upgrade that
 * imports whatever is in `.mora/plugins/` would run a package the reader did not
 * ask to run. A third-party plugin documents itself through the files it writes.
 */
export function pluginAgentsNotes(plugins: PluginEntry[], context: PluginContext): string[] {
  return plugins
    .map((entry) => builtInPlugin(entry.name)?.agentsNote?.(context))
    .filter((note): note is string => note !== undefined);
}
