import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runConnectionAdd,
  runConnectionList,
  runConnectionTest,
} from '../src/commands/connection.js';
import { runQueryCommand } from '../src/commands/query.js';
import { runValidate } from '../src/commands/validate.js';
import { loadConfig } from '../src/config.js';
import { addConnection, syncEnvExample } from '../src/connections.js';
import { resolveEnvRefs } from '../src/env.js';
import { buildScaffold, type ScaffoldSpec, writeScaffold } from '../src/scaffold.js';
import { writeOrdersModel } from './helpers/fixtures.js';

const spec: ScaffoldSpec = {
  root: '',
  projectName: 'analytics',
  database: 'duckdb',
  modelsDir: 'metrics',
  connectionName: 'duckdb',
};

/** Written as an escape so it stays a literal `${...}` reference. */
const PROJECT_REF = '\u0024{GOOGLE_CLOUD_PROJECT}';

/** A variable no machine will have set, for asserting on the unset case. */
const UNSET_REF = '\u0024{MORA_TEST_UNSET_CREDENTIAL}';

afterEach(() => {
  vi.unstubAllEnvs();
});

async function scaffoldProject(overrides: Partial<ScaffoldSpec> = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mora-connections-'));
  await writeScaffold(root, buildScaffold({ ...spec, ...overrides, root }));
  return root;
}

/**
 * A project whose models read from two different connections. Two DuckDB
 * connections prove the wiring without credentials: they resolve table paths
 * from different directories, so a model can only compile if its own connection
 * is the one that opened it.
 */
async function twoConnectionProject(): Promise<string> {
  const root = await scaffoldProject();
  await writeOrdersModel(root);

  await mkdir(path.join(root, 'exports'), { recursive: true });
  await writeFile(
    path.join(root, 'exports/regions.csv'),
    'region,amount\nwest,10\neast,20\nwest,5\n',
    'utf8',
  );
  await writeFile(
    path.join(root, 'metrics/regions.malloy'),
    [
      '#" Regional totals, read from the exports connection.',
      "source: regions is exports.table('regions.csv') extend {",
      '  #" Total amount across the rows.',
      '  measure: total is amount.sum()',
      '  #" Amount per region.',
      '  view: by_region is { group_by: region; aggregate: total }',
      '}',
      '',
      'query: regional_totals is regions -> by_region',
      '',
    ].join('\n'),
    'utf8',
  );

  const config = await loadConfig(root);
  await addConnection(config, {
    name: 'exports',
    type: 'duckdb',
    settings: { database: ':memory:', working_directory: 'exports' },
    makeDefault: false,
  });

  return root;
}

describe('a project with more than one connection', () => {
  it('compiles every model against the connection it names', async () => {
    const root = await twoConnectionProject();

    const report = await runValidate(root, { json: true });

    expect(report.ok).toBe(true);
    expect(report.connections).toEqual(['duckdb', 'exports']);
    expect(report.connection).toBe('duckdb');
    expect(report.models.map((model) => model.path)).toEqual([
      'metrics/orders.malloy',
      'metrics/regions.malloy',
    ]);
  });

  it('runs a query against a connection that is not the default', async () => {
    const root = await twoConnectionProject();

    const report = await runQueryCommand(root, 'regional_totals', { json: true });

    expect(report.ok).toBe(true);
    expect(report.model).toBe('metrics/regions.malloy');
    // DuckDB returns a SUM as a string, which Malloy passes through as-is.
    expect(report.rows).toEqual([
      { region: 'east', total: '20' },
      { region: 'west', total: '15' },
    ]);
  });
});

describe('resolveEnvRefs', () => {
  it('leaves a setting with no references alone', () => {
    expect(resolveEnvRefs('acme-prod', { processEnv: {} })).toEqual({
      value: 'acme-prod',
      missing: [],
    });
  });

  it('prefers the process environment over the project .env', () => {
    const resolved = resolveEnvRefs(PROJECT_REF, {
      processEnv: { GOOGLE_CLOUD_PROJECT: 'from-shell' },
      envFile: { GOOGLE_CLOUD_PROJECT: 'from-file' },
    });

    // A shell or CI run overrides a value someone checked out.
    expect(resolved).toEqual({ value: 'from-shell', missing: [] });
  });

  it('falls back to the project .env', () => {
    const resolved = resolveEnvRefs(PROJECT_REF, {
      processEnv: {},
      envFile: { GOOGLE_CLOUD_PROJECT: 'from-file' },
    });

    expect(resolved).toEqual({ value: 'from-file', missing: [] });
  });

  it('resolves to nothing, naming what is unset, rather than to a partial value', () => {
    const resolved = resolveEnvRefs('\u0024{PROJECT}.\u0024{DATASET}', {
      processEnv: { PROJECT: 'acme' },
    });

    expect(resolved).toEqual({ value: undefined, missing: ['DATASET'] });
  });

  it('treats an empty variable as unset', () => {
    expect(resolveEnvRefs(PROJECT_REF, { processEnv: { GOOGLE_CLOUD_PROJECT: '  ' } })).toEqual({
      value: undefined,
      missing: ['GOOGLE_CLOUD_PROJECT'],
    });
  });
});

