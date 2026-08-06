import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CACHE_DIR } from '../src/cache.js';
import { runQueryCommand } from '../src/commands/query.js';
import { runSync } from '../src/commands/sync.js';
import { runValidate } from '../src/commands/validate.js';
import { MoraError } from '../src/errors.js';
import { buildScaffold, type ScaffoldSpec, writeScaffold } from '../src/scaffold.js';
import { ORDERS_CSV, writeOrdersModel } from './helpers/fixtures.js';

const spec: ScaffoldSpec = {
  root: '',
  projectName: 'analytics',
  database: 'duckdb',
  modelsDir: 'metrics',
  connectionName: 'duckdb',
};

const roots: string[] = [];

async function scaffoldProject(options: { withModel?: boolean } = {}): Promise<string> {
  const { withModel = true } = options;
  const root = await mkdtemp(path.join(tmpdir(), 'mora-cache-'));
  roots.push(root);
  await writeScaffold(root, buildScaffold({ ...spec, root }));
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
  throw new Error('expected the command to fail');
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('runSync', () => {
  it('caches the tables the models read, and says what it wrote', async () => {
    const root = await scaffoldProject();

    const report = await runSync(root, { json: true });

    expect(report.ok).toBe(true);
    expect(report.executed).toBe(true);
    expect(report.models).toEqual(['metrics/orders.malloy']);
    expect(report.synced.map((table) => table.table)).toEqual(['data/orders.csv']);
    expect(report.synced[0]?.status).toBe('synced');
    expect(report.rows).toBe(25);
    // The manifest and the catalog are what the local runtime reads back.
    expect(existsSync(path.join(root, CACHE_DIR, 'cache.duckdb'))).toBe(true);
    expect(existsSync(path.join(root, CACHE_DIR, 'manifest.json'))).toBe(true);
  });

  it('reports an empty cache rather than failing, before anything is synced', async () => {
    const root = await scaffoldProject();

    const report = await runSync(root, { status: true, json: true });

    expect(report.ok).toBe(true);
    expect(report.executed).toBe(false);
    expect(report.cached).toEqual([]);
    expect(report.syncedAt).toBeNull();
    expect(report.nextSteps.join(' ')).toContain('mora sync');
  });

  it('reports the age and row count of what it holds', async () => {
    const root = await scaffoldProject();
    await runSync(root, { json: true });

    const report = await runSync(root, { status: true, json: true });

    expect(report.executed).toBe(false);
    expect(report.cached).toHaveLength(1);
    expect(report.cached[0]).toMatchObject({
      table: 'data/orders.csv',
      connection: 'duckdb',
      rows: 25,
      capped: false,
      pathNote: null,
    });
    expect(report.cached[0]?.age).toBeTruthy();
  });

  it('marks an extract that stopped at the row limit as capped', async () => {
    const root = await scaffoldProject();

    const report = await runSync(root, { limit: '10', json: true });

    expect(report.ok).toBe(true);
    expect(report.synced[0]).toMatchObject({ rows: 10, capped: true });
    // A capped table has to be findable by anything that reports a number over it.
    expect(report.cached[0]?.capped).toBe(true);
    expect(report.nextSteps.join(' ')).toContain('row limit');
  });

  it('caches a table no model reads when it is named outright', async () => {
    // Data in the warehouse with nothing modelling it yet: the state someone is
    // in when they are still deciding what is worth defining.
    const root = await scaffoldProject({ withModel: false });
    await mkdir(path.join(root, 'metrics/data'), { recursive: true });
    await writeFile(path.join(root, 'metrics/data/orders.csv'), ORDERS_CSV, 'utf8');

    const report = await runSync(root, { table: ['data/orders.csv'], json: true });

    expect(report.ok).toBe(true);
    expect(report.models).toEqual([]);
    expect(report.cached.map((table) => table.table)).toEqual(['data/orders.csv']);
    expect(report.cached[0]?.rows).toBe(25);
  });

  it('refuses a limit that is not a positive whole number', async () => {
    const root = await scaffoldProject();

    const error = await moraError(runSync(root, { limit: '0', json: true }));

    expect(error.code).toBe('invalid-limit');
    expect(error.exitCode).toBe(2);
  });

  it('explains an empty run rather than reporting a silent success', async () => {
    const root = await scaffoldProject({ withModel: false });

    const report = await runSync(root, { json: true });

    expect(report.ok).toBe(true);
    expect(report.synced).toEqual([]);
    expect(report.nextSteps.join(' ')).toContain('nothing to cache');
  });
});

describe('runQueryCommand against the cache', () => {
  it('reads the warehouse for a named definition, and says so', async () => {
    const root = await scaffoldProject();
    await runSync(root, { json: true });

    const report = await runQueryCommand(root, 'monthly_revenue', { json: true });

    expect(report.ok).toBe(true);
    // A reviewed definition is an answer somebody acts on: it does not go stale.
    expect(report.local).toBe(false);
    expect(report.syncedAt).toBeNull();
  });

  it('reads the cache for a probe once one exists', async () => {
    const root = await scaffoldProject();
    await runSync(root, { json: true });

    const report = await runQueryCommand(root, undefined, {
      expr: 'orders -> { aggregate: order_count }',
      json: true,
    });

    expect(report.ok).toBe(true);
    expect(report.local).toBe(true);
    expect(report.syncedAt).not.toBeNull();
    expect(report.fellBackToWarehouse).toBe(false);
    expect(report.nextSteps.join(' ')).toContain('local cache');
  });

  it('reads the warehouse for a probe when nothing has been synced', async () => {
    const root = await scaffoldProject();

    const report = await runQueryCommand(root, undefined, {
      expr: 'orders -> { aggregate: order_count }',
      json: true,
    });

    expect(report.ok).toBe(true);
    expect(report.local).toBe(false);
    expect(report.fellBackToWarehouse).toBe(false);
  });

  it('answers from the copy, not the source, so a divergence proves which was read', async () => {
    const root = await scaffoldProject();
    await runSync(root, { json: true });

    // A row the cache cannot know about. This is the only way to tell a genuine
    // cache read from a warehouse read that happened to give the same answer.
    await appendFile(
      path.join(root, 'metrics/data/orders.csv'),
      '26,2024-06-01,Late Arrival,Europe,Growth Plan,1,1000.00,completed\n',
      'utf8',
    );

    const cached = await runQueryCommand(root, undefined, {
      expr: 'orders -> { aggregate: order_count }',
      json: true,
    });
    const live = await runQueryCommand(root, undefined, {
      expr: 'orders -> { aggregate: order_count }',
      remote: true,
      json: true,
    });

    expect(cached.local).toBe(true);
    expect(cached.rows[0]?.order_count).toBe(25);
    expect(live.local).toBe(false);
    expect(live.rows[0]?.order_count).toBe(26);
  });

  it('falls back to the warehouse for a probe the cache cannot answer', async () => {
    const root = await scaffoldProject();
    await runSync(root, { json: true });

    // A table that exists in the warehouse and not in the cache, which is the
    // ordinary case: someone is probing something before any model reads it.
    await writeFile(
      path.join(root, 'metrics/data/regions.csv'),
      'code,name\nnorth,North\nsouth,South\n',
      'utf8',
    );

    const report = await runQueryCommand(root, undefined, {
      expr:
        "source: regions is duckdb.table('data/regions.csv') extend {}\n" +
        'run: regions -> { aggregate: n is count() }',
      json: true,
    });

    expect(report.ok).toBe(true);
    expect(report.rows[0]?.n).toBe(2);
    // The answer is the warehouse's, and the report says the cache was short.
    expect(report.local).toBe(false);
    expect(report.fellBackToWarehouse).toBe(true);
    expect(report.nextSteps.join(' ')).toContain('mora sync');
  });

  it('carries the capped tables into the result, so a count is not read as final', async () => {
    const root = await scaffoldProject();
    await runSync(root, { limit: '10', json: true });

    const report = await runQueryCommand(root, undefined, {
      expr: 'orders -> { aggregate: order_count }',
      json: true,
    });

    expect(report.local).toBe(true);
    expect(report.rows[0]?.order_count).toBe(10);
    expect(report.cappedTables).toEqual(['data/orders.csv']);
    expect(report.nextSteps.join(' ')).toContain('row limit');
  });

  it('runs a named definition against the cache when --local asks for it', async () => {
    const root = await scaffoldProject();
    await runSync(root, { json: true });

    const report = await runQueryCommand(root, 'monthly_revenue', { local: true, json: true });

    expect(report.ok).toBe(true);
    expect(report.local).toBe(true);
    expect(report.syncedAt).not.toBeNull();
  });

  it('refuses --local when there is no cache, naming the command that makes one', async () => {
    const root = await scaffoldProject();

    const error = await moraError(runQueryCommand(root, 'monthly_revenue', { local: true }));

    expect(error.code).toBe('cache-not-found');
    expect(error.hint).toContain('mora sync');
  });

  it('refuses --local and --remote together', async () => {
    const root = await scaffoldProject();

    const error = await moraError(
      runQueryCommand(root, 'monthly_revenue', { local: true, remote: true }),
    );

    expect(error.code).toBe('conflicting-source');
    expect(error.exitCode).toBe(2);
  });
});

describe('runValidate --local', () => {
  it('compiles against the cache and marks the result as local', async () => {
    const root = await scaffoldProject();
    await runSync(root, { json: true });

    const report = await runValidate(root, { local: true, json: true });

    expect(report.ok).toBe(true);
    expect(report.local).toBe(true);
    expect(report.summary.passed).toBe(1);
  });

  it('is not local by default', async () => {
    const root = await scaffoldProject();

    const report = await runValidate(root, { json: true });

    expect(report.ok).toBe(true);
    expect(report.local).toBe(false);
  });

  it('refuses --local when there is no cache', async () => {
    const root = await scaffoldProject();

    const error = await moraError(runValidate(root, { local: true, json: true }));

    expect(error.code).toBe('cache-not-found');
  });
});
