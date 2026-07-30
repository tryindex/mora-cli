import { existsSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as prompts from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import { isDuckDbConnection, loadConfig, type MoraConfig } from '../config.js';
import { DATABASE_IDS, DATABASES, type DatabaseId, isDatabaseId } from '../databases.js';
import {
  describeEnvironment,
  ENV_EXAMPLE_FILENAME,
  ENV_FILENAME,
  type EnvironmentReport,
  readEnvFile,
} from '../env.js';
import { ExitCode, MoraError } from '../errors.js';
import { type CompileResult, compileModel } from '../malloy/compile.js';
import {
  AGENT_DOCS_DIR,
  assertConfigParses,
  buildAgentDocs,
  buildScaffold,
  CONFIG_FILENAME,
  DUCKDB_CONNECTION_NAME,
  findConflicts,
  normalizeRelative,
  resolvePaths,
  type ScaffoldSpec,
  type WrittenFile,
  writeScaffold,
} from '../scaffold.js';
import { renderEnvFile } from '../templates/env.js';
import { count, type ProjectValidation, printModelResults, validateProject } from './validate.js';

const DEFAULT_MODELS_DIR = 'metrics';
const FALLBACK_PROJECT_NAME = 'analytics';
const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

export interface InitFlags {
  name?: string;
  db?: string;
  models?: string;
  example: boolean;
  yes?: boolean;
  force?: boolean;
  json?: boolean;
  compile: boolean;
}

export interface ScaffoldReport {
  ok: boolean;
  command: 'init';
  mode: 'scaffold';
  root: string;
  project: {
    name: string;
    database: DatabaseId;
    models: string;
    example: boolean;
  };
  files: WrittenFile[];
  compile: CompileResult;
  nextSteps: string[];
}

/** Reported when init is run in a directory that already has a semantic layer. */
export interface JoinReport extends ProjectValidation {
  ok: boolean;
  command: 'init';
  mode: 'join';
  root: string;
  project: {
    name: string;
    models: string;
  };
  files: WrittenFile[];
  environment: EnvironmentReport;
  nextSteps: string[];
}

export type InitReport = ScaffoldReport | JoinReport;

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Scaffold a Malloy semantic layer in a project')
    .argument('[directory]', 'directory to initialize', '.')
    .option('-n, --name <name>', 'project name')
    .option('-d, --db <database>', `data source (${DATABASE_IDS.join(', ')})`)
    .option('-m, --models <dir>', `directory for Malloy models (default: ${DEFAULT_MODELS_DIR})`)
    .option('--no-example', 'skip the example model and its sample data')
    .option('-y, --yes', 'accept defaults without prompting')
    .option('-f, --force', 'overwrite existing files')
    .option('--no-compile', 'skip the Malloy compile check')
    .option('--json', 'print a machine-readable result instead of prose')
    .addHelpText(
      'after',
      `
Two modes:
  In a directory without ${CONFIG_FILENAME}, init scaffolds a new semantic layer. In a
  directory that already has one, it joins that project instead: it creates a local
  ${ENV_FILENAME} from ${ENV_EXAMPLE_FILENAME}, reports which credentials are still missing, refreshes
  Mora's own docs in ${AGENT_DOCS_DIR}/, and compiles the committed models. Nothing the team
  owns is changed. That is what a teammate runs after cloning. Pass --force to
  scaffold over an existing project.

Agent usage:
  Pass --yes (or --json) to run without prompts. Exit codes: ${ExitCode.ok} success,
  ${ExitCode.failure} failure, ${ExitCode.usage} bad usage, ${ExitCode.conflict} refused because files already exist.

Examples:
  $ mora init
  $ mora init ./analytics --db duckdb --yes
  $ mora init --name retail --models models --json`,
    )
    .action(async (directory: string, flags: InitFlags) => {
      const report = await runInit(directory, flags);
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
      if (!report.ok) {
        process.exitCode = ExitCode.failure;
      }
    });
}