describe('addConnection', () => {
  it('keeps the comments and layout the file already had', async () => {
    const root = await scaffoldProject();
    const configPath = path.join(root, 'mora.yaml');
    const before = await readFile(configPath, 'utf8');
    await writeFile(configPath, `${before}\n# Team note: ask Dana before editing.\n`, 'utf8');

    await addConnection(await loadConfig(root), {
      name: 'warehouse',
      type: 'bigquery',
      settings: { project_id: PROJECT_REF },
      comments: { project_id: 'The project whose tables the models read.' },
      makeDefault: false,
    });

    const after = await readFile(configPath, 'utf8');
    expect(after).toContain('# Connection used by models that do not name one explicitly.');
    expect(after).toContain('# Team note: ask Dana before editing.');
    expect(after).toContain('# The project whose tables the models read.');

    const config = await loadConfig(root);
    expect(config.defaultConnection).toBe('duckdb');
    expect(config.connections.map((entry) => entry.name)).toEqual(['duckdb', 'warehouse']);
    expect(config.requiredEnvVars).toEqual(['GOOGLE_CLOUD_PROJECT']);
  });

  it('points the default at the new connection when asked', async () => {
    const root = await scaffoldProject();

    await addConnection(await loadConfig(root), {
      name: 'warehouse',
      type: 'bigquery',
      settings: { project_id: 'acme-prod' },
      makeDefault: true,
    });

    // The default is a property of the project, so it is written there rather
    // than as a reserved key among the connection names.
    const contents = await readFile(path.join(root, 'mora.yaml'), 'utf8');
    expect(contents).toContain('  default_connection: warehouse');
    expect((await loadConfig(root)).defaultConnection).toBe('warehouse');
  });

  it('accepts a connection called `default`, which is no longer reserved', async () => {
    const root = await scaffoldProject();

    await addConnection(await loadConfig(root), {
      name: 'default',
      type: 'duckdb',
      settings: { database: ':memory:' },
      makeDefault: true,
    });

    const config = await loadConfig(root);
    expect(config.connections.map((entry) => entry.name)).toEqual(['duckdb', 'default']);
    expect(config.defaultConnection).toBe('default');
  });

  it('refuses a name the project already uses', async () => {
    const root = await scaffoldProject();

    await expect(
      addConnection(await loadConfig(root), {
        name: 'duckdb',
        type: 'duckdb',
        settings: { database: ':memory:' },
        makeDefault: false,
      }),
    ).rejects.toMatchObject({ code: 'connection-exists' });
  });

  it('refuses a name a model could not refer to', async () => {
    const root = await scaffoldProject();

    await expect(
      addConnection(await loadConfig(root), {
        name: 'my warehouse',
        type: 'duckdb',
        settings: {},
        makeDefault: false,
      }),
    ).rejects.toMatchObject({ code: 'invalid-connection-name' });
  });
});

describe('syncEnvExample', () => {
  it('records a new variable without disturbing the ones already listed', async () => {
    const root = await scaffoldProject();
    await writeFile(
      path.join(root, '.env.example'),
      '# Fill these in.\nEXISTING_TOKEN=put-yours-here\n',
      'utf8',
    );

    const update = await syncEnvExample(
      root,
      'analytics',
      ['connections:', '  warehouse:', '    type: bigquery', `    project_id: ${PROJECT_REF}`].join(
        '\n',
      ),
    );

    expect(update).toEqual({
      path: '.env.example',
      action: 'updated',
      added: ['GOOGLE_CLOUD_PROJECT'],
    });
    const contents = await readFile(path.join(root, '.env.example'), 'utf8');
    expect(contents).toContain('EXISTING_TOKEN=put-yours-here');
    expect(contents).toContain('GOOGLE_CLOUD_PROJECT=');
  });

  it('says nothing changed when every variable is already listed', async () => {
    const root = await scaffoldProject();
    await writeFile(path.join(root, '.env.example'), 'GOOGLE_CLOUD_PROJECT=\n', 'utf8');

    const update = await syncEnvExample(
      root,
      'analytics',
      ['connections:', '  warehouse:', `    project_id: ${PROJECT_REF}`].join('\n'),
    );

    expect(update).toEqual({ path: '.env.example', action: 'unchanged', added: [] });
  });
});

