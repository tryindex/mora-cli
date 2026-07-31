import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Connection, Explore, Runtime } from '@malloydata/malloy';
import type {
  BigQueryConnectionConfig,
  DuckDbConnectionConfig,
  SupportedConnectionConfig,
} from '../config.js';
import { ExitCode, MoraError } from '../errors.js';
import { describeError, openRuntime, resolveBigQuery, withConnection } from './runtime.js';

export interface TableEntry {
  /** The name as it goes inside `connection.table('...')`, verbatim. */
  name: string;
  /** Schema or dataset holding it, for databases that have them. */
  schema: string | null;
  /** A DuckDB connection reads files as well as registered tables. */
  kind: 'table' | 'view' | 'file';
}

export interface TableList {
  tables: TableEntry[];
  /**
   * True when the listing stopped at a cap rather than at the end of the
   * catalog, so a caller is never told a partial list is the whole warehouse.
   */
  truncated: boolean;
}

export interface ColumnDescription {
  name: string;
  /** Malloy type, which is the type a model written against this will see. */
  type: string;
}

export interface TableSchema {
  /** The name that was asked for, so a caller can match request to answer. */
  name: string;
  columns: ColumnDescription[];
  /** Why this table could not be read, when it could not. */
  error?: string;
}

/**
 * Above this many tables the listing is not worth reading, let alone paging
 * further for. A warehouse with more than this needs `--pattern`, and being told
 * so beats scrolling.
 */
const MAX_TABLES = 500;

/**
 * What a connection can read. This is deliberately not a cached catalog: an
 * agent holds the answer in its own context for as long as it is working, and a
 * copy on disk would only add the one property worth avoiding, namely outliving
 * the warehouse it describes.
 */
export async function listTables(
  connection: SupportedConnectionConfig,
  root: string,
  pattern?: string,
): Promise<TableList> {
  if (connection.type === 'duckdb') {
    return listDuckDbTables(connection, root, pattern);
  }
  return listBigQueryTables(connection, root, pattern);
}

/**
 * Columns and types for the named tables, read by compiling a source for each
 * one. Going through the translator rather than the driver's schema fetch is
 * what makes a table path written the Malloy way (`data/orders.csv`,
 * `dataset.table`) resolve the same here as it will in a model.
 */
export async function describeTables(
  connection: SupportedConnectionConfig,
  root: string,
  tablePaths: readonly string[],
): Promise<TableSchema[]> {
  for (const tablePath of tablePaths) assertTablePath(tablePath);

  const opened = await openRuntime({
    connections: [connection],
    defaultConnectionName: connection.name,
    root,
  });

  try {
    const batched = await compileSources(opened.runtime, connection.name, tablePaths);
    if ('schemas' in batched) return batched.schemas;

    // One unreadable table fails the whole compile, which says nothing about
    // which one it was. Retrying alone is how each name gets its own verdict,
    // and it only happens on the path that already went wrong.
    const schemas: TableSchema[] = [];
    for (const tablePath of tablePaths) {
      const one = await compileSources(opened.runtime, connection.name, [tablePath]);
      schemas.push(
        'schemas' in one
          ? (one.schemas[0] as TableSchema)
          : { name: tablePath, columns: [], error: one.error },
      );
    }
    return schemas;
  } finally {
    await opened.close();
  }
}

/** Prefix for the throwaway sources a schema read compiles. */
const SOURCE_PREFIX = 'mora_schema_';

async function compileSources(
  runtime: Runtime,
  connectionName: string,
  tablePaths: readonly string[],
): Promise<{ schemas: TableSchema[] } | { error: string }> {
  const model = tablePaths
    .map(
      (tablePath, index) =>
        `source: ${SOURCE_PREFIX}${index} is ${connectionName}.table('${tablePath}')`,
    )
    .join('\n');

  try {
    const compiled = await runtime.getModel(model);
    return {
      schemas: tablePaths.map((tablePath, index) => {
        const explore = compiled.explores.find(
          (candidate) => candidate.name === `${SOURCE_PREFIX}${index}`,
        );
        return {
          name: tablePath,
          columns: explore ? columnsOf(explore) : [],
        };
      }),
    };
  } catch (error) {
    return { error: withoutInternalPath(describeError(error)) };
  }
}

/**
 * The sources are compiled from a string, so Malloy attributes its errors to a
 * generated `internal://` URL. That line names nothing a reader can look at.
 */
function withoutInternalPath(message: string): string {
  return message
    .split('\n')
    .filter((line) => !line.startsWith('FILE: internal://'))
    .join('\n');
}

function columnsOf(explore: Explore): ColumnDescription[] {
  const columns: ColumnDescription[] = [];
  for (const field of explore.allFields) {
    if (field.isAtomicField()) columns.push({ name: field.name, type: field.type });
  }
  return columns;
}

