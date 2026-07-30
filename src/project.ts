import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  type DuckDbConnectionConfig,
  loadConfig,
  type MoraConfig,
  resolveDuckDbConnection,
} from './config.js';
import { MoraError } from './errors.js';
import { discoverModels } from './malloy/compile.js';
import { CONFIG_FILENAME } from './scaffold.js';

export interface ProjectContext {
  config: MoraConfig;
  /** The connection models are compiled and queried against. */
  connection: DuckDbConnectionConfig;
  /** Model files, relative to the project root, in a stable order. */
  modelPaths: string[];
}

/**
 * Everything a command needs to touch the models: the config, the connection to
 * run against, and the files to read. Loaded in one place so `validate`,
 * `describe` and `query` all fail the same way on the same problems.
 */
export async function openProject(directory: string): Promise<ProjectContext> {
  const config = await loadConfig(path.resolve(process.cwd(), directory));
  return {
    config,
    connection: requireDuckDbConnection(config),
    modelPaths: await requireModels(config),
  };
}

export function requireDuckDbConnection(config: MoraConfig): DuckDbConnectionConfig {
  const connection = resolveDuckDbConnection(config);
  if (!connection) {
    throw new MoraError(`No DuckDB connection is declared in ${CONFIG_FILENAME}.`, {
      code: 'no-supported-connection',
      hint: 'Mora can only run against DuckDB today, so a project needs one DuckDB connection.',
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
