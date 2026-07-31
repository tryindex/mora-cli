import { existsSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as prompts from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, type MoraConfig } from '../config.js';
import {
  connectionSettings,
  DATABASE_IDS,
  DATABASES,
  type DatabaseId,
  defaultWarehouseSettings,
  isDatabaseId,
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
import { type CompileResult, compileModel } from '../malloy/compile.js';
import { isPluginInstalled } from '../plugins/loader.js';
import { isBuiltInPlugin } from '../plugins/registry.js';
import {
  assertConfigParses,
  buildScaffold,
  CONFIG_FILENAME,
  DUCKDB_CONNECTION_NAME,
  findConflicts,
  normalizeRelative,
  resolvePaths,
  type ScaffoldSpec,
  WAREHOUSE_CONNECTION_NAME,
  type WrittenFile,
  writeScaffold,
} from '../scaffold.js';
import { renderEnvFile } from '../templates/env.js';
import { CLI_VERSION, PACKAGE_NAME } from '../version.js';
import {
  type ConnectionTestResult,
  checkConnection,
  chooseSettings,
  flagValue,
  gcloudAuthStep,
  type SettingFlags,
} from './connection.js';
import { assessUpgrade, type UpgradeStatus } from './upgrade.js';
import { count, type ProjectValidation, printModelResults, validateProject } from './validate.js';

const DEFAULT_MODELS_DIR = 'metrics';
const FALLBACK_PROJECT_NAME = 'analytics';
const PROJECT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

/** Warehouse databases whose settings init can collect up front. */
const WAREHOUSE_IDS = DATABASE_IDS.filter((id) => id !== 'duckdb');

export interface InitFlags extends SettingFlags {
  name?: string;
  db?: string;
  models?: string;
  example: boolean;
  yes?: boolean;
  force?: boolean;
  json?: boolean;
  compile: boolean;
  /** Connectivity check for the chosen warehouse; defaults to true. */
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
    example: boolean;
  };
  files: WrittenFile[];
  compile: CompileResult;
  /** Variables the warehouse connection needs that are not set yet. */
  missingEnvVars: string[];
  /** The warehouse connectivity check, or null when it was not run. */
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
  /**
   * Plugins the project records, and whether each one is usable here. Join mode
   * never installs them: fetching a package a teammate committed a reference to
   * is a decision the reader makes by naming it.
   */
  plugins: { name: string; installed: boolean }[];
  /**
   * How the running CLI compares to the project's `cli_version` stamp.
   * Join mode never rewrites Mora-owned docs; it points at `mora upgrade`.
   */
  upgrade: {
    status: UpgradeStatus;
    projectVersion: string | null;
    cliVersion: string;
    message: string;
  };
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
    .option('-m, --models <dir>', `directory for Malloy models (default: ${DEFAULT_MODELS_DIR})`)
    .option('--no-example', 'skip the example model and its sample data')
    .option('-y, --yes', 'accept defaults without prompting')
    .option('-f, --force', 'overwrite existing files')
    .option('--no-compile', 'skip the Malloy compile check')
    .option('--no-test', 'skip the warehouse connectivity check')
    .option('--json', 'print a machine-readable result instead of prose');

  // One flag per warehouse setting so init can finish setup unattended. DuckDB's
  // settings are fixed by the scaffold, so only credentialed databases appear.
  for (const id of WAREHOUSE_IDS) {
    for (const setting of connectionSettings(id, { modelsDir: '<models>' })) {
      if (!command.options.some((option) => option.long === `--${setting.flag}`)) {
        command.option(`--${setting.flag} <value>`, `${DATABASES[id].label}: ${setting.label}`);
      }
    }
  }

  command
    .addHelpText(
      'after',
      `
Two modes:
  In a directory without ${CONFIG_FILENAME}, init scaffolds a new semantic layer. In a
  directory that already has one, it joins that project instead: it creates a local
  ${ENV_FILENAME} from ${ENV_EXAMPLE_FILENAME}, reports which credentials are still
  missing, notes when \`mora upgrade\` (or a newer CLI) is needed, and compiles the
  committed models. Nothing the team owns is changed. That is what a teammate runs
  after cloning. Pass --force to scaffold over an existing project.

  Choosing a warehouse interactively prompts for its settings, writes credential
  values into ${ENV_FILENAME}, and tests the connection so you leave ready to query.
  Pass the same settings as flags (e.g. --project-id) to do that unattended.

Agent usage:
  Pass --yes (or --json) to run without prompts. Exit codes: ${ExitCode.ok} success,
  ${ExitCode.failure} failure, ${ExitCode.usage} bad usage, ${ExitCode.conflict} refused because files already exist.

Examples:
  $ mora init
  $ mora init ./analytics --db duckdb --yes
  $ mora init --db bigquery --project-id '\${GOOGLE_CLOUD_PROJECT}' --yes
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

  const envSetup = await setupWarehouseCredentials({
    root,
    spec,
    interactive,
    projectName: spec.projectName,
  });
  if (envSetup.file) written.push(envSetup.file);

  const connection = await maybeTestWarehouse({
    root,
    spec,
    flags,
    missingEnvVars: envSetup.missingEnvVars,
    prose: interactive,
  });

  const report: ScaffoldReport = {
    ok:
      compile.status !== 'failed' &&
      envSetup.missingEnvVars.length === 0 &&
      (connection === null || connection.ok),
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
    missingEnvVars: envSetup.missingEnvVars,
    connection,
    nextSteps: nextSteps(spec, paths.exampleModelPath, envSetup.missingEnvVars, connection),
  };

  if (interactive) {
    reportInteractive(report, directory);
  }

  return report;
}

/**
 * Ensures a checkout that needs credentials has a `.env`, and interactively
 * fills in any `${VAR}` the warehouse still cannot resolve. Non-interactive
 * runs leave values unset so an agent can write them itself.
 */
async function setupWarehouseCredentials(context: {
  root: string;
  spec: ScaffoldSpec;
  interactive: boolean;
  projectName: string;
}): Promise<{ file?: WrittenFile; missingEnvVars: string[] }> {
  const { root, spec, interactive, projectName } = context;
  if (!DATABASES[spec.database].needsCredentials) {
    return { missingEnvVars: [] };
  }

  const config = await loadConfig(root);
  const envPath = path.join(root, ENV_FILENAME);
  let file: WrittenFile | undefined;

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

async function maybeTestWarehouse(context: {
  root: string;
  spec: ScaffoldSpec;
  flags: InitFlags;
  missingEnvVars: string[];
  prose: boolean;
}): Promise<ConnectionTestResult | null> {
  const { root, spec, flags, missingEnvVars, prose } = context;
  if (flags.test === false || !DATABASES[spec.database].needsCredentials) return null;
  if (missingEnvVars.length > 0) return null;

  const config = await loadConfig(root);
  const connection = config.connections.find(
    (entry) => entry.name === WAREHOUSE_CONNECTION_NAME && entry.supported,
  );
  if (!connection?.supported) return null;

  const spinner = prose && process.stdout.isTTY ? prompts.spinner() : undefined;
  spinner?.start(`Testing ${connection.name}`);
  const result = await checkConnection(connection, root);
  if (spinner) {
    if (result.ok) spinner.stop(`${connection.name} answered`);
    else spinner.error(`${connection.name} did not answer`);
  }
  return result;
}

/**
 * Sets up a checkout of a project someone else built and committed. Nothing the
 * team owns is written: this creates the gitignored .env. Mora-owned docs are
 * refreshed by `mora upgrade`, not here, so a teammate on an older CLI cannot
 * silently rewrite committed guidance backwards.
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

  const upgradeStatus = assessUpgrade(config);
  const upgrade = {
    status: upgradeStatus,
    projectVersion: config.cliVersion ?? null,
    cliVersion: CLI_VERSION,
    message: upgradeMessage(upgradeStatus, config.cliVersion),
  };

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

  const plugins = describePlugins(config);

  const report: JoinReport = {
    ok: validation.summary.failed === 0 && environment.missing.length === 0,
    command: 'init',
    mode: 'join',
    root: config.root,
    project: { name: config.projectName, models: config.modelsDir },
    files,
    environment,
    plugins,
    upgrade,
    ...validation,
    nextSteps: joinNextSteps(config, environment, validation, upgradeStatus, plugins),
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

function upgradeMessage(status: UpgradeStatus, projectVersion: string | undefined): string {
  switch (status) {
    case 'up-to-date':
      return `Project matches Mora ${CLI_VERSION}.`;
    case 'pending':
      return projectVersion
        ? `Project is at ${projectVersion}; running Mora is ${CLI_VERSION}. Run \`mora upgrade\`.`
        : `Project has no cli_version stamp. Run \`mora upgrade\` to refresh Mora-owned files.`;
    case 'cli-behind':
      return (
        `Project is at ${projectVersion}; you are running Mora ${CLI_VERSION}. ` +
        `Update with \`npm i -g ${PACKAGE_NAME}@latest\`.`
      );
  }
}

