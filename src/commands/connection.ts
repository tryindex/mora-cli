import * as prompts from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import {
  type ConnectionConfig,
  loadConfig,
  type MoraConfig,
  type SupportedConnectionConfig,
} from '../config.js';
import {
  addConnection,
  assertConnectionName,
  type EnvExampleUpdate,
  syncEnvExample,
} from '../connections.js';
import {
  type ConnectionSetting,
  connectionSettings,
  DATABASE_IDS,
  DATABASES,
  type DatabaseId,
  isDatabaseId,
} from '../databases.js';
import { describeEnvironment, ENV_FILENAME, readEnvFile } from '../env.js';
import { ExitCode, MoraError } from '../errors.js';
import { describeError, testConnection } from '../malloy/runtime.js';
import { CONFIG_FILENAME } from '../scaffold.js';

interface AddFlags extends Record<string, unknown> {
  directory: string;
  type?: string;
  default?: boolean;
  test: boolean;
  yes?: boolean;
  json?: boolean;
}

interface CommonFlags {
  directory: string;
  json?: boolean;
}

export interface ConnectionSummary {
  name: string;
  type: string;
  /** Whether Mora has a driver for this type. */
  supported: boolean;
  /** True for the connection a model naming none reads from. */
  isDefault: boolean;
  /** Variables the connection's settings refer to that have no value. */
  missingEnvVars: string[];
}

export interface ConnectionListReport {
  ok: boolean;
  command: 'connection list';
  root: string;
  connections: ConnectionSummary[];
}

export interface ConnectionTestResult {
  name: string;
  type: string;
  ok: boolean;
  /** Why the connection could not be reached, when it could not. */
  error?: string;
  durationMs: number;
}

export interface ConnectionTestReport {
  ok: boolean;
  command: 'connection test';
  root: string;
  results: ConnectionTestResult[];
}

export interface ConnectionAddReport {
  ok: boolean;
  command: 'connection add';
  root: string;
  connection: { name: string; type: DatabaseId; settings: Record<string, string> };
  isDefault: boolean;
  files: string[];
  envExample: EnvExampleUpdate;
  /** Variables the new connection needs that are not set yet. */
  missingEnvVars: string[];
  /** The connectivity check, or null when it was not run. */
  test: ConnectionTestResult | null;
  nextSteps: string[];
}

export function registerConnectionCommand(program: Command): void {
  const connection = program
    .command('connection')
    .description('Add, inspect and test the database connections a project reads from');

  registerAdd(connection);
  registerTest(connection);
  registerList(connection);
}

function registerAdd(parent: Command): void {
  const command = parent
    .command('add')
    .description(`Declare a connection in ${CONFIG_FILENAME} and check that it works`)
    .argument('[name]', 'name models will use, as in `warehouse.table(...)`')
    .option('-t, --type <database>', `connection type (${DATABASE_IDS.join(', ')})`)
    .option('-C, --directory <dir>', 'project directory', '.')
    .option('--default', 'make this the connection models fall back to')
    .option('--no-test', 'skip the connectivity check')
    .option('-y, --yes', 'accept defaults without prompting')
    .option('--json', 'print a machine-readable result instead of prose');

  // One flag per setting, so a connection can be added unattended. Values may be
  // literals or `${VAR}` references; a credential belongs in the latter.
  for (const id of DATABASE_IDS) {
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
Agent usage:
  Prefer \`\${VAR}\` over a literal for anything secret: mora.yaml is committed,
  and .env is not. Exit codes: ${ExitCode.ok} added, ${ExitCode.failure} added but unreachable,
  ${ExitCode.usage} bad usage or the name is taken.

Examples:
  $ mora connection add warehouse --type bigquery --project-id '\${GOOGLE_CLOUD_PROJECT}'
  $ mora connection add exports --type duckdb --database exports.duckdb --yes
  $ mora connection add warehouse -t bigquery --project-id acme-prod --default --json`,
    )
    .action(async (name: string | undefined, flags: AddFlags) => {
      const report = await runConnectionAdd(flags.directory, name, flags);
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
      if (!report.ok) {
        process.exitCode = ExitCode.failure;
      }
    });
}

