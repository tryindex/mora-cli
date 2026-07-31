import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runQueryCommand } from '../src/commands/query.js';
import { MoraError } from '../src/errors.js';
import { indexDefinitions, resolveDefinition, type Vocabulary } from '../src/malloy/vocabulary.js';
import { buildScaffold, type ScaffoldSpec, writeScaffold } from '../src/scaffold.js';
import { writeOrdersModel } from './helpers/fixtures.js';

const spec: ScaffoldSpec = {
  root: '',
  projectName: 'analytics',
  database: 'duckdb',
  modelsDir: 'metrics',
  connectionName: 'duckdb',
};

/**
 * A scaffold plus the orders fixture, which is what a project looks like once
 * someone has written their first model. `init` writes no model of its own.
 */
async function scaffoldProject(
  options: { withModel?: boolean } & Partial<ScaffoldSpec> = {},
): Promise<string> {
  const { withModel = true, ...overrides } = options;
  const root = await mkdtemp(path.join(tmpdir(), 'mora-query-'));
  await writeScaffold(root, buildScaffold({ ...spec, ...overrides, root }));
  if (withModel) await writeOrdersModel(root);
  return root;
}

async function moraError(run: Promise<unknown>): Promise<MoraError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof MoraError) return error;
    throw error;
  }
  throw new Error('expected the query to fail');
}