/**
 * A built-in plugin is always usable; a third-party one lives in the checkout's
 * own `.mora/plugins/`, which is gitignored and therefore empty in a fresh clone.
 */
function describePlugins(config: MoraConfig): { name: string; installed: boolean }[] {
  return config.plugins.map((entry) => ({
    name: entry.name,
    installed:
      isBuiltInPlugin(entry.name) ||
      (entry.package !== undefined && isPluginInstalled(config.root, entry.package)),
  }));
}

function joinNextSteps(
  config: MoraConfig,
  environment: EnvironmentReport,
  validation: ProjectValidation,
  upgradeStatus: UpgradeStatus,
  plugins: { name: string; installed: boolean }[],
): string[] {
  const steps: string[] = [];

  const uninstalled = plugins.filter((plugin) => !plugin.installed);
  if (uninstalled.length > 0) {
    steps.push(
      `Install the plugins this project uses: ${uninstalled
        .map((plugin) => `\`mora plugin add ${plugin.name}\``)
        .join(', ')}.`,
    );
  }

  if (upgradeStatus === 'pending') {
    steps.push('Run `mora upgrade` to refresh Mora-owned docs and stamp this CLI version.');
  } else if (upgradeStatus === 'cli-behind') {
    steps.push(
      `Update the CLI with \`npm i -g ${PACKAGE_NAME}@latest\`, then re-run \`mora init\`.`,
    );
  }

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

  if (report.upgrade.status !== 'up-to-date') {
    if (report.upgrade.status === 'cli-behind') {
      prompts.log.warn(report.upgrade.message);
    } else {
      prompts.log.info(report.upgrade.message);
    }
  }

  if (report.environment.required.length > 0) {
    prompts.note(environmentLines(report.environment).join('\n'), 'Credentials');
  }

  if (report.plugins.length > 0) {
    prompts.note(
      report.plugins
        .map(
          (plugin) =>
            `${plugin.installed ? pc.green('    ok') : pc.yellow(' missing')} ${plugin.name}`,
        )
        .join('\n'),
      'Plugins',
    );
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
  const database = parseDatabase(flags.db) ?? 'duckdb';
  const modelsDir = validateModelsDir(flags.models ?? DEFAULT_MODELS_DIR);
  return {
    root,
    projectName: validateProjectName(flags.name ?? defaultProjectName(root)),
    database,
    modelsDir,
    includeExample: flags.example,
    warehouseSettings:
      database === 'duckdb' ? undefined : warehouseSettingsFromFlags(database, modelsDir, flags),
  };
}

