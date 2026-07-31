import { existsSync } from 'node:fs';
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
  revertScaffold,
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
    connectionName: 'duckdb',
    ...overrides,
  };
}

describe('buildScaffold', () => {
  it('includes the config, an empty models directory and the agent docs', () => {
    const paths = buildScaffold(spec()).map((file) => file.path);
    expect(paths).toEqual([
      'mora.yaml',
      'metrics/.gitkeep',
      'AGENTS.md',
      '.agents/malloy.md',
      '.agents/modeling.md',
      '.agents/mora.md',
      '.gitignore',
    ]);
  });

  it('writes no model and no data: what belongs there is the reader’s own tables', () => {
    const files = buildScaffold(spec());
    expect(files.some((file) => file.path.endsWith('.malloy'))).toBe(false);
    expect(files.some((file) => file.path.endsWith('.csv'))).toBe(false);
  });

  it('honours a custom models directory', () => {
    const paths = buildScaffold(spec({ modelsDir: 'models/core' })).map((file) => file.path);
    expect(paths).toContain('models/core/.gitkeep');
    expect(paths).not.toContain('metrics/.gitkeep');
  });
});

describe('generated agent docs', () => {
  function doc(docPath: string, overrides: Partial<ScaffoldSpec> = {}): string {
    const file = buildScaffold(spec(overrides)).find((f) => f.path === docPath);
    if (!file) throw new Error(`the scaffold writes no ${docPath}`);
    return file.contents;
  }

  it('tells an agent to discover before it proposes, and to check the data', () => {
    const guide = doc('.agents/modeling.md');

    // The listing is the entry point, which is what makes guessing a table name
    // unnecessary.
    expect(guide).toContain('mora schema --json');
    expect(guide).toContain('Never infer meaning from a column name');
    // The decisions a schema alone cannot answer.
    expect(guide).toContain('join_one');
    expect(guide).toContain('duplicate_keys');
    // A scope is agreed with a human before any file is written.
    expect(guide).toContain('let a human choose');
    expect(guide).toContain('pull request');
  });

  it('shows the throwaway source in a form that runs', () => {
    const guide = doc('.agents/modeling.md');

    // Unreviewed Malloy is a whole document, so the source and the query that
    // reads it have to travel together; half of this pair does nothing alone.
    expect(guide).toContain("source: probe is duckdb.table('data/orders.csv') extend {}");
    expect(guide).toContain('run: probe ->');
  });

  it('sends an agent to the models themselves for the vocabulary', () => {
    const agents = doc('AGENTS.md');
    const guide = doc('.agents/mora.md');

    // There is no `describe` command: the models are in the checkout, and
    // reading them says more than any listing would.
    expect(agents).not.toContain('mora describe');
    expect(guide).not.toContain('mora describe');
    expect(agents).toContain('Read the models in `metrics/`');
  });

  it('writes sample code against the project’s own connection and table shape', () => {
    const guide = doc('.agents/malloy.md', {
      database: 'bigquery',
      connectionName: 'warehouse',
    });

    expect(guide).toContain("source: orders is warehouse.table('analytics.orders')");
    // The table is an illustration, and saying so keeps an agent from looking
    // for a file the scaffold never wrote.
    expect(guide).toContain('not a table this project has');
  });

  it('names the models directory this project actually uses', () => {
    const guide = doc('.agents/modeling.md', { modelsDir: 'models/core' });

    expect(guide).toContain('models/core/');
    expect(guide).not.toContain('metrics/');
  });

  it('points AGENTS.md at the guide and at the command it opens with', () => {
    const agents = doc('AGENTS.md');

    expect(agents).toContain('.agents/modeling.md');
    expect(agents).toContain('mora schema');
    // Required reading, not just a line in the layout listing.
    expect(agents).toMatch(/Read `\.agents\/modeling\.md` before proposing a model/);
  });

  it('documents mora schema in the command reference', () => {
    const guide = doc('.agents/mora.md');

    expect(guide).toContain('## mora schema');
    // The distinction that stops an agent reading the warehouse when it meant
    // to read the semantic layer over it.
    expect(guide).toContain('Shows the *warehouse*');
    expect(guide).toContain('truncated');
  });

  it('documents running a probe from a file, which is how a real one is written', () => {
    const guide = doc('.agents/mora.md');
    const modeling = doc('.agents/modeling.md');

    expect(guide).toContain('-f, --file <path>');
    expect(modeling).toContain('mora query -f');
  });
});

interface ParsedConfig {
  version: number;
  project: { name: string; models: string; default_connection: string };
  connections: Record<string, Record<string, unknown> | undefined>;
}