describe('runQueryCommand', () => {
  it('runs a named query and reports the SQL behind the rows', async () => {
    const root = await scaffoldProject();

    const report = await runQueryCommand(root, 'monthly_revenue', { json: true });

    expect(report.ok).toBe(true);
    expect(report.command).toBe('query');
    expect(report.name).toBe('monthly_revenue');
    expect(report.model).toBe('metrics/orders.malloy');
    expect(report.executed).toBe(true);
    // A definition someone committed has been through review.
    expect(report.reviewed).toBe(true);
    expect(report.rowCount).toBeGreaterThan(0);
    expect(report.rows[0]).toHaveProperty('revenue');
    expect(report.sql).toContain('SUM');
  });

  it('runs a view by its own name, and by source.view', async () => {
    const root = await scaffoldProject();

    const bare = await runQueryCommand(root, 'revenue_by_region', { json: true });
    const qualified = await runQueryCommand(root, 'orders.revenue_by_region', { json: true });

    expect(bare.name).toBe('orders.revenue_by_region');
    expect(bare.rows).toEqual(qualified.rows);
    expect(bare.rows[0]).toHaveProperty('region');
  });

  it('runs a named view that groups by a joined field', async () => {
    const root = await scaffoldProject();
    await writeFile(
      path.join(root, 'metrics/data/regions.csv'),
      'region,manager\nnorth,ana\nsouth,bo\n',
      'utf8',
    );
    await writeFile(
      path.join(root, 'metrics/joined.malloy'),
      [
        "source: regions is duckdb.table('data/regions.csv') extend {",
        '  primary_key: region',
        '}',
        '',
        "source: sales is duckdb.table('data/orders.csv') extend {",
        '  join_one: regions with region',
        '  measure: revenue is amount.sum()',
        '',
        '  view: revenue_by_manager is {',
        '    group_by: regions.manager',
        '    aggregate: revenue',
        '  }',
        '}',
      ].join('\n'),
      'utf8',
    );

    const report = await runQueryCommand(root, 'sales.revenue_by_manager', { json: true });

    // The join has to survive into the SQL. Selecting a joined column without
    // joining the table compiles in Malloy and is rejected by the database.
    expect(report.ok).toBe(true);
    expect(report.sql).toMatch(/JOIN/i);
    expect(report.rows[0]).toHaveProperty('manager');
  });

  it('marks an ad-hoc expression as unreviewed and says what to do about it', async () => {
    const root = await scaffoldProject();

    const report = await runQueryCommand(root, undefined, {
      expr: 'orders -> { aggregate: revenue }',
      json: true,
    });

    expect(report.ok).toBe(true);
    expect(report.name).toBeNull();
    expect(report.reviewed).toBe(false);
    expect(report.rowCount).toBe(1);
    expect(report.nextSteps[0]).toMatch(/nobody has reviewed it/);
  });

  it('runs an expression that declares its own source, against a table no model names', async () => {
    const root = await scaffoldProject();
    await writeFile(
      path.join(root, 'metrics/data/regions.csv'),
      'region,manager\nwest,ana\neast,bo\n',
      'utf8',
    );

    const report = await runQueryCommand(root, undefined, {
      expr:
        "source: probe is duckdb.table('data/regions.csv') extend {}\n" +
        'run: probe -> { aggregate: rows is count() }',
      json: true,
    });

    expect(report.ok).toBe(true);
    expect(report.rows).toEqual([{ rows: 2 }]);
    // Still unreviewed: declaring a scratch source is exploring, not modelling.
    expect(report.reviewed).toBe(false);
  });

  it('discovers data in a project that has no models at all', async () => {
    // The state that matters most: a connection that works, and nothing modelled
    // yet. Needing a model to check the data would make the first step of
    // modelling impossible.
    const root = await scaffoldProject({ withModel: false });
    await writeFile(path.join(root, 'metrics/sales.csv'), 'id,amount\n1,10\n1,20\n', 'utf8');

    const report = await runQueryCommand(root, undefined, {
      expr:
        "source: probe is duckdb.table('sales.csv') extend {}\n" +
        'run: probe -> { group_by: id; aggregate: rows is count() } -> ' +
        '{ where: rows > 1; aggregate: duplicate_keys is count() }',
      json: true,
    });

    expect(report.ok).toBe(true);
    // The duplicate-key check the modelling guide opens with, answered before a
    // single line of the model exists.
    expect(report.rows).toEqual([{ duplicate_keys: 1 }]);
  });

  it('says how to reach the data when an expression names no source and there is no model', async () => {
    const root = await scaffoldProject({ withModel: false });

    const error = await moraError(
      runQueryCommand(root, undefined, { expr: 'orders -> { aggregate: revenue }' }),
    );

    expect(error.code).toBe('ambiguous-model');
    expect(error.hint).toMatch(/Declare the source in the expression itself/);
  });

  it('caps the rows and says when there were more', async () => {
    const root = await scaffoldProject();

    const report = await runQueryCommand(root, 'top_customers', { limit: '2', json: true });

    expect(report.rowCount).toBe(2);
    expect(report.truncated).toBe(true);
    expect(report.nextSteps[0]).toMatch(/Raise --limit/);
  });

  it('compiles without running under --sql', async () => {
    const root = await scaffoldProject();

    const compiled = await runQueryCommand(root, 'monthly_revenue', { sql: true, json: true });
    const ran = await runQueryCommand(root, 'monthly_revenue', { json: true });

    expect(compiled.executed).toBe(false);
    expect(compiled.rows).toEqual([]);
    expect(compiled.rowCount).toBe(0);
    // Same query, same SQL: the only difference is that one of them ran it.
    expect(compiled.sql).toBe(ran.sql);
    expect(ran.rowCount).toBeGreaterThan(0);
  });

  it('fails with a distinct code on a name the project does not define', async () => {
    const root = await scaffoldProject();

    const error = await moraError(runQueryCommand(root, 'no_such_query', { json: true }));

    expect(error.code).toBe('unknown-definition');
    expect(error.hint).toContain('monthly_revenue');
  });

  it('explains a failure caused by data that is not there', async () => {
    const root = await scaffoldProject();
    await rm(path.join(root, 'metrics/data/orders.csv'));

    const error = await moraError(runQueryCommand(root, 'monthly_revenue', { json: true }));

    expect(error.code).toBe('query-failed');
    expect(error.hint).toContain('data is missing');
  });

  it('refuses a request that names nothing to run', async () => {
    const root = await scaffoldProject();

    const error = await moraError(runQueryCommand(root, undefined, { json: true }));

    expect(error.code).toBe('no-query');
    expect(error.exitCode).toBe(2);
  });

  it('refuses a name and an expression together', async () => {
    const root = await scaffoldProject();

    const error = await moraError(
      runQueryCommand(root, 'monthly_revenue', { expr: 'orders -> { aggregate: revenue }' }),
    );

    expect(error.code).toBe('conflicting-query');
  });

  it('rejects a limit that is not a positive whole number', async () => {
    const root = await scaffoldProject();

    const error = await moraError(runQueryCommand(root, 'monthly_revenue', { limit: '0' }));

    expect(error.code).toBe('invalid-limit');
    expect(error.exitCode).toBe(2);
  });

  it('picks the model an expression belongs to when there is more than one', async () => {
    const root = await scaffoldProject();
    await writeFile(
      path.join(root, 'metrics/refunds.malloy'),
      "source: refunds is duckdb.table('data/orders.csv') extend {\n" +
        '  measure: refunded is amount.sum()\n' +
        '}\n',
      'utf8',
    );

    const report = await runQueryCommand(root, undefined, {
      expr: 'refunds -> { aggregate: refunded }',
      json: true,
    });

    expect(report.model).toBe('metrics/refunds.malloy');
    expect(report.rows[0]).toHaveProperty('refunded');
  });
});

