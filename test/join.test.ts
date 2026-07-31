import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { type InitFlags, type JoinReport, runInit } from '../src/commands/init.js';
import { collectEnvVars, ENV_EXAMPLE_FILENAME, ENV_FILENAME, readEnvFile } from '../src/env.js';
import { MANAGED_BEGIN, MANAGED_END } from '../src/scaffold.js';
import { writeOrdersModel } from './helpers/fixtures.js';

const PROJECT_VAR = 'GOOGLE_CLOUD_PROJECT';

function flags(overrides: Partial<InitFlags> = {}): InitFlags {
  // --no-test: these fixtures are about join behaviour, not reachability, and a
  // failed connection would take the scaffold with it.
  return { json: true, yes: true, test: false, ...overrides };
}

async function tempDir(prefix = 'mora-join-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/**
 * A project as a head of data would leave it: scaffolded, modelled and
 * committed. `init` writes no model itself, so the fixture supplies one — but
 * only for DuckDB, since it reads a CSV no warehouse has.
 */
async function committedProject(database = 'duckdb'): Promise<string> {
  const root = await tempDir();
  await runInit(root, flags({ db: database, name: 'retail' }));
  if (database === 'duckdb') await writeOrdersModel(root);
  // .env is gitignored; a clone does not have one until join creates it.
  await rm(path.join(root, ENV_FILENAME), { force: true });
  return root;
}

async function join(root: string, overrides: Partial<InitFlags> = {}): Promise<JoinReport> {
  const report = await runInit(root, flags(overrides));
  if (report.mode !== 'join') throw new Error(`expected a join report, got ${report.mode}`);
  return report;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('init in a project that already exists', () => {
  it('joins the project instead of scaffolding over it', async () => {
    const root = await committedProject();
    const before = await readFile(path.join(root, 'metrics/orders.malloy'), 'utf8');
    const config = await readFile(path.join(root, 'mora.yaml'), 'utf8');

    const report = await join(root);

    expect(report.mode).toBe('join');
    expect(report.ok).toBe(true);
    expect(report.project).toEqual({ name: 'retail', models: 'metrics' });
    expect(report.summary.passed).toBe(1);
    // Nothing the team committed may change.
    await expect(readFile(path.join(root, 'metrics/orders.malloy'), 'utf8')).resolves.toBe(before);
    await expect(readFile(path.join(root, 'mora.yaml'), 'utf8')).resolves.toBe(config);
  });

  it('needs no credentials for a DuckDB project', async () => {
    const report = await join(await committedProject());

    expect(report.environment.required).toEqual([]);
    expect(report.environment.missing).toEqual([]);
    expect(report.files).toEqual([]);
  });

  it('creates .env from the committed example and reports what is unset', async () => {
    vi.stubEnv(PROJECT_VAR, undefined);
    const root = await committedProject('bigquery');

    const report = await join(root);

    expect(report.files).toEqual([{ path: ENV_FILENAME, action: 'created' }]);
    expect(report.environment.missing).toEqual([PROJECT_VAR]);
    expect(report.ok).toBe(false);

    const written = await readFile(path.join(root, ENV_FILENAME), 'utf8');
    const example = await readFile(path.join(root, ENV_EXAMPLE_FILENAME), 'utf8');
    expect(written).toBe(example);
  });

  it('is ready once the credentials are filled in, and never rewrites .env', async () => {
    vi.stubEnv(PROJECT_VAR, undefined);
    const root = await committedProject('bigquery');
    const contents = `${PROJECT_VAR}="acme-analytics"\n`;
    await writeFile(path.join(root, ENV_FILENAME), contents, 'utf8');

    const report = await join(root);

    expect(report.ok).toBe(true);
    expect(report.environment.missing).toEqual([]);
    expect(report.environment.required.every((v) => v.source === 'env-file')).toBe(true);
    expect(report.files).toEqual([{ path: ENV_FILENAME, action: 'unchanged' }]);
    await expect(readFile(path.join(root, ENV_FILENAME), 'utf8')).resolves.toBe(contents);
  });

  it('prefers a real environment variable over the env file', async () => {
    vi.stubEnv(PROJECT_VAR, 'from-shell');
    const root = await committedProject('bigquery');

    const report = await join(root);

    expect(report.environment.required.map((v) => v.source)).toEqual(['environment']);
  });

  it('generates .env when the project predates .env.example', async () => {
    vi.stubEnv(PROJECT_VAR, undefined);
    const root = await committedProject('bigquery');
    await rm(path.join(root, ENV_EXAMPLE_FILENAME));

    const report = await join(root);

    expect(report.files).toEqual([{ path: ENV_FILENAME, action: 'created' }]);
    await expect(readFile(path.join(root, ENV_FILENAME), 'utf8')).resolves.toContain(
      `${PROJECT_VAR}=`,
    );
  });

  it('explains a compile failure caused by data that is not in the checkout', async () => {
    const root = await committedProject();
    await rm(path.join(root, 'metrics/data/orders.csv'));

    const report = await join(root);

    expect(report.ok).toBe(false);
    expect(report.models[0]?.error).toContain('the data is missing');
  });

  it('scaffolds again when forced', async () => {
    const root = await committedProject();

    const report = await runInit(root, flags({ force: true }));

    expect(report.mode).toBe('scaffold');
  });
});

describe('committed artifacts', () => {
  it('writes an .env.example listing the connection credentials', async () => {
    const root = await committedProject('bigquery');

    const example = await readFile(path.join(root, ENV_EXAMPLE_FILENAME), 'utf8');
    expect(example).toContain(`${PROJECT_VAR}=`);
    // Optional settings stay commented out in mora.yaml, so they are not required here.
    expect(example).not.toContain('GOOGLE_APPLICATION_CREDENTIALS=');
  });

  it('keeps .env.example out of the gitignore that hides .env', async () => {
    const root = await committedProject('bigquery');

    const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8');
    const lines = gitignore.split('\n');
    expect(lines).toContain('.env');
    expect(lines).toContain('.env.*');
    expect(lines).toContain(`!${ENV_EXAMPLE_FILENAME}`);
  });

  it('omits .env.example for a project that needs no credentials', async () => {
    const root = await committedProject();

    const report = await join(root);
    expect(report.environment.required).toEqual([]);
    expect(existsSync(path.join(root, ENV_EXAMPLE_FILENAME))).toBe(false);
  });

  it('writes nothing at all in a checkout that needs no credentials', async () => {
    const root = await committedProject();
    const doc = path.join(root, '.agents', 'malloy.md');
    await writeFile(doc, 'guidance someone edited by hand\n', 'utf8');
    const agents = await readFile(path.join(root, 'AGENTS.md'), 'utf8');

    const report = await join(root);

    expect(report.files).toEqual([]);
    await expect(readFile(doc, 'utf8')).resolves.toBe('guidance someone edited by hand\n');
    await expect(readFile(path.join(root, 'AGENTS.md'), 'utf8')).resolves.toBe(agents);
  });

  it('refreshes its own block in AGENTS.md under --force and leaves team conventions alone', async () => {
    const root = await committedProject();
    const agentsPath = path.join(root, 'AGENTS.md');
    const rule = 'Ask before renaming a measure.';
    await writeFile(agentsPath, `${await readFile(agentsPath, 'utf8')}\n${rule}\n`, 'utf8');

    await runInit(root, flags({ force: true, models: 'vocabulary' }));

    const updated = await readFile(agentsPath, 'utf8');
    expect(updated).toContain(rule);
    expect(updated).toContain('## Team conventions');
    expect(updated.indexOf(MANAGED_BEGIN)).toBeLessThan(updated.indexOf(MANAGED_END));
    // The managed block was rewritten for the new models directory.
    expect(updated).toContain('vocabulary/');
    // And exactly one block, rather than one appended per run.
    expect(updated.split(MANAGED_BEGIN)).toHaveLength(2);
    // The team's rule stays where they wrote it: after the block, not inside it.
    expect(updated.indexOf(rule)).toBeGreaterThan(updated.indexOf(MANAGED_END));
  });

  it('restores the heading when the block is all a file has', async () => {
    const root = await committedProject();
    const agentsPath = path.join(root, 'AGENTS.md');
    await writeFile(
      agentsPath,
      `${MANAGED_BEGIN}\nan older, unheaded body\n${MANAGED_END}\n`,
      'utf8',
    );

    await runInit(root, flags({ force: true, name: 'retail' }));

    const updated = await readFile(agentsPath, 'utf8');
    expect(updated.startsWith('# Working with the retail semantic layer')).toBe(true);
    expect(updated).not.toContain('an older, unheaded body');
    expect(updated.split(MANAGED_BEGIN)).toHaveLength(2);
  });
});

describe('init is connection setup', () => {
  it('opens the connection it just declared, and keeps the scaffold', async () => {
    const root = await tempDir('mora-init-duckdb-');

    const report = await runInit(root, { json: true, yes: true, name: 'retail', test: true });

    expect(report.mode).toBe('scaffold');
    if (report.mode !== 'scaffold') return;
    expect(report.connection).toMatchObject({ name: 'duckdb', ok: true });
    expect(report.rolledBack).toBe(false);
    expect(report.ok).toBe(true);
    // The semantic layer starts empty: what goes in it is the reader's tables.
    expect(existsSync(path.join(root, 'metrics/.gitkeep'))).toBe(true);
    expect(report.files.some((file) => file.path.endsWith('.malloy'))).toBe(false);
  });

  it('names the connection after the database, or after --connection', async () => {
    const byDefault = await tempDir('mora-init-name-');
    const named = await tempDir('mora-init-named-');

    const first = await runInit(byDefault, flags({ name: 'retail' }));
    const second = await runInit(named, flags({ name: 'retail', connection: 'lake' }));

    expect(first.mode === 'scaffold' && first.project.connection).toBe('duckdb');
    expect(second.mode === 'scaffold' && second.project.connection).toBe('lake');
    await expect(readFile(path.join(named, 'mora.yaml'), 'utf8')).resolves.toContain(
      'default_connection: lake',
    );
  });

  it('refuses a connection name a model could not refer to', async () => {
    const root = await tempDir('mora-init-badname-');

    await expect(runInit(root, flags({ connection: 'my warehouse' }))).rejects.toMatchObject({
      code: 'invalid-connection-name',
    });
  });

  it('takes the whole scaffold back when the credential it needs is unset', async () => {
    vi.stubEnv(PROJECT_VAR, undefined);
    const root = await tempDir('mora-init-rollback-');

    const report = await runInit(root, { json: true, yes: true, db: 'bigquery', test: true });

    expect(report.mode).toBe('scaffold');
    if (report.mode !== 'scaffold') return;
    expect(report.ok).toBe(false);
    expect(report.rolledBack).toBe(true);
    // Nothing half-written to clean up, including the .env the credential would
    // have gone into.
    expect(report.files).toEqual([]);
    expect(existsSync(path.join(root, 'mora.yaml'))).toBe(false);
    expect(existsSync(path.join(root, ENV_FILENAME))).toBe(false);
    expect(existsSync(path.join(root, 'metrics'))).toBe(false);
    expect(report.nextSteps[0]).toContain(PROJECT_VAR);
  });

  it('gives back a file --force would have overwritten', async () => {
    vi.stubEnv(PROJECT_VAR, undefined);
    const root = await committedProject();
    const agentsPath = path.join(root, 'AGENTS.md');
    const before = await readFile(agentsPath, 'utf8');

    const report = await runInit(root, {
      json: true,
      yes: true,
      force: true,
      db: 'bigquery',
      test: true,
    });

    expect(report.mode === 'scaffold' && report.rolledBack).toBe(true);
    await expect(readFile(agentsPath, 'utf8')).resolves.toBe(before);
    await expect(readFile(path.join(root, 'mora.yaml'), 'utf8')).resolves.toContain(
      'default_connection: duckdb',
    );
  });

  it('keeps the scaffold under --no-test, for a credential that comes later', async () => {
    vi.stubEnv(PROJECT_VAR, undefined);
    const root = await tempDir('mora-init-notest-');

    const report = await runInit(root, flags({ db: 'bigquery' }));

    expect(report.mode).toBe('scaffold');
    if (report.mode !== 'scaffold') return;
    expect(report.rolledBack).toBe(false);
    expect(report.connection).toBeNull();
    // Not ok: the credential is still unset, and the report says so rather than
    // pretending the project is ready.
    expect(report.ok).toBe(false);
    expect(existsSync(path.join(root, 'mora.yaml'))).toBe(true);
  });
});

describe('init scaffolds a warehouse', () => {
  it('writes flag settings into mora.yaml and reports unset credentials', async () => {
    vi.stubEnv(PROJECT_VAR, undefined);
    const root = await tempDir('mora-init-bq-');

    const report = await runInit(
      root,
      flags({
        db: 'bigquery',
        name: 'retail',
        connection: 'warehouse',
        projectId: 'acme-prod',
        location: 'EU',
      }),
    );

    expect(report.mode).toBe('scaffold');
    if (report.mode !== 'scaffold') return;

    const config = parseYaml(await readFile(path.join(root, 'mora.yaml'), 'utf8')) as {
      project: { default_connection: string };
      connections: { warehouse: Record<string, string> };
    };
    expect(config.project.default_connection).toBe('warehouse');
    expect(config.connections.warehouse).toMatchObject({
      type: 'bigquery',
      project_id: 'acme-prod',
      location: 'EU',
    });
    // A literal project id needs no env var; optional credentials stay unset.
    expect(report.missingEnvVars).toEqual([]);
    expect(report.connection).toBeNull();
    expect(report.files.some((file) => file.path === ENV_FILENAME)).toBe(false);
  });

  it('creates .env for env-var settings and leaves missingEnvVars when they are empty', async () => {
    vi.stubEnv(PROJECT_VAR, undefined);
    const root = await tempDir('mora-init-bq-env-');
    const projectRef = `\u0024{${PROJECT_VAR}}`;

    const report = await runInit(
      root,
      flags({
        db: 'bigquery',
        name: 'retail',
        projectId: projectRef,
      }),
    );

    expect(report.mode).toBe('scaffold');
    if (report.mode !== 'scaffold') return;
    expect(report.ok).toBe(false);
    expect(report.missingEnvVars).toEqual([PROJECT_VAR]);
    expect(report.files).toContainEqual({ path: ENV_FILENAME, action: 'created' });
    expect(report.nextSteps.some((step) => step.includes(PROJECT_VAR))).toBe(true);
  });

  it('skips the warehouse test when credentials are already set and --no-test is passed', async () => {
    vi.stubEnv(PROJECT_VAR, 'acme-from-shell');
    const root = await tempDir('mora-init-bq-skip-');

    const report = await runInit(root, flags({ db: 'bigquery', name: 'retail', test: false }));

    expect(report.mode).toBe('scaffold');
    if (report.mode !== 'scaffold') return;
    expect(report.missingEnvVars).toEqual([]);
    expect(report.connection).toBeNull();
    expect(report.ok).toBe(true);
  });
});

const bigqueryProject = process.env.GOOGLE_CLOUD_PROJECT;
describe.skipIf(!bigqueryProject)('init against a real BigQuery project', () => {
  it('leaves the warehouse connection reachable', async () => {
    const root = await tempDir('mora-init-bq-live-');

    const report = await runInit(root, {
      json: true,
      yes: true,
      db: 'bigquery',
      name: 'retail',
      connection: 'warehouse',
      projectId: bigqueryProject,
      test: true,
    });

    expect(report.mode).toBe('scaffold');
    if (report.mode !== 'scaffold') return;
    expect(report.missingEnvVars).toEqual([]);
    expect(report.connection).toMatchObject({ name: 'warehouse', ok: true });
    expect(report.ok).toBe(true);
  });
});

describe('collectEnvVars', () => {
  it('finds every reference once, and nothing else', () => {
    const config = parseYaml(`
connections:
  warehouse:
    user: \${PG_USER}
    password: \${PG_PASSWORD}
    port: 5432
  replica:
    - \${PG_USER}
    - literal value
`);

    expect(collectEnvVars(config)).toEqual(['PG_PASSWORD', 'PG_USER']);
  });

  it('ignores commented-out connections, because the parser drops them', () => {
    const config = parseYaml(`
connections:
  duckdb:
    type: duckdb
  # warehouse:
  #   project_id: \${GOOGLE_CLOUD_PROJECT}
`);

    expect(collectEnvVars(config)).toEqual([]);
  });
});

describe('readEnvFile', () => {
  it('reads assignments, ignoring comments, blanks and quotes', async () => {
    const root = await tempDir('mora-env-');
    const file = path.join(root, ENV_FILENAME);
    await writeFile(
      file,
      ['# a comment', '', 'PLAIN=value', 'QUOTED="quoted value"', "export EXPORTED='shell'"].join(
        '\n',
      ),
      'utf8',
    );

    await expect(readEnvFile(file)).resolves.toEqual({
      PLAIN: 'value',
      QUOTED: 'quoted value',
      EXPORTED: 'shell',
    });
  });

  it('treats a missing file as empty', async () => {
    const root = await tempDir('mora-env-');
    await expect(readEnvFile(path.join(root, ENV_FILENAME))).resolves.toEqual({});
  });
});
