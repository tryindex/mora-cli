import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as prompts from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import { DATABASE_IDS, DATABASES, type DatabaseId, isDatabaseId } from '../databases.js';
import { ExitCode, MoraError } from '../errors.js';
import { type CompileResult, compileModel } from '../malloy/compile.js';
import {
  assertConfigParses,
  buildScaffold,
  CONFIG_FILENAME,
  findConflicts,
  normalizeRelative,
  resolvePaths,
  type ScaffoldSpec,
  type WrittenFile,
  writeScaffold,
} from '../scaffold.js';

const DEFAULT_MODELS_DIR = 'semantic';
const FALLBACK_PROJECT_NAME = 'analytics';
const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

interface InitFlags {
  name?: string;
  db?: string;
  models?: string;
  example: boolean;
  yes?: boolean;
  force?: boolean;
  json?: boolean;
  compile: boolean;
}

export interface InitReport {
  ok: boolean;
  command: 'init';
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

async function runInit(directory: string, flags: InitFlags): Promise<InitReport> {
  const interactive = isInteractive(flags);
  const root = path.resolve(process.cwd(), directory);

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

  const report: InitReport = {
    ok: compile.status !== 'failed',
    command: 'init',
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

  const result = await compileModel({
    modelPath: path.join(root, paths.exampleModelPath),
    workingDirectory: path.join(root, paths.dataDir),
    connectionName: 'duckdb',
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

  const modelsDir =
    flags.models ??
    (await ask(
      prompts.text({
        message: 'Directory for Malloy models',
        placeholder: DEFAULT_MODELS_DIR,
        defaultValue: DEFAULT_MODELS_DIR,
        validate: (value) => {
          if (!value) return undefined;
          try {
            validateModelsDir(value);
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : 'Invalid directory.';
          }
        },
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
    modelsDir: validateModelsDir(modelsDir),
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
  const alias = normalized === 'postgresql' ? 'postgres' : normalized;
  if (!isDatabaseId(alias)) {
    throw new MoraError(`Unknown database "${value}".`, {
      code: 'unknown-database',
      exitCode: ExitCode.usage,
      hint: `Supported values: ${DATABASE_IDS.join(', ')}.`,
    });
  }
  return alias;
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

function reportInteractive(report: InitReport, directory: string): void {
  const lines = report.files.map((file) => `${actionLabel(file.action)} ${file.path}`);
  prompts.note(lines.join('\n'), 'Files');

  if (report.compile.status === 'passed') {
    const sources = report.compile.sources ?? [];
    const queries = report.compile.queries ?? [];
    prompts.log.success(
      `Semantic layer is valid: ${count(sources.length, 'source')}, ${count(queries.length, 'named query')}.`,
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

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