/**
 * Characters a table path may contain. Every name `mora schema` lists stays well
 * inside this, so anything outside it is refused rather than escaped: the path
 * is interpolated into Malloy source, and a quote in it was never a table name.
 */
const TABLE_PATH = /^[A-Za-z0-9_.:\-/*][A-Za-z0-9_.:\-/* ]*$/;

function assertTablePath(tablePath: string): void {
  if (TABLE_PATH.test(tablePath)) return;
  throw new MoraError(`"${tablePath}" is not a table path.`, {
    code: 'invalid-table-path',
    exitCode: ExitCode.usage,
    hint: 'Pass a name as `mora schema` lists it, such as `data/orders.csv` or `dataset.table`.',
  });
}

const DATA_FILE_EXTENSIONS = ['.csv', '.tsv', '.parquet', '.json', '.ndjson'];
const SKIPPED_DIRECTORIES = new Set(['node_modules']);
/** Deep enough for `data/2024/orders.csv`, shallow enough to stay quick. */
const MAX_WALK_DEPTH = 4;

/**
 * A DuckDB connection reads two different things, and a listing that showed only
 * one of them would hide the half most Mora projects actually use: files under
 * the working directory, plus whatever a `.duckdb` file has registered.
 */
async function listDuckDbTables(
  connection: DuckDbConnectionConfig,
  root: string,
  pattern?: string,
): Promise<TableList> {
  const entries = await listDataFiles(connection.workingDirectory);

  // `:memory:` has a catalog, but only ever the system schemas, so asking costs
  // a connection and answers nothing.
  if (connection.database !== ':memory:') {
    entries.push(
      ...(await withConnection(connection, root, (opened) => queryDuckDbCatalog(opened))),
    );
  }

  return cap(filterByName(entries, pattern));
}

async function listDataFiles(workingDirectory: string): Promise<TableEntry[]> {
  const found: TableEntry[] = [];

  async function walk(relativeDir: string, depth: number): Promise<void> {
    const absolute = path.join(workingDirectory, relativeDir);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (depth >= MAX_WALK_DEPTH || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await walk(relativePath, depth + 1);
      } else if (
        entry.isFile() &&
        DATA_FILE_EXTENSIONS.some((extension) => entry.name.toLowerCase().endsWith(extension))
      ) {
        found.push({ name: relativePath, schema: null, kind: 'file' });
      }
    }
  }

  await walk('', 0);
  return found;
}

/** Schemas DuckDB keeps for itself, which no model would ever read. */
const DUCKDB_SYSTEM_SCHEMAS = new Set([
  'information_schema',
  'pg_catalog',
  'main.information_schema',
]);

async function queryDuckDbCatalog(opened: Connection): Promise<TableEntry[]> {
  const { rows } = await opened.runSQL(
    'SELECT table_schema, table_name, table_type FROM information_schema.tables ' +
      `ORDER BY table_schema, table_name LIMIT ${MAX_TABLES + 1}`,
  );

  const entries: TableEntry[] = [];
  for (const row of rows) {
    const schema = text(row.table_schema);
    const name = text(row.table_name);
    if (!name || (schema && DUCKDB_SYSTEM_SCHEMAS.has(schema))) continue;

    entries.push({
      // A table in `main` is reachable by its bare name, which is what someone
      // would write; anywhere else it has to be qualified to be found.
      name: schema && schema !== 'main' ? `${schema}.${name}` : name,
      schema: schema ?? null,
      kind: text(row.table_type) === 'VIEW' ? 'view' : 'table',
    });
  }
  return entries;
}

/**
 * Datasets to name in the per-dataset listing. Enough to be the whole answer for
 * most projects, and short enough to keep the query text sane in the ones where
 * it is not.
 */
const MAX_DATASETS = 100;

async function listBigQueryTables(
  connection: BigQueryConnectionConfig,
  root: string,
  pattern?: string,
): Promise<TableList> {
  const settings = await resolveBigQuery(connection, root);
  const project = settings.projectId;

  if (!project) {
    throw new MoraError(`Connection "${connection.name}" does not say which project to read.`, {
      code: 'missing-setting',
      hint: 'Set `project_id` on the connection in mora.yaml, so the table listing can be qualified.',
    });
  }

  // INFORMATION_SCHEMA is per region, and a query against the wrong one reports
  // an empty dataset list rather than a mistake, so the connection's own location
  // decides it. Unset means BigQuery's own default, the US multi-region.
  const region = `region-${(settings.location ?? 'US').toLowerCase()}`;
  const filter = pattern ? `WHERE STRPOS(LOWER(table_name), ${literal(pattern)}) > 0\n` : '';

  return withConnection(connection, root, async (opened) => {
    const tail = `${filter}ORDER BY table_schema, table_name\nLIMIT ${MAX_TABLES + 1}`;

    try {
      return readTableRows(
        await opened.runSQL(
          `${TABLE_COLUMNS}\nFROM \`${identifier(project)}\`.\`${identifier(region)}\`.INFORMATION_SCHEMA.TABLES\n${tail}`,
        ),
      );
    } catch (error) {
      // The region-wide view needs `bigquery.tables.list` across every dataset in
      // the project, which an account granted a few datasets does not have. Being
      // told nothing because 48 of 50 datasets are none of your business is not an
      // answer, so fall back to listing the ones the credentials can actually see.
      if (!looksLikePermissionDenied(describeError(error))) throw error;
      return listBigQueryPerDataset(opened, project, tail, describeError(error));
    }
  });
}

