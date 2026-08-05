import { existsSync } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as prompts from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, type MoraConfig } from '../config.js';
import {
  assertConnectionName,
  CONNECTION_NAME_PATTERN,
  suggestConnectionName,
} from '../connections.js';
import {
  connectionSettings,
  DATABASE_IDS,
  DATABASES,
  type DatabaseId,
  defaultConnectionSettings,
  isDatabaseId,
  settingFlags,
} from '../databases.js';
import {
  describeEnvironment,
  ENV_EXAMPLE_FILENAME,
  ENV_FILENAME,
  type EnvironmentReport,
  readEnvFile,
  writeEnvValues,
} from '../env.js';
import { ExitCode, MoraError } from '../errors.js';
import {
  assertConfigParses,
  buildScaffold,
  CONFIG_FILENAME,
  findConflicts,
  normalizeRelative,
  recordFile,
  resolvePaths,
  revertScaffold,
  type ScaffoldSnapshot,
  type ScaffoldSpec,
  type WrittenFile,
  writeScaffold,
} from '../scaffold.js';
import { renderEnvFile } from '../templates/env.js';
import {
  type ConnectionTestResult,
  checkConnection,
  chooseSettings,
  flagValue,
  gcloudAuthStep,
  type SettingFlags,
} from './connection.js';
import { count, type ProjectValidation, printModelResults, validateProject } from './validate.js';

const DEFAULT_MODELS_DIR = 'metrics';
const FALLBACK_PROJECT_NAME = 'analytics';
const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

/** Warehouse databases whose settings init can collect up front. */
const WAREHOUSE_IDS = DATABASE_IDS.filter((id) => id !== 'duckdb');

