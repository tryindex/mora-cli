import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSchema } from '../src/commands/schema.js';
import { loadConfig } from '../src/config.js';
import { addConnection } from '../src/connections.js';
import type { MoraError } from '../src/errors.js';
import { withConnection } from '../src/malloy/runtime.js';
import { buildScaffold, type ScaffoldSpec, writeScaffold } from '../src/scaffold.js';
import { writeOrdersModel } from './helpers/fixtures.js';

const spec: ScaffoldSpec = {
  root: '',
  projectName: 'analytics',
  database: 'duckdb',
  modelsDir: 'metrics',
  connectionName: 'duckdb',
};

/** A scaffold plus the orders fixture: `init` itself writes no model. */
async function scaffoldProject(
  options: { withModel?: boolean } & Partial<ScaffoldSpec> = {},
): Promise<string> {
  const { withModel = true, ...overrides } = options;
  const root = await mkdtemp(path.join(tmpdir(), 'mora-schema-'));
  await writeScaffold(root, buildScaffold({ ...spec, ...overrides, root }));
  if (withModel) await writeOrdersModel(root);
  return root;
}

function names(entries: { name: string }[]): string[] {
  return entries.map((entry) => entry.name);
}

describe('runSchema listing', () => {
  it('lists the data files a DuckDB connection can read', async () => {
    const root = await scaffoldProject();

    const report = await runSchema(root, [], { json: true });

    expect(report.ok).toBe(true);
    expect(report.command).toBe('schema');
    expect(report.connection).toEqual({ name: 'duckdb', type: 'duckdb' });
    expect(report.pattern).toBeNull();
    expect(report.truncated).toBe(false);
    // Tables and columns are separate modes, and the report says which one ran.
    expect(report.schemas).toBeNull();
    expect(names(report.tables ?? [])).toEqual(['data/orders.csv']);
    expect(report.tables?.[0]?.kind).toBe('file');
  });

  it('names a file the way a source has to write it', async () => {
    const root = await scaffoldProject();
    await mkdir(path.join(root, 'metrics/data/regions'), { recursive: true });
    await writeFile(
      path.join(root, 'metrics/data/regions/west.csv'),
      'region,amount\nwest,10\n',
      'utf8',
    );

    const report = await runSchema(root, [], { json: true });

    // Relative to the connection's working directory, so it pastes into
    // `duckdb.table('...')` unchanged.
    expect(names(report.tables ?? [])).toContain('data/regions/west.csv');
  });

  it('finds files of every kind DuckDB reads, and nothing else', async () => {
    const root = await scaffoldProject();
    const dataDir = path.join(root, 'metrics/data');
    await writeFile(path.join(dataDir, 'sales.parquet'), '', 'utf8');
    await writeFile(path.join(dataDir, 'events.json'), '[]', 'utf8');
    await writeFile(path.join(dataDir, 'notes.txt'), 'not data', 'utf8');
    await writeFile(path.join(dataDir, '.hidden.csv'), 'a\n1\n', 'utf8');

    const report = await runSchema(root, [], { json: true });
    const listed = names(report.tables ?? []);

    expect(listed).toContain('data/sales.parquet');
    expect(listed).toContain('data/events.json');
    expect(listed).not.toContain('data/notes.txt');
    expect(listed).not.toContain('data/.hidden.csv');
  });

  it('narrows the listing to names containing the pattern', async () => {
    const root = await scaffoldProject();
    await writeFile(path.join(root, 'metrics/data/regions.csv'), 'region\nwest\n', 'utf8');

    const matched = await runSchema(root, [], { json: true, pattern: 'ORDER' });
    expect(names(matched.tables ?? [])).toEqual(['data/orders.csv']);

    const missed = await runSchema(root, [], { json: true, pattern: 'nothing_here' });
    // Nothing matching is an empty answer, not a failure.
    expect(missed.ok).toBe(true);
    expect(missed.tables).toEqual([]);
    expect(missed.pattern).toBe('nothing_here');
  });

  it('lists the tables registered in a .duckdb database as well as files', async () => {
    const root = await scaffoldProject();

    // A real database file with a real table in it: the catalog half of a DuckDB
    // listing cannot be proven against `:memory:`, which has no catalog worth
    // reading.
    await addConnection(await loadConfig(root), {
      name: 'warehouse',
      type: 'duckdb',
      settings: { database: 'warehouse.duckdb', working_directory: 'metrics' },
      makeDefault: false,
    });

    const withFile = await loadConfig(root);
    const registered = withFile.connections.find((entry) => entry.name === 'warehouse');
    if (!registered?.supported) throw new Error('the connection was just added');

    await withConnection(registered, root, async (opened) => {
      await opened.runSQL('CREATE TABLE customers (id INTEGER, name VARCHAR)');
      await opened.runSQL('CREATE VIEW recent_customers AS SELECT * FROM customers');
    });

    const report = await runSchema(root, [], { json: true, connection: 'warehouse' });
    const listed = report.tables ?? [];

    expect(names(listed)).toContain('customers');
    expect(listed.find((entry) => entry.name === 'customers')?.kind).toBe('table');
    expect(listed.find((entry) => entry.name === 'recent_customers')?.kind).toBe('view');
    // The files under the working directory are still listed beside them.
    expect(names(listed)).toContain('data/orders.csv');
    // DuckDB's own bookkeeping is not something a model would ever read.
    expect(names(listed).some((name) => name.includes('information_schema'))).toBe(false);
  });

  it('refuses a connection the project does not declare', async () => {
    const root = await scaffoldProject();

    await expect(runSchema(root, [], { json: true, connection: 'nope' })).rejects.toThrowError(
      /No connection called "nope"/,
    );
  });

  it('leaves the search for data elsewhere undone when the listing found tables', async () => {
    const root = await scaffoldProject();

    const report = await runSchema(root, [], { json: true });

    expect(report.readsFrom).toBe('metrics');
    // A listing that found something has already answered the question, so the
    // project is never walked.
    expect(report.dataElsewhere).toBeNull();
  });
});