export async function runInit(directory: string, flags: InitFlags): Promise<InitReport> {
  const root = path.resolve(process.cwd(), directory);

  // A configured directory means someone already built this semantic layer and
  // committed it. Scaffolding over their work is almost never what was meant.
  if (!flags.force && existsSync(path.join(root, CONFIG_FILENAME))) {
    return runJoin(root, flags);
  }

  return runScaffold(root, directory, flags);
}

async function runScaffold(
  root: string,
  directory: string,
  flags: InitFlags,
): Promise<ScaffoldReport> {
  const interactive = isInteractive(flags);

  if (interactive) {
    prompts.intro(pc.bgCyan(pc.black(' mora init ')));
  }

  const spec = interactive ? await promptForSpec(root, flags) : specFromFlags(root, flags);

  const files = buildScaffold(spec);
  const conflicts = findConflicts(root, files);
  if (conflicts.length > 0 && !flags.force) {
    throw new MoraError(`Refusing to overwrite existing files: ${conflicts.join(', ')}`, {
      code: 'files-exist',
      exitCode: ExitCode.conflict,
      hint: 'Re-run with --force to overwrite, or pick an empty directory.',
    });
  }

  await mkdir(root, { recursive: true });
  const written = await writeScaffold(root, files);
  await assertConfigParses(root);

  const paths = resolvePaths(spec);
  const compile = await runCompileCheck({ spec, root, interactive, flags });

  const report: ScaffoldReport = {
    ok: compile.status !== 'failed',
    command: 'init',
    mode: 'scaffold',
    root,
    project: {
      name: spec.projectName,
      database: spec.database,
      models: paths.modelsDir,
      example: spec.includeExample,
    },
    files: written,
    compile,
    nextSteps: nextSteps(spec, paths.exampleModelPath),
  };

  if (interactive) {
    reportInteractive(report, directory);
  }

  return report;
}

/**
 * Sets up a checkout of a project someone else built and committed. Nothing the
 * team owns is written: this creates the gitignored .env and refreshes the docs
 * under `.agents/` that Mora writes itself.
 */
async function runJoin(root: string, flags: InitFlags): Promise<JoinReport> {
  const prose = !flags.json;
  const config = await loadConfig(root);

  if (prose) {
    prompts.intro(pc.bgCyan(pc.black(' mora init ')));
    prompts.log.info(
      `Found an existing semantic layer in ${pc.cyan(CONFIG_FILENAME)}, so this is a setup run.\n` +
        `Your models and configuration are left exactly as they are; only ${ENV_FILENAME} and\n` +
        `Mora's own docs in ${AGENT_DOCS_DIR}/ are written.`,
    );
  }

  const files: WrittenFile[] = [];
  const envFile = await ensureEnvFile(config);
  if (envFile) files.push(envFile);
  files.push(...(await refreshAgentDocs(config)));

  const environment = describeEnvironment(
    config.requiredEnvVars,
    await readEnvFile(path.join(config.root, ENV_FILENAME)),
  );

  const validation = await validateProject(config, {
    prose,
    // A connection Mora cannot open for want of a credential would fail every
    // model with the same message the environment report just gave.
    skipReason:
      environment.missing.length > 0
        ? `${environment.missing.join(', ')} not set, so the connections cannot be opened`
        : undefined,
  });

  const report: JoinReport = {
    ok: validation.summary.failed === 0 && environment.missing.length === 0,
    command: 'init',
    mode: 'join',
    root: config.root,
    project: { name: config.projectName, models: config.modelsDir },
    files,
    environment,
    ...validation,
    nextSteps: joinNextSteps(config, environment, validation),
  };

  if (prose) {
    reportJoin(report);
  }

  return report;
}

/**
 * Gives the checkout a `.env` to fill in. An existing one is never touched, since
 * it holds credentials Mora did not put there.
 */
