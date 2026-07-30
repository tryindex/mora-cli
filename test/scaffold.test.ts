import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  assertConfigParses,
  buildScaffold,
  CONFIG_FILENAME,
  findConflicts,
  MANAGED_BEGIN,
  MANAGED_END,
  type ScaffoldSpec,
  writeScaffold,
} from '../src/scaffold.js';

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'mora-test-'));
}

function spec(overrides: Partial<ScaffoldSpec> = {}): ScaffoldSpec {
  return {
    root: '/tmp/unused',
    projectName: 'analytics',
    database: 'duckdb',
    modelsDir: 'metrics',
    includeExample: true,
    ...overrides,
  };
}

describe('buildScaffold', () => {
  it('includes the config, model, sample data and agent docs', () => {
    const paths = buildScaffold(spec()).map((file) => file.path);
    expect(paths).toEqual([
      'mora.yaml',
      'metrics/data/orders.csv',
      'metrics/example.malloy',
      'AGENTS.md',
      '.agents/malloy.md',
      '.agents/mora.md',
      '.gitignore',
    ]);
  });

  it('drops the example but keeps the models directory when asked', () => {
    const paths = buildScaffold(spec({ includeExample: false })).map((file) => file.path);
    expect(paths).toContain('metrics/.gitkeep');
    expect(paths).not.toContain('metrics/example.malloy');
  });

  it('honours a custom models directory', () => {
    const paths = buildScaffold(spec({ modelsDir: 'models/core' })).map((file) => file.path);
    expect(paths).toContain('models/core/example.malloy');
    expect(paths).toContain('models/core/data/orders.csv');
  });
});

interface ParsedConfig {
  version: number;
  project: { name: string; models: string };
  connections: {
    default: string;
    duckdb?: Record<string, unknown>;
    warehouse?: Record<string, unknown>;
  };
}

describe('generated mora.yaml', () => {
  function config(overrides: Partial<ScaffoldSpec> = {}): ParsedConfig {
    const file = buildScaffold(spec(overrides)).find((f) => f.path === CONFIG_FILENAME);
    return parseYaml(file?.contents ?? '') as ParsedConfig;
  }

  it('is valid YAML describing the project and a working DuckDB connection', () => {
    const parsed = config();
    expect(parsed.version).toBe(1);
    expect(parsed.project).toEqual({ name: 'analytics', models: 'metrics' });
    expect(parsed.connections.default).toBe('duckdb');
    expect(parsed.connections.duckdb).toEqual({
      type: 'duckdb',
      database: ':memory:',
      working_directory: 'metrics/data',
    });
  });

  it('leaves warehouse connections commented out for a DuckDB project', () => {
    expect(config().connections.warehouse).toBeUndefined();
  });

  it('activates the chosen warehouse and points the default at it', () => {
    const parsed = config({ database: 'bigquery' });
    expect(parsed.connections.default).toBe('warehouse');
    expect(parsed.connections.warehouse?.type).toBe('bigquery');
    // DuckDB stays available so the project always has one usable connection.
    expect(parsed.connections.duckdb?.type).toBe('duckdb');
  });
});

describe('writeScaffold', () => {
  it('creates every file and reports the action taken', async () => {
    const root = await tempDir();
    const written = await writeScaffold(root, buildScaffold(spec()));

    expect(written.every((file) => file.action === 'created')).toBe(true);
    await assertConfigParses(root);
    await expect(readFile(path.join(root, 'AGENTS.md'), 'utf8')).resolves.toContain(
      'semantic layer',
    );
  });

  it('gives AGENTS.md a heading above the managed block and a team section below it', async () => {
    const root = await tempDir();
    await writeScaffold(root, buildScaffold(spec()));

    const contents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    const [begin, end] = [contents.indexOf(MANAGED_BEGIN), contents.indexOf(MANAGED_END)];

    expect(contents.startsWith('# Working with the analytics semantic layer')).toBe(true);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    expect(contents.indexOf('## Team conventions')).toBeGreaterThan(end);
  });

  it('reports conflicts instead of silently replacing files', async () => {
    const root = await tempDir();
    const files = buildScaffold(spec());
    await writeScaffold(root, files);

    const conflicts = findConflicts(root, files);
    expect(conflicts).toContain('mora.yaml');
    // .gitignore merges rather than replaces, so it is never a conflict.
    expect(conflicts).not.toContain('.gitignore');
    // Mora owns its own docs outright, so an older copy of one is not a conflict.
    expect(conflicts).not.toContain('.agents/malloy.md');
  });

  it('rewrites its own docs only when they have changed', async () => {
    const root = await tempDir();
    const files = buildScaffold(spec());
    await writeScaffold(root, files);

    const again = await writeScaffold(root, files);
    expect(again.find((file) => file.path === '.agents/mora.md')?.action).toBe('unchanged');

    await writeFile(path.join(root, '.agents/mora.md'), 'an older version\n', 'utf8');
    const refreshed = await writeScaffold(root, files);
    expect(refreshed.find((file) => file.path === '.agents/mora.md')?.action).toBe('overwritten');
    await expect(readFile(path.join(root, '.agents/mora.md'), 'utf8')).resolves.toContain(
      'mora describe',
    );
  });

  it('merges into an existing .gitignore without duplicating entries', async () => {
    const root = await tempDir();
    await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.mora/\n', 'utf8');
    const files = buildScaffold(spec());

    const first = await writeScaffold(root, files);
    expect(first.find((file) => file.path === '.gitignore')?.action).toBe('updated');

    const second = await writeScaffold(root, files);
    expect(second.find((file) => file.path === '.gitignore')?.action).toBe('unchanged');

    const contents = await readFile(path.join(root, '.gitignore'), 'utf8');
    const mora = contents.split('\n').filter((line) => line.trim() === '.mora/');
    expect(mora).toHaveLength(1);
    expect(contents).toContain('node_modules/');
  });
});
