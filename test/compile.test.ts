import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileModel } from '../src/malloy/compile.js';
import { buildScaffold, resolvePaths, type ScaffoldSpec, writeScaffold } from '../src/scaffold.js';

const spec: ScaffoldSpec = {
  root: '',
  projectName: 'analytics',
  database: 'duckdb',
  modelsDir: 'semantic',
  includeExample: true,
};

async function scaffoldProject() {
  const root = await mkdtemp(path.join(tmpdir(), 'mora-compile-'));
  await writeScaffold(root, buildScaffold({ ...spec, root }));
  const paths = resolvePaths(spec);
  return {
    root,
    modelPath: path.join(root, paths.exampleModelPath),
    workingDirectory: path.join(root, paths.dataDir),
  };
}

describe('compileModel', () => {
  it('compiles the scaffolded example against DuckDB', async () => {
    const project = await scaffoldProject();

    const result = await compileModel({
      modelPath: project.modelPath,
      workingDirectory: project.workingDirectory,
      connectionName: 'duckdb',
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe('passed');
    expect(result.sources).toContain('orders');
    expect(result.queries).toEqual(
      expect.arrayContaining(['monthly_revenue', 'regional_performance']),
    );
  });

  it('reports a failure rather than throwing when the model is broken', async () => {
    const project = await scaffoldProject();
    await writeFile(
      project.modelPath,
      "source: orders is duckdb.table('orders.csv') extend {\n" +
        '  measure: revenue is no_such_column.sum()\n' +
        '}\n',
      'utf8',
    );

    const result = await compileModel({
      modelPath: project.modelPath,
      workingDirectory: project.workingDirectory,
      connectionName: 'duckdb',
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
  });
});