export interface InitFlags extends SettingFlags {
  name?: string;
  db?: string;
  connection?: string;
  models?: string;
  yes?: boolean;
  force?: boolean;
  json?: boolean;
  /** Connectivity check for the new connection; defaults to true. */
  test?: boolean;
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
    connection: string;
  };
  /** Empty after a rollback: nothing Mora wrote is still on disk. */
  files: WrittenFile[];
  /**
   * Whether the scaffold was taken back off disk because its connection could
   * not be opened. An agent should read this before assuming a project exists.
   */
  rolledBack: boolean;
  /** Variables the connection needs that are not set yet. */
  missingEnvVars: string[];
  /** The connectivity check, or null when `--no-test` skipped it. */
  connection: ConnectionTestResult | null;
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
  const command = program
    .command('init')
    .description('Scaffold a Malloy semantic layer in a project')
    .argument('[directory]', 'directory to initialize', '.')
    .option('-n, --name <name>', 'project name')
    .option('-d, --db <database>', `data source (${DATABASE_IDS.join(', ')})`)
    .option('--connection <name>', 'name models will use for it (default: the database)')
    .option('-m, --models <dir>', `directory for Malloy models (default: ${DEFAULT_MODELS_DIR})`)
    .option('-y, --yes', 'accept defaults without prompting')
    .option('-f, --force', 'overwrite existing files')
    .option('--no-test', 'keep the scaffold without checking the connection')
    .option('--json', 'print a machine-readable result instead of prose');

  // One flag per warehouse setting so init can finish setup unattended. DuckDB's
  // settings are fixed by the scaffold, so only credentialed databases appear.
  for (const { flag, description } of settingFlags(WAREHOUSE_IDS, { modelsDir: '<models>' })) {
    command.option(`--${flag} <value>`, description);
  }

  command
    .addHelpText(
      'after',
      `
Two modes:
  In a directory without ${CONFIG_FILENAME}, init scaffolds a new semantic layer: one
  connection, an empty models directory, and the docs your agent reads. In a
  directory that already has one, it joins that project instead: it creates a local
  ${ENV_FILENAME} from ${ENV_EXAMPLE_FILENAME}, reports which credentials are still
  missing, and compiles the committed models. Nothing the team owns is changed. That
  is what a teammate runs after cloning. Pass --force to scaffold over an existing
  project.

  Setting up interactively prompts for the connection's settings, writes credential
  values into ${ENV_FILENAME}, and opens the connection so you leave ready to query.
  Pass the same settings as flags (e.g. --project-id) to do that unattended.

  A scaffold whose connection does not answer is removed again, leaving the
  directory as it was found: fix the setting or the credential and run init again.
  Pass --no-test to keep the scaffold without checking.

Agent usage:
  Pass --yes (or --json) to run without prompts. Read \`rolledBack\` before assuming
  a project exists. Exit codes: ${ExitCode.ok} success, ${ExitCode.failure} failure,
  ${ExitCode.usage} bad usage, ${ExitCode.conflict} refused because files already exist.

Examples:
  $ mora init
  $ mora init ./analytics --db duckdb --yes
  $ mora init --db postgres --host db.internal --database shop --yes
  $ mora init --db bigquery --project-id '\${GOOGLE_CLOUD_PROJECT}' --yes
  $ mora init --db bigquery --connection warehouse --no-test --json`,
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
  // Prompting and reporting are separate questions. `--yes` only says not to ask
  // anything; a reader who ran it still needs to be told what was written, and
  // every other command prints prose unless `--json` asked for the report instead.
  const prose = !flags.json;

  if (prose) {
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

  const { written, snapshot } = await writeScaffold(root, files);
  await assertConfigParses(root);

  const paths = resolvePaths(spec);

  const envSetup = await setupCredentials({
    root,
    spec,
    interactive,
    projectName: spec.projectName,
    snapshot,
  });
  if (envSetup.file) written.push(envSetup.file);

  const connection = await testNewConnection({
    root,
    spec,
    flags,
    missingEnvVars: envSetup.missingEnvVars,
    prose,
  });

  // A project whose one connection cannot be opened is not a project yet, and
  // leaving the files behind would mean the next command fails on something the
  // reader did not choose to keep. `--no-test` is how someone says they will
  // supply the credential later and wants the files regardless.
  const kept =
    flags.test === false || (envSetup.missingEnvVars.length === 0 && connection?.ok === true);
  if (!kept) {
    await revertScaffold(snapshot);
  }

  const report: ScaffoldReport = {
    ok: kept && envSetup.missingEnvVars.length === 0,
    command: 'init',
    mode: 'scaffold',
    root,
    project: {
      name: spec.projectName,
      database: spec.database,
      models: paths.modelsDir,
      connection: spec.connectionName,
    },
    files: kept ? written : [],
    rolledBack: !kept,
    missingEnvVars: envSetup.missingEnvVars,
    connection,
    nextSteps: nextSteps(spec, envSetup.missingEnvVars, connection, kept),
  };

  if (prose) {
    reportScaffold(report, directory);
  }

  return report;
}

/**
 * Ensures a checkout that needs credentials has a `.env`, and interactively
 * fills in any `${VAR}` the warehouse still cannot resolve. Non-interactive
 * runs leave values unset so an agent can write them itself.
 */
async function setupCredentials(context: {
  root: string;
  spec: ScaffoldSpec;
  interactive: boolean;
  projectName: string;
  snapshot: ScaffoldSnapshot;
}): Promise<{ file?: WrittenFile; missingEnvVars: string[] }> {
  const { root, spec, interactive, projectName, snapshot } = context;
  if (!DATABASES[spec.database].needsCredentials) {
    return { missingEnvVars: [] };
  }

  const config = await loadConfig(root);
  const envPath = path.join(root, ENV_FILENAME);
  let file: WrittenFile | undefined;

  // Registered before the first write, so a rollback takes the values typed
  // here with it rather than leaving credentials in a directory with no project.
  await recordFile(snapshot, ENV_FILENAME);

  if (config.requiredEnvVars.length > 0 && !existsSync(envPath)) {
    const example = path.join(root, ENV_EXAMPLE_FILENAME);
    if (existsSync(example)) {
      await copyFile(example, envPath);
    } else {
      await writeFile(
        envPath,
        renderEnvFile({ projectName, variables: config.requiredEnvVars }),
        'utf8',
      );
    }
    file = { path: ENV_FILENAME, action: 'created' };
  }

  let envFile = await readEnvFile(envPath);
  let missing = describeEnvironment(config.requiredEnvVars, envFile).missing;

  if (interactive && missing.length > 0) {
    const collected = await promptEnvValues(missing);
    if (Object.keys(collected).length > 0) {
      const action = await writeEnvValues(envPath, collected, {
        header: `# Local credentials for the ${projectName} semantic layer.\n#\n# This file is gitignored. Fill in the values below, then run \`mora validate\`.`,
      });
      file = { path: ENV_FILENAME, action: file ? 'created' : action };
      envFile = await readEnvFile(envPath);
      missing = describeEnvironment(config.requiredEnvVars, envFile).missing;
    }
  }

  return { file, missingEnvVars: missing };
}

async function promptEnvValues(names: string[]): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  prompts.log.info(
    `These go in ${ENV_FILENAME}, which is gitignored. Leave a value empty to skip it.`,
  );
  for (const name of names) {
    const answer = await ask(
      prompts.text({
        message: name,
        placeholder: 'leave empty to skip',
      }),
    );
    if (answer.trim()) values[name] = answer.trim();
  }
  return values;
}

