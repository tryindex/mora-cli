import * as prompts from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, type MoraConfig, type SupportedConnectionConfig } from '../config.js';
import { DATABASE_IDS } from '../databases.js';
import { ExitCode, MoraError } from '../errors.js';
import { describeTables, listTables, type TableEntry, type TableSchema } from '../malloy/schema.js';
import { requireConnection } from '../project.js';
import { CONFIG_FILENAME } from '../scaffold.js';
import { count } from './validate.js';

interface SchemaFlags {
  directory: string;
  connection?: string;
  pattern?: string;
  json?: boolean;
}

export interface SchemaReport {
  ok: boolean;
  command: 'schema';
  root: string;
  connection: { name: string; type: string };
  /** The filter applied to the listing, or null when everything is listed. */
  pattern: string | null;
  /** Every table the connection can read, or null when tables were named. */
  tables: TableEntry[] | null;
  /** True when the listing stopped at a cap rather than at the end. */
  truncated: boolean;
  /** Columns of each named table, or null when listing. */
  schemas: TableSchema[] | null;
  nextSteps: string[];
}

export function registerSchemaCommand(program: Command): void {
  program
    .command('schema')
    .description('List the tables a connection can read, or show the columns of one')
    .argument('[tables...]', 'tables to show columns for, as this command lists them')
    .option('-c, --connection <name>', 'connection to read (default: the project default)')
    .option('-C, --directory <dir>', 'project directory', '.')
    .option('--pattern <text>', 'only list tables whose name contains this text')
    .option('--json', 'print a machine-readable result instead of prose')
    .addHelpText(
      'after',
      `
Agent usage:
  Run this before proposing a source for a table the semantic layer does not
  cover yet, and run it with no argument first: the listing is where valid names
  come from, so a name never has to be guessed. Every name it prints goes inside
  \`<connection>.table('...')\` unchanged. Naming several tables at once reads
  them in one pass. This shows the warehouse, not the semantic layer over it;
  read the models for the definitions that exist. Exit codes: ${ExitCode.ok} read,
  ${ExitCode.failure} the connection or a table could not be read, ${ExitCode.usage} bad usage.

Examples:
  $ mora schema
  $ mora schema --pattern order --json
  $ mora schema data/orders.csv
  $ mora schema analytics.orders analytics.customers --json
  $ mora schema --connection warehouse`,
    )
    .action(async (tables: string[], flags: SchemaFlags) => {
      const report = await runSchema(flags.directory, tables, flags);
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
      if (!report.ok) {
        process.exitCode = ExitCode.failure;
      }
    });
}

export async function runSchema(
  directory: string,
  tables: readonly string[] = [],
  flags: Omit<SchemaFlags, 'directory'> = {},
): Promise<SchemaReport> {
  const prose = !flags.json;
  // Deliberately not `openProject`: the whole point of this command is to be
  // useful before the models directory has anything in it.
  const config = await loadConfig(directory);
  const connection = selectConnection(config, flags.connection);

  if (prose) {
    prompts.intro(pc.bgCyan(pc.black(' mora schema ')));
  }

  const spinner = prose && process.stdout.isTTY ? prompts.spinner() : undefined;
  spinner?.start(tables.length > 0 ? 'Reading columns' : 'Listing tables');

  let report: SchemaReport;
  try {
    report =
      tables.length > 0
        ? await describeMode(config, connection, tables)
        : await listMode(config, connection, flags.pattern);
  } catch (error) {
    spinner?.error('Could not read the database');
    throw error;
  }

  spinner?.stop(
    report.schemas
      ? `Read ${count(report.schemas.length, 'table')}`
      : `Found ${count(report.tables?.length ?? 0, 'table')}`,
  );

  if (prose) {
    reportProse(report);
  }

  return report;
}

async function listMode(
  config: MoraConfig,
  connection: SupportedConnectionConfig,
  pattern: string | undefined,
): Promise<SchemaReport> {
  const { tables, truncated } = await listTables(connection, config.root, pattern);

  return {
    ok: true,
    command: 'schema',
    root: config.root,
    connection: { name: connection.name, type: connection.type },
    pattern: pattern ?? null,
    tables,
    truncated,
    schemas: null,
    nextSteps: listNextSteps(connection.name, tables, truncated, pattern),
  };
}

async function describeMode(
  config: MoraConfig,
  connection: SupportedConnectionConfig,
  tables: readonly string[],
): Promise<SchemaReport> {
  const schemas = await describeTables(connection, config.root, tables);

  return {
    // A table that could not be read is a failure of this command: an agent that
    // treats an empty column list as an empty table will write a source against
    // columns it never saw.
    ok: schemas.every((schema) => schema.error === undefined),
    command: 'schema',
    root: config.root,
    connection: { name: connection.name, type: connection.type },
    pattern: null,
    tables: null,
    truncated: false,
    schemas,
    nextSteps: describeNextSteps(connection.name, schemas),
  };
}