describe('generated mora.yaml', () => {
  function config(overrides: Partial<ScaffoldSpec> = {}): ParsedConfig {
    const file = buildScaffold(spec(overrides)).find((f) => f.path === CONFIG_FILENAME);
    return parseYaml(file?.contents ?? '') as ParsedConfig;
  }

  it('is valid YAML describing the project and a working DuckDB connection', () => {
    const parsed = config();
    expect(parsed.version).toBe(1);
    expect(parsed.project).toEqual({
      name: 'analytics',
      models: 'metrics',
      default_connection: 'duckdb',
    });
    // The models directory, not a data directory: a table path written relative
    // to the package root is what Publisher can also resolve.
    expect(parsed.connections.duckdb).toEqual({
      type: 'duckdb',
      database: ':memory:',
      working_directory: 'metrics',
    });
  });

  it('keeps the default under project, so connections holds only connections', () => {
    const parsed = config();
    expect(parsed.project.default_connection).toBe('duckdb');
    expect(Object.keys(parsed.connections)).toEqual(['duckdb']);
  });

  it('declares one connection: the one that was asked for', () => {
    const parsed = config({ database: 'bigquery', connectionName: 'warehouse' });
    expect(Object.keys(parsed.connections)).toEqual(['warehouse']);
    expect(parsed.project.default_connection).toBe('warehouse');
    expect(parsed.connections.warehouse?.type).toBe('bigquery');
  });

  it('defaults BigQuery to an env-var project id so credentials stay out of mora.yaml', () => {
    const projectRef = '\u0024{GOOGLE_CLOUD_PROJECT}';
    const parsed = config({ database: 'bigquery', connectionName: 'bigquery' });
    expect(parsed.connections.bigquery).toMatchObject({
      type: 'bigquery',
      project_id: projectRef,
    });
    expect(parsed.connections.bigquery?.location).toBeUndefined();
    expect(parsed.connections.bigquery?.service_account_key_path).toBeUndefined();
  });

  it('writes the connection settings collected during init', () => {
    const keyRef = '\u0024{GOOGLE_APPLICATION_CREDENTIALS}';
    const file = buildScaffold(
      spec({
        database: 'bigquery',
        connectionName: 'warehouse',
        connectionSettings: {
          project_id: 'acme-prod',
          location: 'EU',
          service_account_key_path: keyRef,
        },
      }),
    ).find((f) => f.path === CONFIG_FILENAME);

    const parsed = parseYaml(file?.contents ?? '') as ParsedConfig;
    expect(parsed.connections.warehouse).toEqual({
      type: 'bigquery',
      project_id: 'acme-prod',
      location: 'EU',
      service_account_key_path: keyRef,
    });
    // Optional settings that were skipped stay as commented hints.
    expect(file?.contents).toContain('# billing_project_id:');
    expect(file?.contents).toContain('The project whose tables the models read.');
  });
});

describe('writeScaffold', () => {
  it('creates every file and reports the action taken', async () => {
    const root = await tempDir();
    const { written } = await writeScaffold(root, buildScaffold(spec()));

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

    const { written: again } = await writeScaffold(root, files);
    expect(again.find((file) => file.path === '.agents/mora.md')?.action).toBe('unchanged');

    await writeFile(path.join(root, '.agents/mora.md'), 'an older version\n', 'utf8');
    const { written: refreshed } = await writeScaffold(root, files);
    expect(refreshed.find((file) => file.path === '.agents/mora.md')?.action).toBe('overwritten');
    await expect(readFile(path.join(root, '.agents/mora.md'), 'utf8')).resolves.toContain(
      'mora query',
    );
  });

  it('merges into an existing .gitignore without duplicating entries', async () => {
    const root = await tempDir();
    await writeFile(path.join(root, '.gitignore'), 'node_modules/\n.mora/\n', 'utf8');
    const files = buildScaffold(spec());

    const { written: first } = await writeScaffold(root, files);
    expect(first.find((file) => file.path === '.gitignore')?.action).toBe('updated');

    const { written: second } = await writeScaffold(root, files);
    expect(second.find((file) => file.path === '.gitignore')?.action).toBe('unchanged');

    const contents = await readFile(path.join(root, '.gitignore'), 'utf8');
    const mora = contents.split('\n').filter((line) => line.trim() === '.mora/');
    expect(mora).toHaveLength(1);
    expect(contents).toContain('node_modules/');
  });
});

describe('revertScaffold', () => {
  it('leaves a directory it wrote into as empty as it found it', async () => {
    const root = path.join(await tempDir(), 'nested', 'project');
    const { snapshot } = await writeScaffold(root, buildScaffold(spec()));
    expect(existsSync(path.join(root, CONFIG_FILENAME))).toBe(true);

    await revertScaffold(snapshot);

    // Including the directories: a scaffold that was taken back should not
    // leave an empty tree behind for someone to wonder about.
    expect(existsSync(root)).toBe(false);
    expect(existsSync(path.dirname(root))).toBe(false);
  });

  it('gives back the contents of a file it overwrote', async () => {
    const root = await tempDir();
    await writeFile(path.join(root, 'AGENTS.md'), '# Ours\n\nA rule we wrote.\n', 'utf8');
    await writeFile(path.join(root, '.gitignore'), 'node_modules/\n', 'utf8');

    const { snapshot } = await writeScaffold(root, buildScaffold(spec()));
    await revertScaffold(snapshot);

    await expect(readFile(path.join(root, 'AGENTS.md'), 'utf8')).resolves.toBe(
      '# Ours\n\nA rule we wrote.\n',
    );
    await expect(readFile(path.join(root, '.gitignore'), 'utf8')).resolves.toBe('node_modules/\n');
    expect(existsSync(path.join(root, CONFIG_FILENAME))).toBe(false);
    expect(existsSync(path.join(root, 'metrics'))).toBe(false);
  });

  it('keeps a directory that has gained something of someone else’s', async () => {
    const root = await tempDir();
    const { snapshot } = await writeScaffold(root, buildScaffold(spec()));
    await writeFile(path.join(root, 'metrics', 'mine.malloy'), '// mine\n', 'utf8');

    await revertScaffold(snapshot);

    expect(existsSync(path.join(root, 'metrics', 'mine.malloy'))).toBe(true);
    expect(existsSync(path.join(root, 'metrics', '.gitkeep'))).toBe(false);
  });
});