function registerTest(parent: Command): void {
  parent
    .command('test')
    .description('Open each connection and report whether the database answers')
    .argument('[name]', 'only test this connection')
    .option('-C, --directory <dir>', 'project directory', '.')
    .option('--json', 'print a machine-readable result instead of prose')
    .addHelpText(
      'after',
      `
Agent usage:
  Run this when a query fails for a reason that looks like access rather than
  logic. Exit codes: ${ExitCode.ok} every connection answered, ${ExitCode.failure} at least one did not.

Examples:
  $ mora connection test
  $ mora connection test warehouse --json`,
    )
    .action(async (name: string | undefined, flags: CommonFlags) => {
      const report = await runConnectionTest(flags.directory, name, flags);
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
      if (!report.ok) {
        process.exitCode = ExitCode.failure;
      }
    });
}

function registerList(parent: Command): void {
  parent
    .command('list')
    .description('Show the connections the project declares and their credential status')
    .option('-C, --directory <dir>', 'project directory', '.')
    .option('--json', 'print a machine-readable result instead of prose')
    .addHelpText(
      'after',
      `
Examples:
  $ mora connection list
  $ mora connection list --json`,
    )
    .action(async (flags: CommonFlags) => {
      const report = await runConnectionList(flags.directory, flags);
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
    });
}

export async function runConnectionList(
  directory: string,
  flags: { json?: boolean } = {},
): Promise<ConnectionListReport> {
  const config = await loadConfig(directory);
  const envFile = await readEnvFile(`${config.root}/${ENV_FILENAME}`);

  const connections = config.connections.map<ConnectionSummary>((connection) => ({
    name: connection.name,
    type: connection.type,
    supported: connection.supported,
    isDefault: connection.name === config.defaultConnection,
    missingEnvVars: describeEnvironment(connection.requiredEnvVars, envFile).missing,
  }));

  const report: ConnectionListReport = {
    ok: true,
    command: 'connection list',
    root: config.root,
    connections,
  };

  if (!flags.json) {
    prompts.intro(pc.bgCyan(pc.black(' mora connection list ')));
    if (connections.length === 0) {
      prompts.outro(pc.yellow(`No connections are declared in ${CONFIG_FILENAME}.`));
      return report;
    }
    prompts.note(connections.map(listLine).join('\n'), 'Connections');
    prompts.outro(`${connections.length} declared.`);
  }

  return report;
}

function listLine(connection: ConnectionSummary): string {
  const marks: string[] = [pc.dim(connection.type)];
  if (connection.isDefault) marks.push(pc.dim('default'));
  if (!connection.supported) marks.push(pc.yellow('no driver'));
  if (connection.missingEnvVars.length > 0) {
    marks.push(pc.red(`unset: ${connection.missingEnvVars.join(', ')}`));
  }
  return `  ${pc.cyan(connection.name)}  ${marks.join('  ')}`;
}

export async function runConnectionTest(
  directory: string,
  name: string | undefined,
  flags: { json?: boolean } = {},
): Promise<ConnectionTestReport> {
  const config = await loadConfig(directory);
  const prose = !flags.json;

  if (prose) {
    prompts.intro(pc.bgCyan(pc.black(' mora connection test ')));
  }

  const results: ConnectionTestResult[] = [];
  for (const connection of selectForTest(config, name)) {
    const spinner = prose && process.stdout.isTTY ? prompts.spinner() : undefined;
    spinner?.start(`Testing ${connection.name}`);
    const result = await checkConnection(connection, config.root);
    results.push(result);
    if (spinner) {
      if (result.ok) spinner.stop(`${connection.name} answered`);
      else spinner.error(`${connection.name} did not answer`);
    }
  }

  const report: ConnectionTestReport = {
    ok: results.every((result) => result.ok),
    command: 'connection test',
    root: config.root,
    results,
  };

  if (prose) {
    for (const result of results.filter((entry) => !entry.ok)) {
      prompts.log.error(`${result.name}\n${result.error ?? 'unknown error'}`);
    }
    prompts.outro(
      report.ok
        ? `${results.length === 1 ? '1 connection' : `${results.length} connections`} reachable.`
        : pc.red(`${results.filter((result) => !result.ok).length} unreachable.`),
    );
  }

  return report;
}

