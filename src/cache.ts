/**
 * The local cache of warehouse tables, and the only module that imports
 * `@moradata/cache`.
 *
 * Everything here is a translation between Mora's idea of a project — a
 * `mora.yaml`, connections with `${VAR}` credentials, a models directory — and
 * the cache package's core API, which takes explicit paths and connections
 * somebody else opened. Keeping the seam in one file is what lets the rest of
 * the CLI treat "reading the cache" as just another runtime.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Connection } from '@malloydata/malloy';
import type { MoraConfig, SupportedConnectionConfig } from './config.js';
import { supportedConnections } from './config.js';
import { ExitCode, MoraError } from './errors.js';
import { openConnections, openDuckDb } from './malloy/runtime.js';

/**
 * Where the cache lives, by convention rather than configuration. `.mora/` is
 * already gitignored by the scaffold, which matters more than the name: the
 * cache holds warehouse data, and a project that commits it has leaked exactly
 * what this is for.
 */
export const CACHE_DIR = '.mora/cache';

/** Absolute cache directory for a project. */
export function cacheDirectory(config: MoraConfig): string {
  return path.join(config.root, CACHE_DIR);
}

/** Whether anything has been synced yet. Cheap: one `existsSync`. */
export function cacheExists(config: MoraConfig): boolean {
  return existsSync(path.join(cacheDirectory(config), 'cache.duckdb'));
}

/**
 * The cache package, loaded lazily. It pulls in DuckDB, and `mora --help` must
 * not pay for that any more than it pays for the drivers.
 */
async function loadCache() {
  const module = await import('@moradata/cache');
  return (module as { default?: typeof module }).default ?? module;
}

export interface CachedSummary {
  table: string;
  connection: string;
  rows: number;
  /** True when the extract stopped at the row limit rather than at the table's end. */
  capped: boolean;
  syncedAt: string;
  /** How long ago that was, in words a reader can judge at a glance. */
  age: string;
  /** Set when the path cannot be reproduced locally, so `--local` will not find it. */
  pathNote: string | null;
}

/**
 * What the cache holds, sorted by table so a report reads the same way twice.
 * Empty rather than an error when nothing has been synced: "nothing yet" is a
 * state worth reporting, not a failure.
 */
export async function summarizeCache(config: MoraConfig): Promise<CachedSummary[]> {
  const cache = await loadCache();
  const manifest = await cache.readManifest(cacheDirectory(config));

  return manifest.tables
    .map((table) => ({
      table: table.table,
      connection: table.connection,
      rows: table.rows,
      capped: table.capped,
      syncedAt: table.syncedAt,
      age: cache.describeAge(table.syncedAt),
      pathNote: table.pathNote ?? null,
    }))
    .sort((a, b) => a.table.localeCompare(b.table));
}

export interface SyncRequest {
  config: MoraConfig;
  /** Table paths to cache beyond the ones models reference. */
  tables?: readonly string[];
  /** Only sync this connection's tables, when given. */
  connectionName?: string;
  /** Rows per table to stop at. */
  limit: number;
  onProgress?: (message: string) => void;
}

export interface SyncedTableOutcome {
  table: string;
  connection: string;
  status: 'synced' | 'failed';
  rows: number;
  capped: boolean;
  /** Columns left out because the cache cannot store them faithfully. */
  skippedColumns: string[];
  error: string | null;
}

export interface SyncOutcome {
  tables: SyncedTableOutcome[];
  /** Models that did not compile, so any table only they name is not cached. */
  modelFailures: { model: string; error: string }[];
  /** Models the table list was derived from, relative to the project root. */
  models: string[];
  /** Oldest table in the cache afterwards, as an ISO instant, or null. */
  syncedAt: string | null;
  rows: number;
}

/**
 * Pulls every table the models read into the cache.
 *
 * Tables are grouped by the connection that owns them and each group is synced
 * against its own warehouse, because a project can read several and a model
 * names the one it wants. The catalog is rebuilt once at the end from the whole
 * manifest, so it describes the cache rather than this run.
 */
export async function syncCache(request: SyncRequest): Promise<SyncOutcome> {
  const cache = await loadCache();
  const { config } = request;
  const cacheDir = cacheDirectory(config);

  const usable = selectConnections(config, request.connectionName);
  const { opened, close } = await openConnections(usable, config.root);

  try {
    const derived = await cache.deriveTables({
      root: config.root,
      modelsDir: config.modelsDir,
      connections: opened,
      defaultConnectionName: defaultNameFor(config, usable),
    });

    const planned = withNamedTables(cache, derived.tables, request.tables ?? [], usable);
    if (planned.length === 0) {
      return {
        tables: [],
        modelFailures: derived.failures,
        models: derived.models,
        syncedAt: null,
        rows: 0,
      };
    }

    // One DuckDB to write every Parquet file. It is a writer, not a warehouse:
    // nothing is read through it.
    const writer = await openDuckDb('mora_cache_writer', ':memory:', cacheDir);
    const outcomes: SyncedTableOutcome[] = [];
    let manifest = await cache.readManifest(cacheDir);

    try {
      for (const [connectionName, tables] of groupByConnection(planned)) {
        const source = opened.get(connectionName);
        if (!source) continue;

        const result = await cache.syncTables({
          cacheDir,
          tables,
          source,
          writer,
          limit: request.limit,
          onProgress: (outcome, index, total) =>
            request.onProgress?.(`[${index + 1}/${total}] ${outcome.table}`),
        });

        manifest = result.manifest;
        for (const outcome of result.outcomes) {
          outcomes.push({
            table: outcome.table,
            connection: connectionName,
            status: outcome.status,
            rows: outcome.status === 'synced' ? outcome.rows : 0,
            capped: outcome.status === 'synced' ? outcome.capped : false,
            skippedColumns: outcome.status === 'synced' ? outcome.skippedColumns : [],
            error: outcome.status === 'failed' ? outcome.error : null,
          });
        }
      }

      request.onProgress?.('Building the local catalog');
      await cache.buildCatalog({
        cacheDir,
        manifest,
        openWriter: (database) => openDuckDb('mora_cache_writer', database, cacheDir),
      });
    } finally {
      await writer.close().catch(() => undefined);
    }

    return {
      tables: outcomes,
      modelFailures: derived.failures,
      models: derived.models,
      syncedAt: cache.oldestSyncedAt(manifest.tables),
      rows: outcomes.reduce((total, outcome) => total + outcome.rows, 0),
    };
  } finally {
    await close();
  }
}