/**
 * An empty listing used to suggest `mora connection test`, which passes for any
 * DuckDB connection whether or not it can see data, so the reader was sent to a
 * check that cannot fail.
 */
describe('runSchema on an empty listing', () => {
  it('names the directory that holds the data the connection cannot reach', async () => {
    const root = await scaffoldProject({ withModel: false });
    await mkdir(path.join(root, 'warehouse'), { recursive: true });
    await writeFile(path.join(root, 'warehouse/orders.csv'), 'id\n1\n', 'utf8');
    await writeFile(path.join(root, 'warehouse/customers.csv'), 'id\n1\n', 'utf8');

    const report = await runSchema(root, [], { json: true });

    // Nowhere to read is an empty answer, not a failure of the command.
    expect(report.ok).toBe(true);
    expect(report.tables).toEqual([]);
    expect(report.readsFrom).toBe('metrics');
    expect(report.dataElsewhere).toEqual([{ directory: 'warehouse', fileCount: 2 }]);

    const steps = report.nextSteps.join('\n');
    expect(steps).toContain('metrics/');
    expect(steps).toContain('warehouse/');
    expect(steps).toContain('working_directory: warehouse');
    // The check that cannot fail is gone.
    expect(steps).not.toContain('connection test');
  });

  it('reports data sitting in the project root as the root', async () => {
    const root = await scaffoldProject({ withModel: false });
    await writeFile(path.join(root, 'orders.csv'), 'id\n1\n', 'utf8');

    const report = await runSchema(root, [], { json: true });

    expect(report.dataElsewhere).toEqual([{ directory: '.', fileCount: 1 }]);
    expect(report.nextSteps.join('\n')).toContain('the project root');
  });

  it('sorts the directory holding the most data first', async () => {
    const root = await scaffoldProject({ withModel: false });
    await mkdir(path.join(root, 'seeds'), { recursive: true });
    await mkdir(path.join(root, 'warehouse'), { recursive: true });
    await writeFile(path.join(root, 'seeds/regions.csv'), 'region\nwest\n', 'utf8');
    await writeFile(path.join(root, 'warehouse/orders.csv'), 'id\n1\n', 'utf8');
    await writeFile(path.join(root, 'warehouse/customers.csv'), 'id\n1\n', 'utf8');

    const report = await runSchema(root, [], { json: true });

    expect(report.dataElsewhere?.map((entry) => entry.directory)).toEqual(['warehouse', 'seeds']);
    expect(report.nextSteps.join('\n')).toContain('working_directory: warehouse');
  });

  it('says so plainly when the project holds no data at all', async () => {
    const root = await scaffoldProject({ withModel: false });

    const report = await runSchema(root, [], { json: true });

    expect(report.ok).toBe(true);
    expect(report.dataElsewhere).toEqual([]);

    const steps = report.nextSteps.join('\n');
    expect(steps).toContain('neither does anywhere else in this project');
    expect(steps).toContain('working_directory');
    expect(steps).not.toContain('connection test');
  });

  it('does not go looking when a pattern is what emptied the listing', async () => {
    const root = await scaffoldProject();

    const report = await runSchema(root, [], { json: true, pattern: 'nothing_here' });

    expect(report.tables).toEqual([]);
    expect(report.dataElsewhere).toBeNull();
    expect(report.nextSteps.join('\n')).toContain('without --pattern');
  });
});