/**
 * Runs the driver's own connectivity check. A failure is reported rather than
 * thrown: the point of this command is to say which connection is unreachable
 * and why, and one bad connection should not hide the state of the others.
 */
export async function checkConnection(
  connection: SupportedConnectionConfig,
  root: string,
): Promise<ConnectionTestResult> {
  const startedAt = Date.now();
  try {
    await testConnection(connection, root);
    return {
      name: connection.name,
      type: connection.type,
      ok: true,
      durationMs: elapsed(startedAt),
    };
  } catch (error) {
    return {
      name: connection.name,
      type: connection.type,
      ok: false,
      error: describeError(error),
      durationMs: elapsed(startedAt),
    };
  }
}

function elapsed(startedAt: number): number {
  return Date.now() - startedAt;
}

function selectForTest(config: MoraConfig, name: string | undefined): SupportedConnectionConfig[] {
  const declared = config.connections;
  if (name === undefined) {
    const usable = declared.filter((entry) => entry.supported);
    if (usable.length === 0) {
      throw new MoraError(`No connection in ${CONFIG_FILENAME} can be opened.`, {
        code: 'no-supported-connection',
        hint: `Run \`mora connection add\` to declare one. Mora can open ${DATABASE_IDS.join(' and ')} connections.`,
      });
    }
    return usable;
  }

  const found = declared.find((entry) => entry.name === name);
  if (!found) {
    throw new MoraError(`No connection called "${name}" in ${CONFIG_FILENAME}.`, {
      code: 'unknown-connection',
      exitCode: ExitCode.usage,
      hint: `Declared: ${declared.map((entry) => entry.name).join(', ') || 'none'}.`,
    });
  }
  if (!found.supported) {
    throw new MoraError(`Mora has no driver for ${found.type} connections.`, {
      code: 'unsupported-connection',
      hint: `It can open ${DATABASE_IDS.join(' and ')} connections.`,
    });
  }
  return [found];
}

export async function runConnectionAdd(
  directory: string,
  name: string | undefined,
  flags: Partial<AddFlags> = {},
): Promise<ConnectionAddReport> {
  const config = await loadConfig(directory);
  const interactive = !flags.json && !flags.yes && process.stdin.isTTY === true;
  const prose = !flags.json;

  if (prose) {
    prompts.intro(pc.bgCyan(pc.black(' mora connection add ')));
  }

  const type = await chooseType(flags.type, interactive);
  const connectionName = await chooseName(name, type, config, interactive);
  const settings = await chooseSettings(type, config, flags, interactive);
  const makeDefault = await chooseDefault(flags.default, config, interactive);

  const { contents } = await addConnection(config, {
    name: connectionName,
    type,
    settings,
    comments: comments(type, config),
    makeDefault,
  });
  const envExample = await syncEnvExample(config.root, config.projectName, contents);

  // Re-read rather than patch the config in memory: the connection Mora is about
  // to test should be the one it just wrote, parsed the same way every other
  // command will parse it.
  const written = await loadConfig(config.root);
  const added = written.connections.find((entry) => entry.name === connectionName);
  const envFile = await readEnvFile(`${written.root}/${ENV_FILENAME}`);
  const missingEnvVars = describeEnvironment(added?.requiredEnvVars ?? [], envFile).missing;

  const test = await maybeTest({ added, root: written.root, flags, missingEnvVars, prose });

  const report: ConnectionAddReport = {
    ok: test === null || test.ok,
    command: 'connection add',
    root: written.root,
    connection: { name: connectionName, type, settings },
    isDefault: written.defaultConnection === connectionName,
    files: [CONFIG_FILENAME, ...(envExample.action === 'unchanged' ? [] : [envExample.path])],
    envExample,
    missingEnvVars,
    test,
    nextSteps: addNextSteps({ connectionName, type, missingEnvVars, test }),
  };

  if (prose) {
    reportAdd(report);
  }

  return report;
}

