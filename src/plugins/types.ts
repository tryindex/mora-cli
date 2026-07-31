import type { ScaffoldFile } from '../scaffold.js';

/**
 * What a plugin is told about the project it is being added to. Deliberately
 * small: a plugin that needs more than this is describing a change to Mora
 * itself, not an integration.
 */
export interface PluginContext {
  /** Absolute project root, the directory holding mora.yaml. */
  root: string;
  projectName: string;
  /** Models directory, relative to the root, with forward slashes. */
  modelsDir: string;
}

export interface PluginSetup {
  /**
   * Files the plugin owns. Written through the same machinery as the scaffold,
   * so a plugin gets write strategies and conflict detection for free.
   */
  files: ScaffoldFile[];
  /** Lines to merge into .gitignore, and to strip again on removal. */
  gitignore?: string[];
  /** What the reader should do now that the files exist. */
  nextSteps?: string[];
}

/**
 * An integration a project opts into with `mora plugin add`. Built-in plugins
 * live in this directory; a third-party one is an npm package whose default
 * export is an object of this shape.
 *
 * `setup` must be pure enough to run twice: `mora plugin remove` calls it again
 * to learn which files the plugin owns and what they looked like before anyone
 * edited them. That is why there is no separate teardown to keep in sync.
 */
export interface MoraPlugin {
  /** How the plugin is named on the command line and in mora.yaml. */
  name: string;
  /** One line, shown by `mora plugin list`. */
  description: string;
  setup(context: PluginContext): PluginSetup | Promise<PluginSetup>;
  /** A layout note for the managed block of AGENTS.md. */
  agentsNote?(context: PluginContext): string;
}