describe('runSchema columns', () => {
  it('reads the columns and Malloy types of a table', async () => {
    const root = await scaffoldProject();

    const report = await runSchema(root, ['data/orders.csv'], { json: true });

    expect(report.ok).toBe(true);
    expect(report.tables).toBeNull();
    expect(report.schemas).toHaveLength(1);

    const orders = report.schemas?.[0];
    expect(orders?.name).toBe('data/orders.csv');
    expect(names(orders?.columns ?? [])).toEqual([
      'id',
      'order_date',
      'customer_name',
      'region',
      'product',
      'quantity',
      'amount',
      'status',
    ]);
    // The types are the ones a model will see, not the warehouse's own DDL.
    expect(orders?.columns.find((column) => column.name === 'amount')?.type).toBe('number');
    expect(orders?.columns.find((column) => column.name === 'order_date')?.type).toBe('date');
  });

  it('reads several tables in one pass, in the order they were asked for', async () => {
    const root = await scaffoldProject();
    await writeFile(
      path.join(root, 'metrics/data/regions.csv'),
      'region,manager\nwest,ana\n',
      'utf8',
    );

    const report = await runSchema(root, ['data/regions.csv', 'data/orders.csv'], { json: true });

    expect(report.ok).toBe(true);
    expect(names(report.schemas ?? [])).toEqual(['data/regions.csv', 'data/orders.csv']);
    expect(names(report.schemas?.[0]?.columns ?? [])).toEqual(['region', 'manager']);
  });

  it('blames the table that could not be read, and still reads the others', async () => {
    const root = await scaffoldProject();

    const report = await runSchema(root, ['data/orders.csv', 'data/missing.csv'], { json: true });

    // One unreadable table is a failure of the command: an empty column list must
    // never look like a table with no columns.
    expect(report.ok).toBe(false);

    const orders = report.schemas?.find((schema) => schema.name === 'data/orders.csv');
    expect(orders?.error).toBeUndefined();
    expect(orders?.columns.length).toBeGreaterThan(0);

    const missing = report.schemas?.find((schema) => schema.name === 'data/missing.csv');
    expect(missing?.columns).toEqual([]);
    expect(missing?.error).toContain('data/missing.csv');
    // The generated model URL is noise, and naming it would send a reader nowhere.
    expect(missing?.error).not.toContain('internal://');
  });

  it('refuses a table path that is not one, rather than escaping it', async () => {
    const root = await scaffoldProject();

    await expect(runSchema(root, ["orders'; drop table x"], { json: true })).rejects.toThrowError(
      /is not a table path/,
    );
  });
});

/**
 * Committed rather than run by hand, so a machine with credentials proves the
 * catalog query really is valid SQL against a real INFORMATION_SCHEMA.
 */
const bigqueryProject = process.env.GOOGLE_CLOUD_PROJECT;
describe.skipIf(!bigqueryProject)('against a real BigQuery project', () => {
  it('lists tables, or says what to do about not being allowed to', async () => {
    const root = await scaffoldProject({ database: 'bigquery' });

    // Whether an account may list a whole region is a property of the account,
    // not of this code, so both outcomes are asserted. What must never happen is
    // the third one: a raw Google permission dump with no next step in it.
    let report: Awaited<ReturnType<typeof runSchema>>;
    try {
      report = await runSchema(root, [], { json: true, connection: 'warehouse' });
    } catch (error) {
      const failure = error as MoraError;
      expect(failure.code).toBe('listing-denied');
      expect(failure.hint).toMatch(/roles\/bigquery|project_id/);
      return;
    }

    expect(report.ok).toBe(true);
    // Every name comes back qualified, because that is what a source must write.
    for (const table of report.tables ?? []) {
      expect(table.name).toContain('.');
      expect(table.schema).toBeTruthy();
    }
  });
});
