import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runQueryCommand } from '../src/commands/query.js';
import { MoraError } from '../src/errors.js';
import { buildScaffold, type ScaffoldSpec, writeScaffold } from '../src/scaffold.js';

const spec: ScaffoldSpec = {
  root: '',
  projectName: 'analytics',
  database: 'duckdb',
  modelsDir: 'metrics',
  includeExample: true,
};

async function scaffoldProject(overrides: Partial<ScaffoldSpec> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mora-query-'));
  await writeScaffold(root, buildScaffold({ ...spec, ...overrides, root }));
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
    expect(report.model).toBe('metrics/example.malloy');
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