async function maybeTest(context: {
  added: ConnectionConfig | undefined;
  root: string;
  flags: Partial<AddFlags>;
  missingEnvVars: string[];
  prose: boolean;
}): Promise<ConnectionTestResult | null> {
  const { added, flags, missingEnvVars, prose, root } = context;
  if (flags.test === false || !added?.supported) return null;
  // An unset credential is already reported as the next thing to do, and the
  // test would only say the same thing in the driver's words.
  if (missingEnvVars.length > 0) return null;

  const spinner = prose && process.stdout.isTTY ? prompts.spinner() : undefined;
  spinner?.start(`Testing ${added.name}`);
  const result = await checkConnection(added, root);
  if (spinner) {
    if (result.ok) spinner.stop(`${added.name} answered`);
    else spinner.error(`${added.name} did not answer`);
  }
  return result;
}

async function chooseType(flag: string | undefined, interactive: boolean): Promise<DatabaseId> {
  if (flag !== undefined) {
    const normalized = flag.trim().toLowerCase();
    if (!isDatabaseId(normalized)) {
      throw new MoraError(`"${flag}" is not a connection type Mora can open.`, {
        code: 'unknown-database',
        exitCode: ExitCode.usage,
        hint: `Supported: ${DATABASE_IDS.join(', ')}.`,
      });
    }
    return normalized;
  }

  if (!interactive) {
    throw new MoraError('No connection type given.', {
      code: 'missing-type',
      exitCode: ExitCode.usage,
      hint: `Pass --type with one of: ${DATABASE_IDS.join(', ')}.`,
    });
  }

  return unlessCancelled(
    await prompts.select<DatabaseId>({
      message: 'What are you connecting to?',
      options: DATABASE_IDS.map((id) => ({
        value: id,
        label: DATABASES[id].label,
        hint: DATABASES[id].hint,
      })),
    }),
  );
}

async function chooseName(
  given: string | undefined,
  type: DatabaseId,
  config: MoraConfig,
  interactive: boolean,
): Promise<string> {
  if (given !== undefined) {
    assertConnectionName(given.trim());
    return given.trim();
  }

  if (!interactive) return uniqueName(type, config);

  const answer = unlessCancelled(
    await prompts.text({
      message: 'Name models will use for it',
      placeholder: uniqueName(type, config),
      defaultValue: uniqueName(type, config),
      validate: (value) => {
        const candidate = value?.trim() || uniqueName(type, config);
        if (config.connections.some((entry) => entry.name === candidate)) {
          return `${CONFIG_FILENAME} already has a connection called "${candidate}".`;
        }
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) {
          return 'A connection name must start with a letter or underscore and contain only letters, digits and underscores.';
        }
        return undefined;
      },
    }),
  );

  return answer.trim() || uniqueName(type, config);
}