/**
 * Opens the connection init just declared. This is the whole check now: there
 * is no model to compile, and a semantic layer that cannot reach its database
 * is not worth leaving on disk.
 */
async function testNewConnection(context: {
  root: string;
  spec: ScaffoldSpec;
  flags: InitFlags;
  missingEnvVars: string[];
  prose: boolean;
}): Promise<ConnectionTestResult | null> {
  const { root, spec, flags, missingEnvVars, prose } = context;
  if (flags.test === false) return null;
  // An unset credential is already reported by name, and the driver would only
  // say the same thing less clearly. The scaffold still goes back.
  if (missingEnvVars.length > 0) return null;

  const config = await loadConfig(root);
  const connection = config.connections.find(
    (entry) => entry.name === spec.connectionName && entry.supported,
  );
  if (!connection?.supported) return null;

  const spinner = prose && process.stdout.isTTY ? prompts.spinner() : undefined;
  spinner?.start(`Testing ${connection.name}`);
  const result = await checkConnection(connection, root);
  if (spinner) {
    if (result.ok) spinner.stop(`${connection.name} answered`);
    else spinner.error(`${connection.name} did not answer`);
  } else if (prose && result.ok) {
    // Without a TTY there is no spinner to have said it, and a failure is
    // reported by the rollback that follows.
    prompts.log.success(`${connection.name} answered.`);
  }
  return result;
}

/**
 * Sets up a checkout of a project someone else built and committed. Nothing the
 * team owns is written: this creates the gitignored .env and compiles what is
 * already there, so a teammate learns their checkout works before they touch it.
 */
async function runJoin(root: string, flags: InitFlags): Promise<JoinReport> {
  const prose = !flags.json;
  const config = await loadConfig(root);

  if (prose) {
    prompts.intro(pc.bgCyan(pc.black(' mora init ')));
    prompts.log.info(
      `Found an existing semantic layer in ${pc.cyan(CONFIG_FILENAME)}, so this is a setup run.\n` +
        `Your models and configuration are left exactly as they are; only ${ENV_FILENAME} is written.`,
    );
  }

  const files: WrittenFile[] = [];
  const envFile = await ensureEnvFile(config);
  if (envFile) files.push(envFile);

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
    steps.push(
      `Run \`mora schema\` to see what the warehouse holds, then follow .agents/modeling.md to add sources in ${config.modelsDir}/.`,
    );
  } else {
    steps.push(
      `Read AGENTS.md, then read the models in ${config.modelsDir}/ to learn the vocabulary this team already agreed on.`,
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

function isInteractive(flags: InitFlags): boolean {
  if (flags.json || flags.yes) return false;
  // Agents and CI runners get a terminal often enough that isTTY alone is not a
  // reliable signal; prompting there would hang.
  if (process.env.CI) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function specFromFlags(root: string, flags: InitFlags): ScaffoldSpec {
  const database = parseDatabase(flags.db) ?? 'duckdb';
  const modelsDir = validateModelsDir(flags.models ?? DEFAULT_MODELS_DIR);
  return {
    root,
    projectName: validateProjectName(flags.name ?? defaultProjectName(root)),
    database,
    modelsDir,
    connectionName: connectionNameFromFlag(flags.connection, database),
    connectionSettings: settingsFromFlags(database, modelsDir, flags),
  };
}

function connectionNameFromFlag(given: string | undefined, database: DatabaseId): string {
  if (given === undefined) return suggestConnectionName(database, []);
  const name = given.trim();
  assertConnectionName(name);
  return name;
}

function settingsFromFlags(
  database: DatabaseId,
  modelsDir: string,
  flags: SettingFlags,
): Record<string, string> {
  const settings = defaultConnectionSettings(database, modelsDir);
  for (const setting of connectionSettings(database, { modelsDir })) {
    const fromFlag = flagValue(flags, setting);
    if (fromFlag !== undefined) settings[setting.key] = fromFlag;
  }
  return settings;
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

  // Not asked for: every Mora project keeping its models in the same place is
  // worth more than the choice. `--models` is there for a repo that needs a
  // different one.
  const modelsDir = validateModelsDir(flags.models ?? DEFAULT_MODELS_DIR);

  const connectionName =
    flags.connection?.trim() ||
    (await ask(
      prompts.text({
        message: 'Name models will use for it',
        placeholder: suggestConnectionName(database, []),
        defaultValue: suggestConnectionName(database, []),
        validate: (value) =>
          !value || CONNECTION_NAME_PATTERN.test(value.trim())
            ? undefined
            : 'A connection name must start with a letter or underscore and contain only letters, digits and underscores.',
      }),
    ));

  if (DATABASES[database].needsCredentials) {
    prompts.log.info(
      `${DATABASES[database].label} settings go into ${CONFIG_FILENAME}; secrets belong in ${ENV_FILENAME}.`,
    );
  }
  const settings = await chooseSettings(database, { modelsDir }, flags, true);

  return {
    root,
    projectName: validateProjectName(projectName),
    database,
    modelsDir,
    connectionName: connectionNameFromFlag(connectionName, database),
    connectionSettings: settings,
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
      hint: `Leave --models off to use ${DEFAULT_MODELS_DIR}/, or name a directory inside the project.`,
    });
  }
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new MoraError(`The models directory must stay inside the project: "${dir}".`, {
      code: 'invalid-models-dir',
      exitCode: ExitCode.usage,
      hint: `Pass a relative path with no \`..\`, such as --models ${DEFAULT_MODELS_DIR}. Every other command reads it from mora.yaml.`,
    });
  }
  return normalized;
}