function warehouseSettingsFromFlags(
  database: Exclude<DatabaseId, 'duckdb'>,
  modelsDir: string,
  flags: SettingFlags,
): Record<string, string> {
  const settings = defaultWarehouseSettings(database, modelsDir);
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

  let warehouseSettings: Record<string, string> | undefined;
  if (DATABASES[database].needsCredentials && database !== 'duckdb') {
    prompts.log.info(
      `The example model stays on DuckDB so you have something that works right away.\n` +
        `${DATABASES[database].label} settings go into ${CONFIG_FILENAME}; secrets belong in ${ENV_FILENAME}.`,
    );
    warehouseSettings = await chooseSettings(database, { modelsDir }, flags, true);
  }

  const includeExample = flags.example
    ? await ask(
        prompts.confirm({
          message: 'Include an example model with sample data?',
          initialValue: true,
        }),
      )
    : false;

  return {
    root,
    projectName: validateProjectName(projectName),
    database,
    modelsDir,
    includeExample,
    warehouseSettings,
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

function nextSteps(
  spec: ScaffoldSpec,
  exampleModelPath: string,
  missingEnvVars: string[],
  connection: ConnectionTestResult | null,
): string[] {
  const steps: string[] = [];
  if (spec.includeExample) {
    steps.push(`Read ${exampleModelPath} to see how sources, measures and views fit together.`);
    steps.push('Run `mora describe` to list the vocabulary, then `mora query monthly_revenue`.');
  }
  if (missingEnvVars.length > 0) {
    steps.push(
      `Set ${missingEnvVars.join(', ')} in ${ENV_FILENAME}, then run \`mora connection test ${WAREHOUSE_CONNECTION_NAME}\`.`,
    );
  } else if (connection && !connection.ok) {
    steps.push(
      `Fix the ${spec.database} connection settings or your credentials, then run \`mora connection test ${WAREHOUSE_CONNECTION_NAME}\`.`,
    );
    steps.push(...gcloudAuthStep(spec.database, spec.warehouseSettings ?? {}));
  } else if (DATABASES[spec.database].needsCredentials && connection?.ok) {
    steps.push(
      `Add a source over your warehouse tables: \`source: my_table is ${WAREHOUSE_CONNECTION_NAME}.table('dataset.my_table')\`.`,
    );
  }
  steps.push(
    spec.includeExample
      ? `Replace the example with sources over your own tables in ${spec.modelsDir}/.`
      : `Add sources over your own tables in ${spec.modelsDir}/.`,
  );
  steps.push('Point your agent at AGENTS.md so it queries through the semantic layer.');
  steps.push(
    'Run `mora plugin add publisher` when these models should also be served over ' +
      'REST and MCP by Malloy Publisher.',
  );
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

  if (report.missingEnvVars.length > 0) {
    prompts.log.warn(
      `${report.missingEnvVars.join(', ')} ${
        report.missingEnvVars.length === 1 ? 'is' : 'are'
      } not set.`,
    );
  }
  if (report.connection && !report.connection.ok) {
    prompts.log.error(`${report.connection.name}\n${report.connection.error ?? 'unknown error'}`);
  }

  prompts.note(report.nextSteps.map((step, i) => `${i + 1}. ${step}`).join('\n'), 'Next');

  const location = directory === '.' ? 'this directory' : directory;
  if (report.ok) {
    const warehouse =
      report.connection?.ok === true ? ` ${pc.cyan(report.connection.name)} is reachable.` : '';
    prompts.outro(`Semantic layer ready in ${pc.cyan(location)}.${warehouse}`);
    return;
  }

  const reasons: string[] = [];
  if (report.compile.status === 'failed') reasons.push('the example failed to compile');
  if (report.missingEnvVars.length > 0) {
    reasons.push(`${count(report.missingEnvVars.length, 'credential')} still to set`);
  }
  if (report.connection && !report.connection.ok) {
    reasons.push(`${report.connection.name} is not reachable yet`);
  }
  prompts.outro(
    pc.yellow(
      `Scaffold written to ${location}${reasons.length > 0 ? `, but ${reasons.join(' and ')}` : ''}.`,
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
