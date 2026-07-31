import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { collectEnvVars } from './env.js';
import { ExitCode, MoraError } from './errors.js';
import { CONFIG_FILENAME, normalizeRelative } from './scaffold.js';

export const SUPPORTED_CONFIG_VERSION = 1;

interface ConnectionConfigBase {
  name: string;
  /**
   * Environment variables this connection's settings refer to. Kept per
   * connection so a missing credential can name the connection it blocks
   * rather than the whole project.
   */
  requiredEnvVars: string[];
}

export interface DuckDbConnectionConfig extends ConnectionConfigBase {
  type: 'duckdb';
  supported: true;
  /** `:memory:` or a path to a .duckdb file, resolved against the project root. */
  database: string;
  /** Absolute directory that relative table paths resolve from. */
  workingDirectory: string;
}

/**
 * Settings are kept as written, `${VAR}` references and all. They are resolved
 * when the connection is opened, so reading a config never depends on which
 * credentials happen to be set.
 */
export interface BigQueryConnectionConfig extends ConnectionConfigBase {
  type: 'bigquery';
  supported: true;
  projectId?: string;
  /** Project queries are billed to, when it differs from the one being read. */
  billingProjectId?: string;
  location?: string;
  /** Service account key file, for when Application Default Credentials are not enough. */
  serviceAccountKeyPath?: string;
}

/**
 * A connection Mora understands well enough to report on, but cannot open. These
 * exist in `mora.yaml` as placeholders so a project can declare its intent
 * before Mora has a driver for it.
 */
export interface UnsupportedConnectionConfig extends ConnectionConfigBase {
  type: string;
  supported: false;
}

/** A connection Mora has a driver for, and can compile and query against. */
export type SupportedConnectionConfig = DuckDbConnectionConfig | BigQueryConnectionConfig;

export type ConnectionConfig = SupportedConnectionConfig | UnsupportedConnectionConfig;

export interface MoraConfig {
  /** Absolute project root, the directory holding mora.yaml. */
  root: string;
  /** Config schema version (`version:` in mora.yaml). */
  version: number;
  projectName: string;
  /** Models directory, relative to the root, with forward slashes. */
  modelsDir: string;
  connections: ConnectionConfig[];
  /** `project.default_connection`: what a model naming no connection reads from. */
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

  const version = readVersion(document.version);

  const project = asRecord(document.project);
  if (!project) {
    throw invalidConfig('it needs a `project:` block.');
  }

  return {
    root,
    version,
    projectName: readProjectName(project.name, root),
    modelsDir: readModelsDir(project.models),
    connections: readConnections(document.connections, root),
    defaultConnection: readDefaultConnection(project.default_connection),
    requiredEnvVars: collectEnvVars(document),
  };
}

/**
 * Every connection Mora has a driver for, in declaration order. Models can name
 * any of them, so they are all opened together rather than one being singled out.
 */
export function supportedConnections(config: MoraConfig): SupportedConnectionConfig[] {
  return config.connections.filter(isSupportedConnection);
}

/**
 * The connection a model with no explicit name compiles against: the declared
 * default when it is usable, otherwise the first one that is.
 */
export function resolveDefaultConnection(
  config: MoraConfig,
): SupportedConnectionConfig | undefined {
  const usable = supportedConnections(config);
  const preferred = usable.find((connection) => connection.name === config.defaultConnection);
  return preferred ?? usable[0];
}

export function isSupportedConnection(
  connection: ConnectionConfig,
): connection is SupportedConnectionConfig {
  return connection.supported;
}

export function isDuckDbConnection(
  connection: ConnectionConfig,
): connection is DuckDbConnectionConfig {
  return connection.supported && connection.type === 'duckdb';
}

function readVersion(value: unknown): number {
  if (value === undefined || value === null) return SUPPORTED_CONFIG_VERSION;
  if (value !== SUPPORTED_CONFIG_VERSION) {
    throw invalidConfig(
      `version ${JSON.stringify(value)} is not supported (expected ${SUPPORTED_CONFIG_VERSION}).`,
    );
  }
  return SUPPORTED_CONFIG_VERSION;
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
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidConfig('`project.default_connection` must name one of the declared connections.');
  }
  return value.trim();
}

function readConnections(value: unknown, root: string): ConnectionConfig[] {
  if (value === undefined || value === null) return [];
  const connections = asRecord(value);
  if (!connections) {
    throw invalidConfig('`connections:` must be a mapping of connection names to settings.');
  }

  const parsed: ConnectionConfig[] = [];
  for (const [name, settings] of Object.entries(connections)) {
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

  const requiredEnvVars = collectEnvVars(settings);

  switch (type.trim()) {
    case 'duckdb':
      return {
        name,
        type: 'duckdb',
        supported: true,
        requiredEnvVars,
        database: readDuckDbDatabase(name, settings.database, root),
        workingDirectory: readWorkingDirectory(name, settings.working_directory, root),
      };
    case 'bigquery':
      return {
        name,
        type: 'bigquery',
        supported: true,
        requiredEnvVars,
        // Paths and ids are kept verbatim: a `${VAR}` reference is not a path
        // until it has been resolved, and resolving belongs to opening.
        projectId: readOptionalSetting(name, 'project_id', settings.project_id),
        billingProjectId: readOptionalSetting(
          name,
          'billing_project_id',
          settings.billing_project_id,
        ),
        location: readOptionalSetting(name, 'location', settings.location),
        serviceAccountKeyPath: readOptionalSetting(
          name,
          'service_account_key_path',
          settings.service_account_key_path,
        ),
      };
    default:
      return { name, type: type.trim(), supported: false, requiredEnvVars };
  }
}

function readOptionalSetting(connection: string, key: string, value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidConfig(`connection \`${connection}\` has an invalid \`${key}\`.`);
  }
  return value.trim();
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