describe('mora connection add', () => {
  it('adds a DuckDB connection and proves it answers', async () => {
    const root = await scaffoldProject();
    await mkdir(path.join(root, 'exports'), { recursive: true });

    const report = await runConnectionAdd(root, 'exports', {
      type: 'duckdb',
      workingDirectory: 'exports',
      json: true,
    });

    expect(report.ok).toBe(true);
    expect(report.connection.settings).toEqual({
      database: ':memory:',
      working_directory: 'exports',
    });
    expect(report.test?.ok).toBe(true);
    expect(report.isDefault).toBe(false);
    expect(report.files).toEqual(['mora.yaml']);
  });

  it('writes a credential as a reference, not a value, and says what is unset', async () => {
    const root = await scaffoldProject();
    // Whether this machine happens to have GCP credentials is not what is under
    // test here, so the variable is unset for the duration.
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);

    const report = await runConnectionAdd(root, 'warehouse', { type: 'bigquery', json: true });

    // mora.yaml is committed, so a secret written into it is a secret leaked.
    expect(report.connection.settings.project_id).toBe(PROJECT_REF);
    expect(report.missingEnvVars).toEqual(['GOOGLE_CLOUD_PROJECT']);
    // A DuckDB project needs no credentials, so it has no .env.example yet.
    expect(report.envExample).toMatchObject({ action: 'created', added: ['GOOGLE_CLOUD_PROJECT'] });
    // Nothing to test against, and the missing variable is already the next step.
    expect(report.test).toBeNull();
    expect(report.nextSteps[0]).toContain('GOOGLE_CLOUD_PROJECT');
  });

  it('takes a literal value over the environment reference when one is given', async () => {
    const root = await scaffoldProject();

    const report = await runConnectionAdd(root, 'warehouse', {
      type: 'bigquery',
      projectId: 'acme-prod',
      location: 'US',
      json: true,
    });

    expect(report.connection.settings).toEqual({
      project_id: 'acme-prod',
      location: 'US',
    });
    expect(report.missingEnvVars).toEqual([]);
  });

  it('makes the first connection the default when a project has none', async () => {
    const root = await scaffoldProject();
    await writeFile(
      path.join(root, 'mora.yaml'),
      'version: 1\nproject:\n  name: analytics\n  models: metrics\n',
      'utf8',
    );
    await mkdir(path.join(root, 'exports'), { recursive: true });

    const report = await runConnectionAdd(root, 'exports', {
      type: 'duckdb',
      workingDirectory: 'exports',
      json: true,
    });

    expect(report.isDefault).toBe(true);
  });

  it('refuses a type it has no driver for', async () => {
    const root = await scaffoldProject();

    await expect(
      runConnectionAdd(root, 'lake', { type: 'snowflake', json: true }),
    ).rejects.toMatchObject({ code: 'unknown-database' });
  });

  it('needs a type when it cannot ask for one', async () => {
    const root = await scaffoldProject();

    await expect(runConnectionAdd(root, 'lake', { json: true })).rejects.toMatchObject({
      code: 'missing-type',
    });
  });
});

describe('mora connection test', () => {
  it('reports every connection it can open', async () => {
    const root = await twoConnectionProject();

    const report = await runConnectionTest(root, undefined, { json: true });

    expect(report.ok).toBe(true);
    expect(report.results.map((result) => result.name)).toEqual(['duckdb', 'exports']);
  });

  it('reports a broken connection rather than throwing', async () => {
    const root = await scaffoldProject();
    await addConnection(await loadConfig(root), {
      name: 'broken',
      type: 'duckdb',
      settings: { database: 'no/such/directory/warehouse.duckdb' },
      makeDefault: false,
    });

    const report = await runConnectionTest(root, 'broken', { json: true });

    expect(report.ok).toBe(false);
    expect(report.results[0]?.error).toBeTruthy();
  });

  it('refuses a name the project does not declare', async () => {
    const root = await scaffoldProject();

    await expect(runConnectionTest(root, 'nope', { json: true })).rejects.toMatchObject({
      code: 'unknown-connection',
    });
  });
});

describe('mora connection list', () => {
  it('marks the default and names the credentials that are unset', async () => {
    const root = await scaffoldProject();
    await addConnection(await loadConfig(root), {
      name: 'warehouse',
      type: 'bigquery',
      settings: { project_id: UNSET_REF },
      makeDefault: false,
    });

    const report = await runConnectionList(root, { json: true });

    expect(report.connections).toEqual([
      {
        name: 'duckdb',
        type: 'duckdb',
        supported: true,
        isDefault: true,
        missingEnvVars: [],
      },
      {
        name: 'warehouse',
        type: 'bigquery',
        supported: true,
        isDefault: false,
        missingEnvVars: ['MORA_TEST_UNSET_CREDENTIAL'],
      },
    ]);
  });
});

/**
 * Only runs where BigQuery credentials exist, which is nowhere by default. It is
 * committed so a machine that has them can prove the driver is wired up, rather
 * than that being something only a person can check by hand.
 */
const bigqueryProject = process.env.GOOGLE_CLOUD_PROJECT;
describe.skipIf(!bigqueryProject)('against a real BigQuery project', () => {
  it('opens the connection the driver was given', async () => {
    const root = await scaffoldProject();

    const report = await runConnectionAdd(root, 'warehouse', {
      type: 'bigquery',
      projectId: bigqueryProject,
      json: true,
    });

    expect(report.test?.error).toBeUndefined();
    expect(report.test?.ok).toBe(true);
  });
});
