import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type DescribeReport, runDescribe } from '../src/commands/describe.js';
import {
  type FieldDescription,
  indexDefinitions,
  resolveDefinition,
  type Vocabulary,
} from '../src/malloy/describe.js';
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
  const root = await mkdtemp(path.join(tmpdir(), 'mora-describe-'));
  await writeScaffold(root, buildScaffold({ ...spec, ...overrides, root }));
  if (withModel) await writeOrdersModel(root);
  return root;
}

function names(fields: { name: string }[]): string[] {
  return fields.map((field) => field.name);
}

function field(fields: FieldDescription[], name: string): FieldDescription {
  const found = fields.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no field named ${name} in ${names(fields).join(', ')}`);
  return found;
}

function source(report: DescribeReport, name: string) {
  const found = report.sources.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no source named ${name} in ${names(report.sources).join(', ')}`);
  return found;
}

describe('runDescribe', () => {
  it('reads the vocabulary out of the models on disk', async () => {
    const root = await scaffoldProject();

    const report = await runDescribe(root, undefined, { json: true });

    expect(report.ok).toBe(true);
    expect(report.command).toBe('describe');
    expect(report.pattern).toBeNull();
    expect(report.project).toEqual({ name: 'analytics', models: 'metrics' });

    const orders = source(report, 'orders');
    expect(orders.model).toBe('metrics/orders.malloy');
    // An aggregate is a measure; a row-level attribute is a dimension. That
    // split is the whole point of the listing.
    expect(names(orders.measures)).toContain('revenue');
    expect(names(orders.dimensions)).toContain('ordered_at');
    expect(names(orders.dimensions)).not.toContain('revenue');
    expect(names(orders.views)).toContain('revenue_by_month');
    // Raw table columns are part of the vocabulary too.
    expect(names(orders.dimensions)).toContain('amount');
  });

  it('lists the named queries that can be run directly', async () => {
    const root = await scaffoldProject();

    const report = await runDescribe(root, undefined, { json: true });

    expect(names(report.queries)).toEqual([
      'monthly_revenue',
      'regional_performance',
      'completed_revenue_by_month',
    ]);
    expect(report.summary.sources).toBe(1);
    expect(report.summary.queries).toBe(3);
  });

  it('narrows to matching names, keeping the source they belong to', async () => {
    const root = await scaffoldProject();

    const report = await runDescribe(root, 'REVENUE', { json: true });

    expect(report.pattern).toBe('REVENUE');
    const orders = source(report, 'orders');
    expect(names(orders.measures)).toContain('revenue');
    expect(names(orders.views)).toContain('revenue_by_month');
    // No dimension mentions revenue, by name or in its description.
    expect(orders.dimensions).toEqual([]);
    expect(names(report.queries)).toContain('monthly_revenue');
  });

  it('carries the doc string of each definition', async () => {
    const root = await scaffoldProject();

    const report = await runDescribe(root, undefined, { json: true });

    const orders = source(report, 'orders');
    expect(orders.description).toBeTruthy();
    expect(field(orders.measures, 'revenue').description).toBe(
      'Total order amount, including orders that are not yet completed.',
    );
    // A query that only runs a view is described by that view.
    expect(report.queries[0]?.description).toBe('Revenue and order count for each month.');
  });

  it('finds a definition by words that appear only in its description', async () => {
    const root = await scaffoldProject();

    const report = await runDescribe(root, 'threshold', { json: true });

    expect(names(source(report, 'orders').dimensions)).toEqual(['is_large_order']);
  });

  it('shows a whole source when the source itself matches', async () => {
    const root = await scaffoldProject();

    const report = await runDescribe(root, 'orders', { json: true });

    expect(source(report, 'orders').dimensions.length).toBeGreaterThan(1);
  });

  it('reports nothing rather than failing when a pattern matches nothing', async () => {
    const root = await scaffoldProject();

    const report = await runDescribe(root, 'no_such_thing', { json: true });

    expect(report.ok).toBe(true);
    expect(report.sources).toEqual([]);
    expect(report.queries).toEqual([]);
  });

  it('reports a model that does not compile instead of describing half a project', async () => {
    const root = await scaffoldProject();
    await writeFile(
      path.join(root, 'metrics/broken.malloy'),
      "source: broken is duckdb.table('data/orders.csv') extend {\n  measure: x is nope.sum()\n}\n",
      'utf8',
    );

    const report = await runDescribe(root, undefined, { json: true });

    expect(report.ok).toBe(false);
    expect(report.failures[0]?.model).toBe('metrics/broken.malloy');
    expect(report.failures[0]?.error).toContain('nope');
    // The models that did compile are still described.
    expect(names(report.sources)).toContain('orders');
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
