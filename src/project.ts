import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  loadConfig,
  type MoraConfig,
  resolveDefaultConnection,
  type SupportedConnectionConfig,
  supportedConnections,
} from './config.js';
import { MoraError } from './errors.js';
import { discoverModels } from './malloy/compile.js';
import { CONFIG_FILENAME } from './scaffold.js';

export interface ProjectContext {
  config: MoraConfig;
  /**
   * Every connection models may read from. A model names the connection it
   * wants, so they are all made available rather than one being chosen here.
   */
  connections: SupportedConnectionConfig[];
  /** The connection a model that names none compiles against. */
  defaultConnection: SupportedConnectionConfig;
  /** Model files, relative to the project root, in a stable order. */
  modelPaths: string[];
}

/**
 * Everything a command needs to touch the models: the config, the connections to
 * run against, and the files to read. Loaded in one place so `validate`,
 * `describe` and `query` all fail the same way on the same problems.
 */
export async function openProject(directory: string): Promise<ProjectContext> {
  const config = await loadConfig(path.resolve(process.cwd(), directory));
  return {
    config,
    connections: supportedConnections(config),
    defaultConnection: requireConnection(config),
    modelPaths: await requireModels(config),
  };
}

export function requireConnection(config: MoraConfig): SupportedConnectionConfig {
  const connection = resolveDefaultConnection(config);
  if (!connection) {
    throw new MoraError(`No usable connection is declared in ${CONFIG_FILENAME}.`, {
      code: 'no-supported-connection',
      hint: 'Run `mora connection add` to declare one, or check the `type` of the connections already there.',
    });
  }
  return connection;
}

export async function requireModels(config: MoraConfig): Promise<string[]> {
  const modelsRoot = path.join(config.root, config.modelsDir);
  if (!existsSync(modelsRoot)) {
    throw new MoraError(`The models directory ${config.modelsDir}/ does not exist.`, {
      code: 'models-dir-not-found',
      hint: `Create it, or point \`project.models\` in ${CONFIG_FILENAME} at the right directory.`,
    });
  }
  return discoverModels(config.root, config.modelsDir);
}