describe('Malloy given as a file', () => {
  it('runs a multi-line probe without any shell quoting', async () => {
    const root = await scaffoldProject({ withModel: false });
    await writeFile(path.join(root, 'metrics/sales.csv'), 'id,amount\n1,10\n2,20\n', 'utf8');
    const probe = path.join(root, 'probe.malloy');
    await writeFile(
      probe,
      [
        "source: probe is duckdb.table('sales.csv') extend {}",
        'run: probe -> { aggregate: rows is count() }',
        '',
      ].join('\n'),
      'utf8',
    );

    const report = await runQueryCommand(root, undefined, { file: probe, json: true });

    expect(report.ok).toBe(true);
    expect(report.rows).toEqual([{ rows: 2 }]);
    // A file makes a probe easier to write, not more trustworthy.
    expect(report.reviewed).toBe(false);
  });

  it('reports the path it could not read as a usage error', async () => {
    const root = await scaffoldProject();

    const error = await moraError(
      runQueryCommand(root, undefined, { file: path.join(root, 'absent.malloy'), json: true }),
    );

    expect(error.code).toBe('unreadable-expr');
    expect(error.exitCode).toBe(2);
  });

  it('refuses an empty document rather than compiling nothing', async () => {
    const root = await scaffoldProject();
    const probe = path.join(root, 'empty.malloy');
    await writeFile(probe, '\n\n', 'utf8');

    const error = await moraError(runQueryCommand(root, undefined, { file: probe, json: true }));

    expect(error.code).toBe('unreadable-expr');
  });

  it('refuses --expr and --file together', async () => {
    const root = await scaffoldProject();

    const error = await moraError(
      runQueryCommand(root, undefined, {
        expr: 'orders -> { aggregate: revenue }',
        file: 'p.malloy',
      }),
    );

    expect(error.code).toBe('conflicting-query');
    expect(error.exitCode).toBe(2);
  });
});

describe('resolveDefinition', () => {
  const vocabulary: Vocabulary = {
    sources: [
      {
        name: 'orders',
        model: 'metrics/orders.malloy',
        dimensions: [],
        measures: [],
        views: [{ name: 'by_month', type: 'view' }],
        joins: [],
      },
      {
        name: 'refunds',
        model: 'metrics/refunds.malloy',
        dimensions: [],
        measures: [],
        views: [{ name: 'by_month', type: 'view' }],
        joins: [],
      },
    ],
    queries: [{ name: 'monthly_revenue', model: 'metrics/orders.malloy' }],
    failures: [],
  };

  const definitions = indexDefinitions(vocabulary);

  it('resolves a named query', () => {
    expect(resolveDefinition(definitions, 'monthly_revenue')).toMatchObject({
      kind: 'query',
      model: 'metrics/orders.malloy',
    });
  });

  it('resolves a view qualified by its source', () => {
    expect(resolveDefinition(definitions, 'orders.by_month')).toMatchObject({
      kind: 'view',
      source: 'orders',
      view: 'by_month',
    });
  });

  it('refuses to guess between two sources with the same view name', () => {
    expect(() => resolveDefinition(definitions, 'by_month')).toThrowError(
      /view on more than one source/,
    );
  });

  it('lists what exists when a name does not', () => {
    expect(() => resolveDefinition(definitions, 'nope')).toThrowError(/No definition named "nope"/);
  });
});
