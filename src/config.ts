import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { collectEnvVars } from './env.js';
import { ExitCode, MoraError } from './errors.js';
import { CONFIG_FILENAME, normalizeRelative } from './scaffold.js';

export const SUPPORTED_CONFIG_VERSION = 1;

export interface DuckDbConnectionConfig {
  name: string;
  type: 'duckdb';
  supported: true;
  /** `:memory:` or a path to a .duckdb file, resolved against the project root. */
  database: string;
  /** Absolute directory that relative table paths resolve from. */
  workingDirectory: string;
}

/**
 * A connection Mora understands well enough to report on, but cannot open. Only
 * DuckDB has an implementation today; the rest exist in `mora.yaml` as
 * placeholders so a project can declare its intent.
 */
export interface UnsupportedConnectionConfig {
  name: string;
  type: string;
  supported: false;
}

export type ConnectionConfig = DuckDbConnectionConfig | UnsupportedConnectionConfig;

export interface MoraConfig {
  /** Absolute project root, the directory holding mora.yaml. */
  root: string;
  projectName: string;
  /** Models directory, relative to the root, with forward slashes. */
  modelsDir: string;
  connections: ConnectionConfig[];
  defaultConnection: string | undefined;
  /** Environment variables the config expects, from every `${VAR}` reference. */
  requiredEnvVars: string[];
}

export async function loadConfig(root: string): Promise<MoraConfig> {
  const absoluteRoot = path.resolve(root);
  const configPath = path.join(absoluteRoot, CONFIG_FILENAME);

  if (!existsSync(configPath)) {
    throw new MoraError(`No ${CONFIG_FILENAME} found in ${absoluteRoot}.`, {
      code: 'config-not-found',
      hint: `Run \`mora init\` to scaffold a project, or pass the directory that holds ${CONFIG_FILENAME}.`,
    });
  }

  const contents = await readFile(configPath, 'utf8');
  return parseConfig(contents, absoluteRoot);
}

export function parseConfig(contents: string, root: string): MoraConfig {
  let raw: unknown;
  try {
    raw = parseYaml(contents);
  } catch (error) {
    throw invalidConfig(`it is not valid YAML: ${message(error)}`);
  }

  const document = asRecord(raw);
  if (!document) {
    throw invalidConfig('the top level must be a mapping of keys to values.');
  }

  assertVersion(document.version);

  const project = asRecord(document.project);
  if (!project) {
    throw invalidConfig('it needs a `project:` block.');
  }

  return {
    root,
    projectName: readProjectName(project.name, root),
    modelsDir: readModelsDir(project.models),
    connections: readConnections(document.connections, root),
    defaultConnection: readDefaultConnection(document.connections),
    requiredEnvVars: collectEnvVars(document),
  };
}

/**
 * The connection to compile against. Prefers the project default so a model
 * that names no connection behaves the same way Mora reports it.
 */
export function resolveDuckDbConnection(config: MoraConfig): DuckDbConnectionConfig | undefined {
  const duckdb = config.connections.filter(isDuckDbConnection);
  const preferred = duckdb.find((connection) => connection.name === config.defaultConnection);
  return preferred ?? duckdb[0];
}

export function isDuckDbConnection(
  connection: ConnectionConfig,
): connection is DuckDbConnectionConfig {
  return connection.supported;
}

function assertVersion(value: unknown): void {
  if (value === undefined || value === null) return;
  if (value !== SUPPORTED_CONFIG_VERSION) {
    throw invalidConfig(
      `version ${JSON.stringify(value)} is not supported (expected ${SUPPORTED_CONFIG_VERSION}).`,
    );
  }
}

function readProjectName(value: unknown, root: string): string {
  if (value === undefined || value === null) return path.basename(root);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidConfig('`project.name` must be a non-empty string.');
  }
  return value.trim();
}

function readModelsDir(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidConfig('`project.models` must be a non-empty string naming the models directory.');
  }
  const normalized = normalizeRelative(value.trim());
  if (
    normalized.length === 0 ||
    path.isAbsolute(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw invalidConfig(`\`project.models\` must stay inside the project: "${value}".`);
  }
  return normalized;
}

function readDefaultConnection(value: unknown): string | undefined {
  const connections = asRecord(value);
  if (!connections) return undefined;
  const name = connections.default;
  if (name === undefined || name === null) return undefined;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw invalidConfig('`connections.default` must name one of the declared connections.');
  }
  return name.trim();
}

function readConnections(value: unknown, root: string): ConnectionConfig[] {
  if (value === undefined || value === null) return [];
  const connections = asRecord(value);
  if (!connections) {
    throw invalidConfig('`connections:` must be a mapping of connection names to settings.');
  }

  const parsed: ConnectionConfig[] = [];
  for (const [name, settings] of Object.entries(connections)) {
    if (name === 'default') continue;
    parsed.push(readConnection(name, settings, root));
  }
  return parsed;
}

function readConnection(name: string, value: unknown, root: string): ConnectionConfig {
  const settings = asRecord(value);
  if (!settings) {
    throw invalidConfig(`connection \`${name}\` must be a mapping of settings.`);
  }

  const type = settings.type;
  if (typeof type !== 'string' || type.trim().length === 0) {
    throw invalidConfig(`connection \`${name}\` needs a \`type\`.`);
  }

  if (type.trim() !== 'duckdb') {
    return { name, type: type.trim(), supported: false };
  }

  return {
    name,
    type: 'duckdb',
    supported: true,
    database: readDuckDbDatabase(name, settings.database, root),
    workingDirectory: readWorkingDirectory(name, settings.working_directory, root),
  };
}

function readDuckDbDatabase(name: string, value: unknown, root: string): string {
  if (value === undefined || value === null) return ':memory:';
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidConfig(`connection \`${name}\` has an invalid \`database\`.`);
  }
  const database = value.trim();
  return database === ':memory:' ? database : path.resolve(root, database);
}

function readWorkingDirectory(name: string, value: unknown, root: string): string {
  if (value === undefined || value === null) return root;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidConfig(`connection \`${name}\` has an invalid \`working_directory\`.`);
  }
  return path.resolve(root, value.trim());
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function invalidConfig(detail: string): MoraError {
  return new MoraError(`${CONFIG_FILENAME} is invalid: ${detail}`, {
    code: 'invalid-config',
    exitCode: ExitCode.failure,
    hint: `Fix ${CONFIG_FILENAME}, or re-run \`mora init --force\` to regenerate it.`,
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