async function ensureEnvFile(config: MoraConfig): Promise<WrittenFile | undefined> {
  if (config.requiredEnvVars.length === 0) return undefined;

  const target = path.join(config.root, ENV_FILENAME);
  if (existsSync(target)) {
    return { path: ENV_FILENAME, action: 'unchanged' };
  }

  const example = path.join(config.root, ENV_EXAMPLE_FILENAME);
  if (existsSync(example)) {
    await copyFile(example, target);
  } else {
    // Projects scaffolded before .env.example existed still deserve a starting
    // point, and the config tells us exactly which variables belong in it.
    await writeFile(
      target,
      renderEnvFile({ projectName: config.projectName, variables: config.requiredEnvVars }),
      'utf8',
    );
  }

  return { path: ENV_FILENAME, action: 'created' };
}

/**
 * Brings Mora's own guidance up to date. Without this, a project scaffolded once
 * would keep whichever version of the docs shipped that day forever, no matter
 * how many times the team upgraded the CLI.
 */
async function refreshAgentDocs(config: MoraConfig): Promise<WrittenFile[]> {
  const written = await writeScaffold(
    config.root,
    buildAgentDocs({
      modelsDir: config.modelsDir,
      // The guide's example reads a local CSV, so it belongs on DuckDB whatever
      // else the project connects to. This is the name the scaffold used too.
      connectionName: config.connections.find(isDuckDbConnection)?.name ?? DUCKDB_CONNECTION_NAME,
    }),
  );
  // Only what changed is worth a line in the report.
  return written.filter((file) => file.action !== 'unchanged');
}

function joinNextSteps(
  config: MoraConfig,
  environment: EnvironmentReport,
  validation: ProjectValidation,
): string[] {
  const steps: string[] = [];

  if (environment.missing.length > 0) {
    steps.push(
      `Set ${environment.missing.join(', ')} in ${ENV_FILENAME}, then run \`mora validate\`.`,
    );
  }
  if (validation.summary.failed > 0) {
    steps.push(
      'Look at the compile errors above. In a fresh checkout the usual cause is data ' +
        'that is not available locally rather than a broken model.',
    );
  }
  if (validation.models.length === 0) {
    steps.push(`Add sources over your own tables in ${config.modelsDir}/.`);
  } else {
    steps.push(
      `Read AGENTS.md, then run \`mora describe\` to see the vocabulary this team already agreed on.`,
    );
  }
  steps.push('Run `mora validate` after every model edit, and before opening a pull request.');

  return steps;
}

function reportJoin(report: JoinReport): void {
  if (report.files.length > 0) {
    prompts.note(
      report.files.map((file) => `${actionLabel(file.action)} ${file.path}`).join('\n'),
      'Files',
    );
  }

  if (report.environment.required.length > 0) {
    prompts.note(environmentLines(report.environment).join('\n'), 'Credentials');
  }

  printModelResults(report.models, report.project.models);
  prompts.note(report.nextSteps.map((step, i) => `${i + 1}. ${step}`).join('\n'), 'Next');

  if (report.ok) {
    prompts.outro(`Ready to work on the ${pc.cyan(report.project.name)} semantic layer.`);
    return;
  }

  const reasons: string[] = [];
  if (report.environment.missing.length > 0) {
    reasons.push(`${count(report.environment.missing.length, 'credential')} still to set`);
  }
  if (report.summary.failed > 0) {
    reasons.push(`${count(report.summary.failed, 'model')} failing to compile`);
  }
  prompts.outro(pc.yellow(`Set up with ${reasons.join(' and ')}.`));
}

function environmentLines(environment: EnvironmentReport): string[] {
  return environment.required.map((variable) => {
    if (!variable.set) {
      return `${pc.yellow('  unset')} ${variable.name}`;
    }
    const source = variable.source === 'environment' ? 'environment' : environment.envFile;
    return `${pc.green('    set')} ${variable.name} ${pc.dim(`(${source})`)}`;
  });
}