function defaultProjectName(root: string): string {
  const base = path.basename(root);
  return PROJECT_NAME_PATTERN.test(base) ? base : FALLBACK_PROJECT_NAME;
}

function nextSteps(
  spec: ScaffoldSpec,
  missingEnvVars: string[],
  connection: ConnectionTestResult | null,
  kept: boolean,
): string[] {
  const steps: string[] = [];

  if (missingEnvVars.length > 0) {
    // After a rollback there is no .env left to edit, so say where the value
    // goes rather than naming a file the reader will not find.
    steps.push(
      kept
        ? `Set ${missingEnvVars.join(', ')} in ${ENV_FILENAME}, then run \`mora connection test ${spec.connectionName}\`.`
        : `Set ${missingEnvVars.join(', ')} in your environment, then run \`mora init\` again.`,
    );
    if (kept) return steps;
  }

  if (connection && !connection.ok) {
    steps.push(
      `Fix the ${spec.database} connection settings or your credentials, then run \`mora init\` again.`,
    );
    steps.push(...gcloudAuthStep(spec.database, spec.connectionSettings ?? {}));
  }

  if (!kept) return steps;

  steps.push(
    `Run \`mora schema\` to see what ${spec.connectionName} can read, then add sources over those tables in ${spec.modelsDir}/.`,
  );
  steps.push(
    `Read .agents/modeling.md before writing the first one: \`source: orders is ${spec.connectionName}.table('${DATABASES[spec.database].sampleTable}')\`.`,
  );
  steps.push('Run `mora validate` after every model edit, and before opening a pull request.');
  steps.push('Point your agent at AGENTS.md so it queries through the semantic layer.');
  return steps;
}

function reportScaffold(report: ScaffoldReport, directory: string): void {
  const location = directory === '.' ? 'this directory' : directory;

  if (report.rolledBack) {
    if (report.connection && !report.connection.ok) {
      prompts.log.error(`${report.connection.name}\n${report.connection.error ?? 'unknown error'}`);
    } else if (report.missingEnvVars.length > 0) {
      prompts.log.error(
        `${report.missingEnvVars.join(', ')} ${
          report.missingEnvVars.length === 1 ? 'is' : 'are'
        } not set, so ${report.project.connection} cannot be opened.`,
      );
    }
    prompts.note(report.nextSteps.map((step, i) => `${i + 1}. ${step}`).join('\n'), 'Next');
    prompts.outro(
      pc.yellow(
        `Nothing was written: ${location} is exactly as Mora found it. Run \`mora init\` again once that is fixed.`,
      ),
    );
    return;
  }

  prompts.note(
    report.files.map((file) => `${actionLabel(file.action)} ${file.path}`).join('\n'),
    'Files',
  );

  // The spinner has already said the connection answered; saying it again here
  // is the same sentence twice.
  if (report.missingEnvVars.length > 0) {
    prompts.log.warn(
      `${report.missingEnvVars.join(', ')} ${
        report.missingEnvVars.length === 1 ? 'is' : 'are'
      } not set.`,
    );
  }

  prompts.note(report.nextSteps.map((step, i) => `${i + 1}. ${step}`).join('\n'), 'Next');

  if (report.ok) {
    prompts.outro(
      `Semantic layer ready in ${pc.cyan(location)}. ${pc.dim('It has no models yet.')}`,
    );
    return;
  }

  prompts.outro(
    pc.yellow(
      `Scaffold written to ${location}, but ${count(report.missingEnvVars.length, 'credential')} still to set.`,
    ),
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
