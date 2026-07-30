import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runValidate } from '../src/commands/validate.js';
import { loadConfig, parseConfig, resolveDuckDbConnection } from '../src/config.js';
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
  const root = await mkdtemp(path.join(tmpdir(), 'mora-validate-'));
  await writeScaffold(root, buildScaffold({ ...spec, ...overrides, root }));
  return root;
}

function model(name: string, body: string): string {
  return `source: ${name} is duckdb.table('orders.csv') extend {\n${body}\n}\n`;
}

describe('runValidate', () => {
  it('compiles a freshly scaffolded project', async () => {
    const root = await scaffoldProject();

    const report = await runValidate(root, { json: true });

    expect(report.ok).toBe(true);
    expect(report.command).toBe('validate');
    expect(report.connection).toBe('duckdb');
    expect(report.project).toEqual({ name: 'analytics', models: 'metrics' });
    expect(report.summary).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(report.models[0]?.path).toBe('metrics/example.malloy');
    expect(report.models[0]?.sources).toContain('orders');
    expect(report.models[0]?.queries).toContain('monthly_revenue');
  });

  it('reports a broken model as failed without throwing', async () => {
    const root = await scaffoldProject();
    await writeFile(
      path.join(root, 'metrics/example.malloy'),
      model('orders', '  measure: revenue is no_such_column.sum()'),
      'utf8',
    );

    const report = await runValidate(root, { json: true });

    expect(report.ok).toBe(false);
    expect(report.summary.failed).toBe(1);
    expect(report.models[0]?.status).toBe('failed');
    expect(report.models[0]?.error).toContain('no_such_column');
  });

  it('reports every model separately, in a stable order', async () => {
    const root = await scaffoldProject();
    await writeFile(
      path.join(root, 'metrics/revenue.malloy'),
      model('revenue', '  measure: order_count is count()'),
      'utf8',
    );
    await writeFile(
      path.join(root, 'metrics/broken.malloy'),
      model('broken', '  measure: revenue is missing_column.sum()'),
      'utf8',
    );

    const report = await runValidate(root, { json: true });

    expect(report.models.map((m) => m.path)).toEqual([
      'metrics/broken.malloy',
      'metrics/example.malloy',
      'metrics/revenue.malloy',
    ]);
    expect(report.summary).toEqual({ total: 3, passed: 2, failed: 1, skipped: 0 });
    expect(report.ok).toBe(false);
  });

  it('finds models in nested directories but ignores the data directory', async () => {
    const root = await scaffoldProject();
    await writeFile(
      path.join(root, 'metrics/data/notes.malloy'),
      model('ignored', '  measure: order_count is count()'),
      'utf8',
    );
    await writeFile(
      path.join(root, 'metrics/core.malloy'),
      model('core', '  measure: order_count is count()'),
      'utf8',
    );

    const report = await runValidate(root, { json: true });

    expect(report.models.map((m) => m.path)).toEqual([
      'metrics/core.malloy',
      'metrics/example.malloy',
    ]);
  });

  it('warns rather than fails when the project has no models yet', async () => {
    const root = await scaffoldProject({ includeExample: false });

    const report = await runValidate(root, { json: true });

    expect(report.ok).toBe(true);
    expect(report.models).toEqual([]);
    expect(report.summary.total).toBe(0);
  });

  it('explains that a warehouse connection cannot be compiled', async () => {
    const root = await scaffoldProject({ database: 'bigquery' });
    await writeFile(
      path.join(root, 'metrics/example.malloy'),
      "source: sales is warehouse.table('sales') extend {\n  measure: revenue is amount.sum()\n}\n",
      'utf8',
    );

    const report = await runValidate(root, { json: true });

    expect(report.ok).toBe(false);
    // DuckDB stays available, so validation still runs against it.
    expect(report.connection).toBe('duckdb');
    expect(report.models[0]?.error).toContain('warehouse');
    expect(report.models[0]?.error).toContain('bigquery');
  });

  it('refuses to run without a mora.yaml', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mora-empty-'));

    await expect(runValidate(root, { json: true })).rejects.toMatchObject({
      code: 'config-not-found',
    });
  });

  it('refuses to run when the models directory is missing', async () => {
    const root = await scaffoldProject();
    await rm(path.join(root, 'metrics'), { recursive: true, force: true });

    await expect(runValidate(root, { json: true })).rejects.toMatchObject({
      code: 'models-dir-not-found',
    });
  });
});

describe('loadConfig', () => {
  it('reads the generated config', async () => {
    const root = await scaffoldProject();

    const config = await loadConfig(root);

    expect(config.projectName).toBe('analytics');
    expect(config.modelsDir).toBe('metrics');
    expect(config.defaultConnection).toBe('duckdb');
    expect(resolveDuckDbConnection(config)).toEqual({
      name: 'duckdb',
      type: 'duckdb',
      supported: true,
      database: ':memory:',
      workingDirectory: path.join(root, 'metrics/data'),
    });
  });

  it('prefers the default connection when several DuckDB connections exist', () => {
    const config = parseConfig(
      [
        'version: 1',
        'project:',
        '  name: analytics',
        '  models: metrics',
        'connections:',
        '  default: warm',
        '  cold:',
        '    type: duckdb',
        '  warm:',
        '    type: duckdb',
        '    database: warm.duckdb',
      ].join('\n'),
      '/tmp/project',
    );

    expect(resolveDuckDbConnection(config)?.name).toBe('warm');
    expect(resolveDuckDbConnection(config)?.database).toBe(
      path.resolve('/tmp/project/warm.duckdb'),
    );
  });

  it('keeps unsupported connections but marks them as such', () => {
    const config = parseConfig(
      [
        'project:',
        '  models: metrics',
        'connections:',
        '  default: warehouse',
        '  warehouse:',
        '    type: bigquery',
        '    project_id: my-gcp-project',
      ].join('\n'),
      '/tmp/project',
    );

    expect(config.connections).toEqual([{ name: 'warehouse', type: 'bigquery', supported: false }]);
    expect(resolveDuckDbConnection(config)).toBeUndefined();
  });

  it('falls back to the directory name when the project has no name', () => {
    const config = parseConfig('project:\n  models: metrics\n', '/tmp/retail-analytics');
    expect(config.projectName).toBe('retail-analytics');
  });

  it.each([
    ['not YAML at all', 'project: [unclosed'],
    ['a missing project block', 'version: 1\n'],
    ['a missing models directory', 'project:\n  name: analytics\n'],
    ['a models directory outside the project', 'project:\n  models: ../elsewhere\n'],
    ['an unsupported version', 'version: 2\nproject:\n  models: metrics\n'],
    ['a connection without a type', 'project:\n  models: metrics\nconnections:\n  db: {}\n'],
    ['connections that are not a mapping', 'project:\n  models: metrics\nconnections: nope\n'],
  ])('rejects %s', (_case, contents) => {
    expect(() => parseConfig(contents, '/tmp/project')).toThrow(MoraError);
  });
});