/** `warehouse`, then `warehouse_2`: a suggestion that is not already taken. */
function uniqueName(type: DatabaseId, config: MoraConfig): string {
  const base = type === 'bigquery' ? 'warehouse' : type;
  const taken = new Set(config.connections.map((entry) => entry.name));
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function chooseSettings(
  type: DatabaseId,
  config: MoraConfig,
  flags: Partial<AddFlags>,
  interactive: boolean,
): Promise<Record<string, string>> {
  const settings: Record<string, string> = {};

  for (const setting of connectionSettings(type, { modelsDir: config.modelsDir })) {
    const fromFlag = flagValue(flags, setting);
    if (fromFlag !== undefined) {
      settings[setting.key] = fromFlag;
      continue;
    }

    const suggested = suggest(setting);
    if (!interactive) {
      if (suggested !== undefined) settings[setting.key] = suggested;
      else if (setting.required) {
        throw new MoraError(`${DATABASES[type].label} needs a ${setting.label.toLowerCase()}.`, {
          code: 'missing-setting',
          exitCode: ExitCode.usage,
          hint: `Pass --${setting.flag}.`,
        });
      }
      continue;
    }

    const answer = unlessCancelled(
      await prompts.text({
        message: setting.required ? setting.label : `${setting.label} ${pc.dim('(optional)')}`,
        placeholder: suggested ?? setting.placeholder ?? pc.dim('leave empty to skip'),
        defaultValue: suggested ?? '',
        validate: (value) =>
          setting.required && !value?.trim() && suggested === undefined
            ? `${setting.label} is required.`
            : undefined,
      }),
    );

    const value = answer.trim() || suggested;
    if (value) settings[setting.key] = value;
  }

  return settings;
}

/**
 * What to write when nobody says otherwise. A setting with a conventional
 * environment variable is offered as a `${VAR}` reference, because mora.yaml is
 * committed and a credential written into it is a credential leaked.
 */
function suggest(setting: ConnectionSetting): string | undefined {
  if (setting.defaultValue !== undefined) return setting.defaultValue;
  if (setting.envVar && setting.required) return `\${${setting.envVar}}`;
  return undefined;
}

function flagValue(flags: Partial<AddFlags>, setting: ConnectionSetting): string | undefined {
  // Commander camel-cases long flags: --project-id lands on `projectId`.
  const key = setting.flag.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  const value = flags[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function comments(type: DatabaseId, config: MoraConfig): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const setting of connectionSettings(type, { modelsDir: config.modelsDir })) {
    if (setting.comment) notes[setting.key] = setting.comment;
  }
  return notes;
}

async function chooseDefault(
  flag: boolean | undefined,
  config: MoraConfig,
  interactive: boolean,
): Promise<boolean> {
  if (flag !== undefined) return flag;
  // A project with no default yet needs one, whatever the answer would have been.
  if (config.defaultConnection === undefined) return true;
  if (!interactive) return false;

  return unlessCancelled(
    await prompts.confirm({
      message: `Make this the default, instead of ${config.defaultConnection}?`,
      initialValue: false,
    }),
  );
}

function addNextSteps(context: {
  connectionName: string;
  type: DatabaseId;
  missingEnvVars: string[];
  test: ConnectionTestResult | null;
}): string[] {
  const { connectionName, missingEnvVars, test } = context;
  const steps: string[] = [];

  if (missingEnvVars.length > 0) {
    steps.push(
      `Set ${missingEnvVars.join(', ')} in ${ENV_FILENAME}, then run \`mora connection test ${connectionName}\`.`,
    );
  } else if (test && !test.ok) {
    steps.push(
      `Fix the connection settings or your credentials, then run \`mora connection test ${connectionName}\`.`,
    );
  } else {
    steps.push(
      `Add a source to a model: \`source: my_table is ${connectionName}.table('dataset.my_table')\`.`,
    );
    steps.push('Run `mora validate` to check it compiles, then `mora describe` to see it.');
  }

  steps.push(
    'A Publisher server needs this connection in its own config; Mora does not edit publisher.config.json.',
  );
  return steps;
}

function reportAdd(report: ConnectionAddReport): void {
  const { connection } = report;
  prompts.note(
    [
      `${pc.cyan(connection.name)}  ${pc.dim(connection.type)}${report.isDefault ? pc.dim('  default') : ''}`,
      ...Object.entries(connection.settings).map(([key, value]) => `  ${key}: ${pc.dim(value)}`),
    ].join('\n'),
    `Added to ${CONFIG_FILENAME}`,
  );

  if (report.envExample.added.length > 0) {
    prompts.log.info(
      `${report.envExample.path} now lists ${report.envExample.added.join(', ')}, so a teammate knows what to set.`,
    );
  }
  if (report.missingEnvVars.length > 0) {
    prompts.log.warn(
      `${report.missingEnvVars.join(', ')} ${plural(report.missingEnvVars)} not set.`,
    );
  }
  if (report.test && !report.test.ok) {
    prompts.log.error(`${report.test.name}\n${report.test.error ?? 'unknown error'}`);
  }

  prompts.note(report.nextSteps.map((step, index) => `${index + 1}. ${step}`).join('\n'), 'Next');
  prompts.outro(
    report.ok
      ? `${pc.cyan(connection.name)} is declared${report.test?.ok ? ' and reachable' : ''}.`
      : pc.red(`${connection.name} is declared but not reachable yet.`),
  );
}

function plural(names: string[]): string {
  return names.length === 1 ? 'is' : 'are';
}

/** A cancelled prompt is a deliberate exit, not a failure worth a stack trace. */
function unlessCancelled<T>(value: T | symbol): T {
  if (prompts.isCancel(value)) {
    prompts.cancel('Cancelled. Nothing was written.');
    process.exit(ExitCode.ok);
  }
  return value;
}
