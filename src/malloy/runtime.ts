import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Connection, Runtime, TestableConnection } from '@malloydata/malloy';
import type { BigQueryConnectionConfig, SupportedConnectionConfig } from '../config.js';
import { ENV_FILENAME, type EnvLookup, readEnvFile, resolveEnvRefs } from '../env.js';
import { MoraError } from '../errors.js';

export interface RuntimeRequest {
  /** Every connection models may read from, as declared in mora.yaml. */
  connections: readonly SupportedConnectionConfig[];
  /** Connection a model that names none compiles against. */
  defaultConnectionName?: string;
  /** Project root, used to find the `.env` that credentials may come from. */
  root?: string;
}

export interface OpenRuntime {
  ok: true;
  runtime: Runtime;
  close: () => Promise<void>;
}

export interface UnavailableRuntime {
  ok: false;
  /** Why Malloy could not be loaded, in a form worth showing a user. */
  reason: string;
}

/**
 * Malloy and its drivers are loaded lazily. They pull in native and wasm
 * bundles, so paying that cost on every `mora --help` would be wasteful, and a
 * broken install should degrade to a warning rather than take the whole CLI
 * down. BigQuery is loaded only when a project declares one, so a DuckDB
 * project never pays for the Google client libraries.
 */
async function loadMalloy() {
  const malloyModule = await import('@malloydata/malloy');
  return unwrap(malloyModule);
}

async function loadDuckDb() {
  return unwrap(await import('@malloydata/db-duckdb'));
}

async function loadBigQuery() {
  return unwrap(await import('@malloydata/db-bigquery'));
}

/** Malloy's packages ship CommonJS, where the namespace object lands on `default`. */
function unwrap<T>(module: T): T {
  return (module as { default?: T }).default ?? module;
}

/**
 * A runtime over every connection the project declares, shared by each command
 * that compiles or runs Malloy. A model names the connection it reads from, so
 * all of them are registered and Malloy picks per source. Callers must
 * `close()`: connections hold database handles open until they do.
 */
export async function createRuntime(
  request: RuntimeRequest,
): Promise<OpenRuntime | UnavailableRuntime> {
  let malloy: Awaited<ReturnType<typeof loadMalloy>>;
  try {
    malloy = await loadMalloy();
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }

  const lookup = await readEnvLookup(request.root);
  const opened = new Map<string, Connection>();

  try {
    for (const connection of request.connections) {
      opened.set(connection.name, await openConnection(connection, lookup));
    }
  } catch (error) {
    await closeAll(opened);
    throw error;
  }

  const runtime = new malloy.Runtime({
    connections: new malloy.FixedConnectionMap(opened, request.defaultConnectionName),
    urlReader: {
      readURL: async (url: URL) => readFile(url, 'utf8'),
    },
  });

  return { ok: true, runtime, close: () => closeAll(opened) };
}

/**
 * A runtime, or a failure loud enough to stop the command. Commands that read or
 * run models cannot degrade gracefully the way a compile check can: without
 * Malloy there is no answer to give.
 */
export async function openRuntime(request: RuntimeRequest): Promise<OpenRuntime> {
  const opened = await createRuntime(request);
  if (opened.ok) return opened;
  throw new MoraError(`Malloy could not be loaded (${opened.reason}).`, {
    code: 'malloy-unavailable',
    hint: 'Reinstall the CLI, or check that @malloydata/malloy and its database drivers are installed.',
  });
}

/**
 * Opens one connection, hands it over, and closes it again. Used by the commands
 * that talk to a database directly rather than through a model, so they resolve
 * credentials and clean up their handles the same way compiling does.
 */
export async function withConnection<T>(
  connection: SupportedConnectionConfig,
  root: string | undefined,
  use: (opened: Connection) => Promise<T>,
): Promise<T> {
  const lookup = await readEnvLookup(root);
  const opened = await openConnection(connection, lookup);
  try {
    return await use(opened);
  } finally {
    await closeQuietly(opened);
  }
}

/**
 * Opens one connection for a real connectivity check. Used by
 * `mora connection test`, which wants the driver's own verdict rather than
 * whether a model happens to compile.
 */
export async function testConnection(
  connection: SupportedConnectionConfig,
  root?: string,
): Promise<void> {
  await withConnection(connection, root, (opened) => (opened as TestableConnection).test());
}

async function openConnection(
  connection: SupportedConnectionConfig,
  lookup: EnvLookup,
): Promise<Connection> {
  if (connection.type === 'duckdb') {
    const duckdb = await loadDuckDb();
    return new duckdb.DuckDBConnection(
      connection.name,
      connection.database,
      connection.workingDirectory,
    );
  }

  const bigquery = await loadBigQuery();
  const settings = resolveBigQuerySettings(connection, lookup);
  return new bigquery.BigQueryConnection(connection.name, undefined, settings);
}

/**
 * BigQuery settings as the driver was given them. Exported for callers that have
 * to name the project in SQL of their own: an INFORMATION_SCHEMA query must be
 * qualified, and it has to be qualified with the project the connection really
 * opened rather than with whatever is in the environment.
 */
export async function resolveBigQuery(
  connection: BigQueryConnectionConfig,
  root?: string,
): Promise<BigQuerySettings> {
  return resolveBigQuerySettings(connection, await readEnvLookup(root));
}

/** The subset of the driver's options a Mora connection can set. */
export interface BigQuerySettings {
  projectId?: string;
  billingProjectId?: string;
  location?: string;
  serviceAccountKeyPath?: string;
}

/**
 * BigQuery settings with their `${VAR}` references filled in. A reference with
 * no value stops the command: silently connecting to whatever project the
 * ambient credentials point at is worse than refusing.
 */
function resolveBigQuerySettings(
  connection: BigQueryConnectionConfig,
  lookup: EnvLookup,
): BigQuerySettings {
  const missing = new Set<string>();
  const resolve = (setting: string | undefined): string | undefined => {
    const resolved = resolveEnvRefs(setting, lookup);
    for (const name of resolved.missing) missing.add(name);
    return resolved.value;
  };

  const projectId = resolve(connection.projectId);
  const settings = {
    projectId,
    // The driver uses `projectId` only to qualify table names; the project the
    // client authenticates and bills against is this one. Defaulting it to
    // `project_id` is what someone who set only that would expect, and without
    // it the client falls back to guessing from the ambient environment.
    billingProjectId: resolve(connection.billingProjectId) ?? projectId,
    location: resolve(connection.location),
    serviceAccountKeyPath: resolve(connection.serviceAccountKeyPath),
  };

  if (missing.size > 0) {
    const names = [...missing].sort();
    throw new MoraError(
      `Connection "${connection.name}" needs ${names.join(', ')}, which ${
        names.length === 1 ? 'is' : 'are'
      } not set.`,
      {
        code: 'missing-credentials',
        hint: `Set ${names.length === 1 ? 'it' : 'them'} in your environment or in ${ENV_FILENAME}. \`mora init\` creates that file from .env.example.`,
      },
    );
  }

  return settings;
}

async function readEnvLookup(root?: string): Promise<EnvLookup> {
  if (!root) return {};
  return { envFile: await readEnvFile(path.join(root, ENV_FILENAME)) };
}

async function closeAll(connections: Map<string, Connection>): Promise<void> {
  await Promise.all([...connections.values()].map(closeQuietly));
  connections.clear();
}

async function closeQuietly(connection: Connection): Promise<void> {
  await connection.close().catch(() => {
    // A connection we are discarding anyway; a close failure is not news.
  });
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