type CacheModule = Awaited<ReturnType<typeof loadCache>>;
type TableRef = Parameters<CacheModule['syncTables']>[0]['tables'][number];

/**
 * The derived tables plus any named outright. A name given on the command line
 * has never been through Malloy's translator, so it is canonicalised against
 * the dialect it belongs to rather than pasted into SQL as typed.
 */
function withNamedTables(
  cache: CacheModule,
  derived: readonly TableRef[],
  named: readonly string[],
  connections: readonly SupportedConnectionConfig[],
): TableRef[] {
  const tables = [...derived];
  const seen = new Set(tables.map((table) => `${table.connection}\u0000${table.table}`));
  const target = connections[0];

  for (const raw of named) {
    const table = raw.trim();
    if (table.length === 0 || !target) continue;
    const key = `${target.name}\u0000${table}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tables.push({
      table,
      canonical: cache.canonicalizeTablePath(table, target.type),
      connection: target.name,
      models: [],
    });
  }

  return tables;
}

function groupByConnection(tables: readonly TableRef[]): Map<string, TableRef[]> {
  const grouped = new Map<string, TableRef[]>();
  for (const table of tables) {
    const existing = grouped.get(table.connection);
    if (existing) existing.push(table);
    else grouped.set(table.connection, [table]);
  }
  return grouped;
}

export interface LocalCache {
  /**
   * A DuckDB connection per declared connection name, each over the same local
   * catalog. Handed to a runtime as `openedConnections`, this is what lets a
   * model run unchanged: `warehouse.table('analytics.orders')` resolves against
   * a view of the same name, so the substitution happens under the table paths
   * rather than in them.
   */
  connections: ReadonlyMap<string, Connection>;
  /** Oldest table in the cache, as an ISO instant, or null when it is empty. */
  syncedAt: string | null;
  /** Tables that stopped at the row limit, so counts over them are not the real ones. */
  capped: string[];
  close: () => Promise<void>;
}

/** The cache, opened for reading. Callers must `close()`. */
export async function openLocalCache(config: MoraConfig): Promise<LocalCache> {
  const cache = await loadCache();
  const cacheDir = cacheDirectory(config);
  const names = supportedConnections(config).map((connection) => connection.name);

  const opened = await cache.openCache({
    cacheDir,
    connectionNames: names,
    openReader: (name, database) => openDuckDb(name, database, cacheDir),
  });

  return {
    connections: opened.connections,
    syncedAt: cache.oldestSyncedAt(opened.manifest.tables),
    capped: opened.manifest.tables.filter((table) => table.capped).map((table) => table.table),
    close: () => opened.close(),
  };
}

/**
 * Refuses when there is no cache to read, naming the command that makes one.
 * Called before `--local` does anything, so the reader gets this rather than a
 * DuckDB error about a file that is not there.
 */
export function requireCache(config: MoraConfig): void {
  if (cacheExists(config)) return;
  throw new MoraError('There is no local cache to read.', {
    code: 'cache-not-found',
    exitCode: ExitCode.failure,
    hint: 'Run `mora sync` to build one, or drop --local to read the warehouse.',
  });
}

function selectConnections(
  config: MoraConfig,
  name: string | undefined,
): SupportedConnectionConfig[] {
  const usable = supportedConnections(config);
  if (usable.length === 0) {
    throw new MoraError('No usable connection is declared in mora.yaml.', {
      code: 'no-supported-connection',
      hint: 'Run `mora connection add` to declare one.',
    });
  }
  if (name === undefined) return usable;

  const found = config.connections.find((connection) => connection.name === name);
  if (!found) {
    throw new MoraError(`No connection called "${name}" in mora.yaml.`, {
      code: 'unknown-connection',
      exitCode: ExitCode.usage,
      hint: `Declared: ${config.connections.map((entry) => entry.name).join(', ') || 'none'}.`,
    });
  }
  if (!found.supported) {
    throw new MoraError(`Mora has no driver for ${found.type} connections.`, {
      code: 'unsupported-connection',
      hint: 'It can open duckdb, postgres and bigquery connections.',
    });
  }
  return [found];
}

function defaultNameFor(
  config: MoraConfig,
  usable: readonly SupportedConnectionConfig[],
): string | undefined {
  const declared = usable.find((connection) => connection.name === config.defaultConnection);
  return (declared ?? usable[0])?.name;
}