/**
 * The connection to introspect. Mirrors `mora connection test`: an unknown name
 * is a usage problem, and a type Mora has no driver for is a real failure.
 */
function selectConnection(config: MoraConfig, name: string | undefined): SupportedConnectionConfig {
  if (name === undefined) return requireConnection(config);

  const found = config.connections.find((entry) => entry.name === name);
  if (!found) {
    throw new MoraError(`No connection called "${name}" in ${CONFIG_FILENAME}.`, {
      code: 'unknown-connection',
      exitCode: ExitCode.usage,
      hint: `Declared: ${config.connections.map((entry) => entry.name).join(', ') || 'none'}.`,
    });
  }
  if (!found.supported) {
    throw new MoraError(`Mora has no driver for ${found.type} connections.`, {
      code: 'unsupported-connection',
      hint: `It can open ${DATABASE_IDS.join(' and ')} connections.`,
    });
  }
  return found;
}

function listNextSteps(
  connectionName: string,
  tables: TableEntry[],
  truncated: boolean,
  pattern: string | undefined,
): string[] {
  if (tables.length === 0) {
    return [
      pattern
        ? `Nothing matched "${pattern}". Run \`mora schema\` without --pattern to see everything.`
        : `This connection has no tables to read. Check \`mora connection test ${connectionName}\`, and that the data it points at exists.`,
    ];
  }

  const steps = [
    `Run \`mora schema ${tables[0]?.name}\` to see its columns. Name several tables to read them in one pass.`,
    'Read .agents/modeling.md before proposing sources, then check assumptions with `mora query -f` against the data.',
  ];
  if (truncated) {
    steps.push('More tables exist than were listed. Narrow the listing with --pattern.');
  }
  return steps;
}

function describeNextSteps(connectionName: string, schemas: TableSchema[]): string[] {
  const failed = schemas.filter((schema) => schema.error !== undefined);
  if (failed.length > 0) {
    return [
      `Could not read ${failed.map((schema) => schema.name).join(', ')}. Run \`mora schema\` to see the names this connection has.`,
    ];
  }

  const first = schemas[0]?.name;
  return [
    `Write a source: \`source: my_table is ${connectionName}.table('${first}')\`, with a \`#"\` doc string on every definition.`,
    'Verify keys, join cardinality and null rates with `mora query -f` before proposing measures. Never infer them from column names.',
    'Run `mora validate` when the model is written, then open a pull request so a human reviews the definitions.',
  ];
}

function reportProse(report: SchemaReport): void {
  const where = `${report.connection.name} ${pc.dim(report.connection.type)}`;

  if (report.schemas) {
    for (const schema of report.schemas) {
      if (schema.error) {
        prompts.log.error(`${schema.name} could not be read.\n${schema.error}`);
        continue;
      }
      prompts.note(columnLines(schema).join('\n'), `${schema.name}  ${pc.dim(where)}`);
    }
  } else {
    const tables = report.tables ?? [];
    if (tables.length === 0) {
      prompts.log.warn(
        report.pattern
          ? `Nothing matches "${report.pattern}".`
          : `${report.connection.name} has no tables to read.`,
      );
    } else {
      const width = Math.max(...tables.map((entry) => entry.name.length));
      prompts.note(
        tables
          .map((entry) => `  ${pc.cyan(entry.name.padEnd(width))}  ${pc.dim(entry.kind)}`)
          .join('\n'),
        `Tables in ${where}`,
      );
    }
  }

  prompts.note(report.nextSteps.map((step, index) => `${index + 1}. ${step}`).join('\n'), 'Next');

  if (report.schemas) {
    const columns = report.schemas.reduce((sum, schema) => sum + schema.columns.length, 0);
    prompts.outro(
      report.ok
        ? `${count(report.schemas.length, 'table')}, ${count(columns, 'column')}.`
        : pc.red(`${count(report.schemas.filter((s) => s.error).length, 'table')} unreadable.`),
    );
    return;
  }

  const total = report.tables?.length ?? 0;
  prompts.outro(
    report.truncated ? `${count(total, 'table')} shown, and more exist.` : count(total, 'table'),
  );
}

function columnLines(schema: TableSchema): string[] {
  if (schema.columns.length === 0) return [pc.dim('  (no columns)')];
  const width = Math.max(...schema.columns.map((column) => column.name.length));
  return schema.columns.map((column) => `  ${column.name.padEnd(width)}  ${pc.dim(column.type)}`);
}