async function listBigQueryPerDataset(
  opened: Connection,
  project: string,
  tail: string,
  denial: string,
): Promise<TableList> {
  // SCHEMATA at the project level needs only `bigquery.datasets.get`, and it
  // returns exactly the datasets these credentials can see.
  const datasets = await opened
    .runSQL(
      `SELECT schema_name FROM \`${identifier(project)}\`.INFORMATION_SCHEMA.SCHEMATA\nORDER BY schema_name LIMIT ${MAX_DATASETS + 1}`,
    )
    .then(({ rows }) => rows.map((row) => text(row.schema_name)).filter(isPresent))
    .catch(() => {
      throw new MoraError(`Not allowed to list the tables in project "${project}".`, {
        code: 'listing-denied',
        hint: `Ask for the \`roles/bigquery.metadataViewer\` role on the project, or on the datasets you need to read. The database said: ${denial}`,
      });
    });

  if (datasets.length === 0) {
    throw new MoraError(`No datasets in project "${project}" are visible to this connection.`, {
      code: 'listing-denied',
      hint: `Check that \`project_id\` names the project you meant, and that these credentials are granted at least one dataset in it. The database said: ${denial}`,
    });
  }

  const named = datasets.slice(0, MAX_DATASETS);
  // One UNION ALL rather than a query per dataset: an INFORMATION_SCHEMA query
  // is billed a minimum either way, and a hundred of them is a listing nobody
  // waits for.
  const union = named
    .map(
      (dataset) =>
        `${TABLE_COLUMNS} FROM \`${identifier(project)}.${identifier(dataset)}\`.INFORMATION_SCHEMA.TABLES`,
    )
    .join('\nUNION ALL\n');

  const listed = readTableRows(await opened.runSQL(`SELECT * FROM (\n${union}\n)\n${tail}`));
  return { tables: listed.tables, truncated: listed.truncated || datasets.length > named.length };
}

const TABLE_COLUMNS = 'SELECT table_schema, table_name, table_type';

function readTableRows({ rows }: { rows: readonly Record<string, unknown>[] }): TableList {
  const entries: TableEntry[] = [];
  for (const row of rows) {
    const dataset = text(row.table_schema);
    const name = text(row.table_name);
    if (!dataset || !name) continue;
    entries.push({
      // Qualified, because that is what a source has to say to find it.
      name: `${dataset}.${name}`,
      schema: dataset,
      kind: text(row.table_type) === 'VIEW' ? 'view' : 'table',
    });
  }
  return cap(entries);
}

function looksLikePermissionDenied(message: string): boolean {
  return /access denied|permission|not authorized|forbidden/i.test(message);
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined;
}

/**
 * A project id or a region goes into a backtick-quoted identifier, which cannot
 * be parameterised. A value that is not one is refused rather than escaped:
 * that is a mistake in mora.yaml, not a name worth guessing at.
 */
const SQL_IDENTIFIER = /^[A-Za-z0-9_.:-]+$/;

function identifier(value: string): string {
  if (SQL_IDENTIFIER.test(value)) return value;
  throw new MoraError(`"${value}" cannot be used to qualify a table listing.`, {
    code: 'invalid-setting',
    hint: 'Check `project_id` and `location` on the connection in mora.yaml.',
  });
}

/** A BigQuery string literal, lower-cased to match the LOWER() it is compared to. */
function literal(value: string): string {
  const escaped = value
    .toLowerCase()
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    // A newline inside a literal ends the statement in some dialects, and no
    // table name has one.
    .replace(/[\r\n]/g, ' ');
  return `'${escaped}'`;
}

function filterByName(entries: TableEntry[], pattern?: string): TableEntry[] {
  if (!pattern) return entries;
  const needle = pattern.toLowerCase();
  return entries.filter((entry) => entry.name.toLowerCase().includes(needle));
}

/** Sorted for a stable report, and cut to a length worth reading. */
function cap(entries: TableEntry[]): TableList {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  return { tables: sorted.slice(0, MAX_TABLES), truncated: sorted.length > MAX_TABLES };
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