async function runCompileCheck(context: {
  spec: ScaffoldSpec;
  root: string;
  interactive: boolean;
  flags: InitFlags;
}): Promise<CompileResult> {
  const { spec, root, interactive, flags } = context;
  const paths = resolvePaths(spec);

  if (!flags.compile) {
    return { status: 'skipped', reason: 'disabled with --no-compile' };
  }
  if (!spec.includeExample) {
    return { status: 'skipped', reason: 'no example model to compile' };
  }

  const spinner = interactive ? prompts.spinner() : undefined;
  spinner?.start('Compiling the example model');

  // The example always reads local CSV through the scaffolded DuckDB
  // connection, whatever else the project is configured to talk to.
  const result = await compileModel({
    modelPath: path.join(root, paths.exampleModelPath),
    connections: [
      {
        name: DUCKDB_CONNECTION_NAME,
        type: 'duckdb',
        supported: true,
        requiredEnvVars: [],
        database: ':memory:',
        workingDirectory: path.join(root, paths.modelsDir),
      },
    ],
    defaultConnectionName: DUCKDB_CONNECTION_NAME,
  });

  if (spinner) {
    if (result.status === 'failed') {
      spinner.error('Example model failed to compile');
    } else {
      spinner.stop(result.status === 'passed' ? 'Example model compiles' : 'Compile check skipped');
    }
  }

  return result;
}

function isInteractive(flags: InitFlags): boolean {
  if (flags.json || flags.yes) return false;
  // Agents and CI runners get a terminal often enough that isTTY alone is not a
  // reliable signal; prompting there would hang.
  if (process.env.CI) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function specFromFlags(root: string, flags: InitFlags): ScaffoldSpec {
  return {
    root,
    projectName: validateProjectName(flags.name ?? defaultProjectName(root)),
    database: parseDatabase(flags.db) ?? 'duckdb',
    modelsDir: validateModelsDir(flags.models ?? DEFAULT_MODELS_DIR),
    includeExample: flags.example,
  };
}

async function promptForSpec(root: string, flags: InitFlags): Promise<ScaffoldSpec> {
  const projectName =
    flags.name ??
    (await ask(
      prompts.text({
        message: 'Project name',
        placeholder: defaultProjectName(root),
        defaultValue: defaultProjectName(root),
        validate: (value) =>
          !value || PROJECT_NAME_PATTERN.test(value)
            ? undefined
            : 'Use letters, numbers, spaces, dots, dashes or underscores.',
      }),
    ));

  const database =
    parseDatabase(flags.db) ??
    (await ask(
      prompts.select<DatabaseId>({
        message: 'Where does your data live?',
        initialValue: 'duckdb',
        options: DATABASE_IDS.map((id) => ({
          value: id,
          label: DATABASES[id].label,
          hint: DATABASES[id].hint,
        })),
      }),
    ));

  const includeExample = flags.example
    ? await ask(
        prompts.confirm({
          message: 'Include an example model with sample data?',
          initialValue: true,
        }),
      )
    : false;

  if (DATABASES[database].needsCredentials) {
    prompts.log.info(
      `${DATABASES[database].label} needs credentials. Mora writes a ${CONFIG_FILENAME} block for\n` +
        'it with placeholder values; fill those in before running queries. The example\n' +
        'model stays on DuckDB so you have something that works right away.',
    );
  }

  return {
    root,
    projectName: validateProjectName(projectName),
    database,
    // Not asked for: every Mora project keeping its models in the same place is
    // worth more than the choice. `--models` is there for a repo that needs a
    // different one.
    modelsDir: validateModelsDir(flags.models ?? DEFAULT_MODELS_DIR),
    includeExample,
  };
}

async function ask<T>(prompt: Promise<T | symbol>): Promise<T> {
  const value = await prompt;
  if (prompts.isCancel(value)) {
    prompts.cancel('Cancelled. Nothing was written.');
    process.exit(ExitCode.ok);
  }
  return value as T;
}

function parseDatabase(value: string | undefined): DatabaseId | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!isDatabaseId(normalized)) {
    throw new MoraError(`Unknown database "${value}".`, {
      code: 'unknown-database',
      exitCode: ExitCode.usage,
      hint: `Supported values: ${DATABASE_IDS.join(', ')}.`,
    });
  }
  return normalized;
}

