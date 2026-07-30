import * as prompts from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import { ExitCode, MoraError } from '../errors.js';
import { type QueryRow, runQuery } from '../malloy/query.js';
import { openProject } from '../project.js';
import { count } from './validate.js';

const DEFAULT_LIMIT = 50;

interface QueryFlags {
  directory: string;
  expr?: string;
  sql?: boolean;
  limit?: string;
  json?: boolean;
}

export interface QueryReport {
  ok: boolean;
  command: 'query';
  root: string;
  /** The definition that ran, or null for an ad-hoc expression. */
  name: string | null;
  /** False when the logic came from `-e` rather than from the model. */
  reviewed: boolean;
  model: string | null;
  sql: string;
  /** False under --sql, where the SQL was compiled but never run. */
  executed: boolean;
  rows: QueryRow[];
  rowCount: number;
  truncated: boolean;
  nextSteps: string[];
}

export function registerQueryCommand(program: Command): void {
  program
    .command('query')
    .description('Run a definition from the semantic layer and print the rows and SQL')
    .argument('[name]', 'definition to run, as `mora describe` lists it')
    .option('-e, --expr <malloy>', 'run Malloy the model does not define')
    .option('-C, --directory <dir>', 'project directory', '.')
    .option('--sql', 'print the generated SQL without running it')
    .option('-l, --limit <n>', `largest number of rows to return (default: ${DEFAULT_LIMIT})`)
    .option('--json', 'print a machine-readable result instead of prose')
    .addHelpText(
      'after',
      `
Reviewed vs not:
  A name resolves to a definition someone committed and reviewed, and the result
  is marked reviewed. --expr runs Malloy that nobody has reviewed, and is marked
  reviewed: false. Explore with --expr, then promote anything worth keeping to a
  named view or query and run it by name.

Agent usage:
  Every result carries the SQL that produced it; report it alongside the answer.
  Exit codes: ${ExitCode.ok} the query ran, ${ExitCode.failure} it did not, ${ExitCode.usage} bad usage.

Examples:
  $ mora query monthly_revenue
  $ mora query orders.revenue_by_month --limit 12
  $ mora query -e "orders -> { aggregate: revenue }"
  $ mora query monthly_revenue --sql`,
    )
    .action(async (name: string | undefined, flags: QueryFlags) => {
      const report = await runQueryCommand(flags.directory, name, flags);
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
      if (!report.ok) {
        process.exitCode = ExitCode.failure;
      }
    });
}

export async function runQueryCommand(
  directory: string,
  name: string | undefined,
  flags: Omit<QueryFlags, 'directory'> = {},
): Promise<QueryReport> {
  const prose = !flags.json;

  if (!name && !flags.expr) {
    throw new MoraError('Nothing to run.', {
      code: 'no-query',
      exitCode: ExitCode.usage,
      hint: 'Pass a definition name, or -e with Malloy. `mora describe` lists the names.',
    });
  }
  if (name && flags.expr) {
    throw new MoraError('Pass either a definition name or --expr, not both.', {
      code: 'conflicting-query',
      exitCode: ExitCode.usage,
      hint: 'A name runs reviewed logic; --expr runs logic that has not been reviewed.',
    });
  }

  const limit = parseLimit(flags.limit);
  const { config, connection, modelPaths } = await openProject(directory);

  if (prose) {
    prompts.intro(pc.bgCyan(pc.black(' mora query ')));
  }

  const spinner = prose && process.stdout.isTTY ? prompts.spinner() : undefined;
  spinner?.start(flags.sql ? 'Compiling' : 'Running');

  let outcome: Awaited<ReturnType<typeof runQuery>>;
  try {
    outcome = await runQuery({
      root: config.root,
      modelPaths,
      connectionName: connection.name,
      workingDirectory: connection.workingDirectory,
      database: connection.database,
      name,
      expr: flags.expr,
      limit,
      sqlOnly: flags.sql,
    });
  } catch (error) {
    spinner?.error('Query failed');
    throw error;
  }
  spinner?.stop(flags.sql ? 'Compiled' : `Ran ${count(outcome.rowCount, 'row')}`);

  const report: QueryReport = {
    ok: true,
    command: 'query',
    root: config.root,
    name: outcome.name,
    reviewed: outcome.reviewed,
    model: outcome.model,
    sql: outcome.sql,
    executed: !flags.sql,
    rows: outcome.rows,
    rowCount: outcome.rowCount,
    truncated: outcome.truncated,
    nextSteps: nextSteps(outcome.reviewed, outcome.truncated, Boolean(flags.sql)),
  };

  if (prose) {
    reportProse(report);
  }

  return report;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new MoraError(`--limit must be a positive whole number, not "${value}".`, {
      code: 'invalid-limit',
      exitCode: ExitCode.usage,
    });
  }
  return limit;
}

function nextSteps(reviewed: boolean, truncated: boolean, sqlOnly: boolean): string[] {
  const steps: string[] = [];
  if (!reviewed) {
    steps.push(
      'This logic is not in the model, so nobody has reviewed it. If the answer is worth ' +
        'keeping, add it as a named view or query and run it by name.',
    );
  }
  if (truncated) {
    steps.push('More rows matched than were returned. Raise --limit, or aggregate further.');
  }
  if (sqlOnly) {
    steps.push('Nothing was executed. Drop --sql to run the query.');
  }
  steps.push('Report the SQL above alongside the answer, so a human can audit it.');
  return steps;
}

function reportProse(report: QueryReport): void {
  if (!report.reviewed) {
    prompts.log.warn(
      pc.yellow('Unreviewed: ') +
        'this ran Malloy that is not in the model, so the logic behind these\n' +
        'numbers has not been reviewed by anyone.',
    );
  }

  prompts.note(report.sql.trimEnd(), report.name ? `SQL for ${report.name}` : 'SQL');

  if (report.executed) {
    prompts.note(table(report.rows), report.truncated ? 'Rows (truncated)' : 'Rows');
  }

  prompts.note(report.nextSteps.map((step, i) => `${i + 1}. ${step}`).join('\n'), 'Next');

  const unreviewed = report.reviewed ? '' : pc.yellow(' (unreviewed)');
  prompts.outro(
    report.executed ? `${count(report.rowCount, 'row')}${unreviewed}.` : pc.dim('Nothing ran.'),
  );
}

/** An aligned table, so a column of numbers can be scanned by eye. */
function table(rows: QueryRow[]): string {
  if (rows.length === 0) return pc.dim('(no rows)');

  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const cells = rows.map((row) => columns.map((column) => format(row[column])));
  const widths = columns.map((column, i) =>
    Math.max(column.length, ...cells.map((row) => (row[i] as string).length)),
  );

  const pad = (value: string, i: number) => value.padEnd(widths[i] as number);
  return [pc.dim(columns.map(pad).join('  ')), ...cells.map((row) => row.map(pad).join('  '))].join(
    '\n',
  );
}

const MIDNIGHT_UTC = /^(\d{4}-\d{2}-\d{2})T00:00:00\.000Z$/;

function format(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  // A month or day truncation arrives as a timestamp at midnight. The time half
  // of it is noise in a table someone is reading.
  const text = String(value);
  return text.replace(MIDNIGHT_UTC, '$1');
}