function validateProjectName(name: string): string {
  const trimmed = name.trim();
  if (!PROJECT_NAME_PATTERN.test(trimmed)) {
    throw new MoraError(`Invalid project name "${name}".`, {
      code: 'invalid-project-name',
      exitCode: ExitCode.usage,
      hint: 'Use letters, numbers, spaces, dots, dashes or underscores.',
    });
  }
  return trimmed;
}

function validateModelsDir(dir: string): string {
  const normalized = normalizeRelative(dir.trim());
  if (normalized.length === 0) {
    throw new MoraError('The models directory cannot be empty.', {
      code: 'invalid-models-dir',
      exitCode: ExitCode.usage,
    });
  }
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new MoraError(`The models directory must stay inside the project: "${dir}".`, {
      code: 'invalid-models-dir',
      exitCode: ExitCode.usage,
    });
  }
  return normalized;
}

function defaultProjectName(root: string): string {
  const base = path.basename(root);
  return PROJECT_NAME_PATTERN.test(base) ? base : FALLBACK_PROJECT_NAME;
}

function nextSteps(spec: ScaffoldSpec, exampleModelPath: string): string[] {
  const steps: string[] = [];
  if (spec.includeExample) {
    steps.push(`Read ${exampleModelPath} to see how sources, measures and views fit together.`);
    steps.push('Run `mora describe` to list the vocabulary, then `mora query monthly_revenue`.');
  }
  if (DATABASES[spec.database].needsCredentials) {
    steps.push(
      `Fill in the ${spec.database} connection in ${CONFIG_FILENAME} and set the referenced environment variables.`,
    );
  }
  steps.push(
    spec.includeExample
      ? `Replace the example with sources over your own tables in ${spec.modelsDir}/.`
      : `Add sources over your own tables in ${spec.modelsDir}/.`,
  );
  steps.push('Point your agent at AGENTS.md so it queries through the semantic layer.');
  return steps;
}

function reportInteractive(report: ScaffoldReport, directory: string): void {
  const lines = report.files.map((file) => `${actionLabel(file.action)} ${file.path}`);
  prompts.note(lines.join('\n'), 'Files');

  if (report.compile.status === 'passed') {
    const sources = report.compile.sources ?? [];
    const queries = report.compile.queries ?? [];
    prompts.log.success(
      `Semantic layer is valid: ${count(sources.length, 'source')}, ${count(queries.length, 'named query', 'named queries')}.`,
    );
    if (queries.length > 0) {
      prompts.log.message(pc.dim(`Queries: ${queries.join(', ')}`));
    }
  } else if (report.compile.status === 'failed') {
    prompts.log.error(
      `The example model did not compile:\n${report.compile.error ?? 'unknown error'}`,
    );
  } else if (report.compile.reason) {
    prompts.log.warn(`Compile check skipped: ${report.compile.reason}`);
  }

  prompts.note(report.nextSteps.map((step, i) => `${i + 1}. ${step}`).join('\n'), 'Next');

  const location = directory === '.' ? 'this directory' : directory;
  prompts.outro(
    report.ok
      ? `Semantic layer ready in ${pc.cyan(location)}.`
      : pc.yellow(`Scaffold written to ${location}, but the compile check failed.`),
  );
}

function actionLabel(action: WrittenFile['action']): string {
  switch (action) {
    case 'created':
      return pc.green('create');
    case 'overwritten':
      return pc.yellow('replace');
    case 'updated':
      return pc.yellow('update');
    case 'unchanged':
      return pc.dim('  skip');
  }
}
