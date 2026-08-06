import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as prompts from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import { cacheExists, type LocalCache, openLocalCache, requireCache } from '../cache.js';
import type { MoraConfig } from '../config.js';
import { ExitCode, MoraError } from '../errors.js';
import { type QueryRow, runQuery } from '../malloy/query.js';
import { openProject } from '../project.js';
import { count } from './validate.js';

const DEFAULT_LIMIT = 50;

interface QueryFlags {
  directory: string;
  expr?: string;
  /** File holding Malloy to run, for a probe too long to quote in a shell. */
  file?: string;
  sql?: boolean;
  limit?: string;
  local?: boolean;
  remote?: boolean;
  json?: boolean;
}

/** `-e -` means "the document is on stdin", the way other CLIs spell it. */
const STDIN = '-';

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
  /**
   * True when the rows came from the local cache rather than the warehouse. A
   * local answer is as old as the last `mora sync` and may be over a capped
   * extract, so nothing may present it without saying this.
   */
  local: boolean;
  /** When the cache behind a local answer was last filled. Null for a warehouse answer. */
  syncedAt: string | null;
  /**
   * True when the cache was tried and could not answer, so the warehouse did.
   * The answer is the real one; this says the cache is missing something a
   * `mora sync` would cover.
   */
  fellBackToWarehouse: boolean;
  /**
   * Cached tables that stopped at the row limit, when the answer is local. A
   * count over one of these is not the warehouse's count. Listed for the whole
   * cache rather than for this query: over-warning is the safe direction.
   */
  cappedTables: string[];
  rows: QueryRow[];
  rowCount: number;
  truncated: boolean;
  nextSteps: string[];
}

export function registerQueryCommand(program: Command): void {
  program
    .command('query')
    .description('Run a definition from the semantic layer and print the rows and SQL')
    .argument('[name]', 'definition to run: a `query:` declaration, or a view as `source.view`')
    .option('-e, --expr <malloy>', 'run Malloy the model does not define ("-" reads stdin)')
    .option('-f, --file <path>', 'run Malloy from a file')
    .option('-C, --directory <dir>', 'project directory', '.')
    .option('--sql', 'print the generated SQL without running it')
    .option('-l, --limit <n>', `largest number of rows to return (default: ${DEFAULT_LIMIT})`)
    .option('--local', 'read the local cache, and fail rather than fall back to the warehouse')
    .option('--remote', 'read the warehouse, even for a probe that could have used the cache')
    .option('--json', 'print a machine-readable result instead of prose')
    .addHelpText(
      'after',
      `
Reviewed vs not:
  A name resolves to a definition someone committed and reviewed, and the result
  is marked reviewed. --expr and --file run Malloy that nobody has reviewed, and
  are marked reviewed: false. Explore with them, then promote anything worth
  keeping to a named view or query and run it by name.

Local vs warehouse:
  A probe (--expr or --file) reads the local cache when \`mora sync\` has filled
  it and the tables are there, and falls back to the warehouse when they are
  not. Probing is where the queries pile up and none of the answers ship, so
  the copy is worth its staleness there.

  A named definition always reads the warehouse. Those are the answers someone
  acts on, and a number that is three days old is worse than a number that took
  four seconds. Pass --local to override that, or --remote to force a probe onto
  the warehouse.

  Every result says which it was: \`local\` and \`syncedAt\` in the JSON.

Agent usage:
  Every result carries the SQL that produced it; report it alongside the answer,
  and report the age too whenever \`local\` is true. Exit codes: ${ExitCode.ok} the query
  ran, ${ExitCode.failure} it did not, ${ExitCode.usage} bad usage.

Examples:
  $ mora query monthly_revenue
  $ mora query orders.revenue_by_month --limit 12
  $ mora query -e "orders -> { aggregate: revenue }"
  $ mora query monthly_revenue --sql
  $ mora query monthly_revenue --local
  $ mora query -f probe.malloy --remote

  Unreviewed Malloy is a whole document, so it can declare a source of its own
  and read a table no model mentions yet. This is how to check the data before
  modelling it. A probe is usually several lines, so write it to a file rather
  than fighting shell quoting:
  $ mora query -f probe.malloy
  $ mora query -e - < probe.malloy

One query per document:
  Malloy runs only the last query in a document, so a document with several
  \`run:\` statements is refused rather than answered in part. Ask one question per
  document, or combine the checks into one \`run:\` with several aggregates.`,
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

  if (flags.expr !== undefined && flags.file !== undefined) {
    throw new MoraError('Pass either --expr or --file, not both.', {
      code: 'conflicting-query',
      exitCode: ExitCode.usage,
      hint: 'Both are unreviewed Malloy; only one document can run at a time.',
    });
  }

  const expr = await readExpr(flags);

  if (!name && expr === undefined) {
    throw new MoraError('Nothing to run.', {
      code: 'no-query',
      exitCode: ExitCode.usage,
      hint: 'Pass a definition name, or -e / -f with Malloy to run.',
    });
  }
  if (name && expr !== undefined) {
    throw new MoraError('Pass either a definition name or Malloy to run, not both.', {
      code: 'conflicting-query',
      exitCode: ExitCode.usage,
      hint: 'A name runs reviewed logic; -e and -f run logic that has not been reviewed.',
    });
  }

  const limit = parseLimit(flags.limit);
  const { config, connections, defaultConnection, modelPaths } = await openProject(directory);
  const plan = planWhere(config, flags, expr !== undefined);

  if (prose) {
    prompts.intro(pc.bgCyan(pc.black(' mora query ')));
  }

  const spinner = prose && process.stdout.isTTY ? prompts.spinner() : undefined;
  spinner?.start(flags.sql ? 'Compiling' : 'Running');

  const run = (cache: LocalCache | null) =>
    runQuery({
      root: config.root,
      modelPaths,
      connections,
      defaultConnectionName: defaultConnection.name,
      openedConnections: cache?.connections,
      name,
      expr,
      limit,
      sqlOnly: flags.sql,
    });

  let outcome: Awaited<ReturnType<typeof runQuery>>;
  let cache: LocalCache | null = null;
  let readLocally = false;
  let fellBack = false;

  try {
    if (plan.first === 'remote') {
      outcome = await run(null);
    } else {
      cache = await openLocalCache(config);
      try {
        outcome = await run(cache);
        readLocally = true;
      } catch (error) {
        // Anything the cache cannot answer is retried against the warehouse,
        // rather than only the failures that look like a missing table. A table
        // the cache lacks surfaces differently depending on the dialect — DuckDB
        // reports a missing file, a warehouse reports a missing relation — and
        // matching on the wording would break the fallback exactly where the
        // cache is thinnest. Nothing is hidden by being generous here: if the
        // warehouse fails too, its error is the one reported, and that is the
        // authoritative one. `--local` sets fallback false and gets the refusal.
        if (!plan.fallback) throw error;
        fellBack = true;
        outcome = await run(null);
      }
    }
  } catch (error) {
    spinner?.error('Query failed');
    throw error;
  } finally {
    await cache?.close().catch(() => undefined);
  }

  spinner?.stop(
    flags.sql
      ? 'Compiled'
      : `Ran ${count(outcome.rowCount, 'row')}${readLocally ? pc.dim(' from the cache') : ''}`,
  );

  const report: QueryReport = {
    ok: true,
    command: 'query',
    root: config.root,
    name: outcome.name,
    reviewed: outcome.reviewed,
    model: outcome.model,
    sql: outcome.sql,
    executed: !flags.sql,
    local: readLocally,
    syncedAt: readLocally ? (cache?.syncedAt ?? null) : null,
    fellBackToWarehouse: fellBack,
    cappedTables: readLocally ? (cache?.capped ?? []) : [],
    rows: outcome.rows,
    rowCount: outcome.rowCount,
    truncated: outcome.truncated,
    nextSteps: [],
  };
  report.nextSteps = nextSteps(report);

  if (prose) {
    reportProse(report);
  }

  return report;
}

interface WherePlan {
  first: 'local' | 'remote';
  /** Whether a table the cache does not hold may be answered by the warehouse. */
  fallback: boolean;
}

/**
 * Where to read from, and whether the other place may answer instead.
 *
 * The default splits on the distinction the tool already draws everywhere else.
 * A probe is unreviewed logic asking what is true of the data; it is where the
 * queries pile up while none of the answers ship, so a copy a few hours old
 * buys real speed and costs nothing that matters. A named definition is an
 * answer somebody acts on, and staleness there is exactly the quiet wrongness
 * this tool exists to prevent.
 */
function planWhere(
  config: MoraConfig,
  flags: Pick<QueryFlags, 'local' | 'remote'>,
  isProbe: boolean,
): WherePlan {
  if (flags.local && flags.remote) {
    throw new MoraError('Pass either --local or --remote, not both.', {
      code: 'conflicting-source',
      exitCode: ExitCode.usage,
      hint: '--local reads the cache and --remote reads the warehouse; they cannot both apply.',
    });
  }

  if (flags.local) {
    requireCache(config);
    return { first: 'local', fallback: false };
  }
  if (flags.remote) {
    return { first: 'remote', fallback: false };
  }

  return isProbe && cacheExists(config)
    ? { first: 'local', fallback: true }
    : { first: 'remote', fallback: false };
}

/**
 * The unreviewed Malloy to run, from wherever it was given. A probe that
 * declares its own source runs to several lines, and a shell argument is the
 * worst place to keep one: a file or a here-doc survives being edited, and an
 * agent can write it the same way it writes a model.
 */
async function readExpr(flags: Pick<QueryFlags, 'expr' | 'file'>): Promise<string | undefined> {
  if (flags.file !== undefined) {
    return readMalloyFile(flags.file);
  }
  if (flags.expr === STDIN) {
    return readStdin();
  }
  return flags.expr;
}

async function readMalloyFile(file: string): Promise<string> {
  const absolute = path.resolve(process.cwd(), file);
  const contents = await readFile(absolute, 'utf8').catch((error: unknown) => {
    throw new MoraError(`Cannot read ${file}: ${describeFileError(error)}`, {
      code: 'unreadable-expr',
      exitCode: ExitCode.usage,
      hint: 'Pass a path to a file holding the Malloy to run.',
    });
  });
  return assertNotEmpty(contents, `${file} is empty.`);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new MoraError('Nothing on stdin to run.', {
      code: 'unreadable-expr',
      exitCode: ExitCode.usage,
      hint: 'Redirect a file into it (`mora query -e - < probe.malloy`), or use -f.',
    });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return assertNotEmpty(Buffer.concat(chunks).toString('utf8'), 'Nothing on stdin to run.');
}

function assertNotEmpty(contents: string, message: string): string {
  if (contents.trim().length === 0) {
    throw new MoraError(message, {
      code: 'unreadable-expr',
      exitCode: ExitCode.usage,
      hint: 'It needs a `run:` statement, and a `source:` when the model has none.',
    });
  }
  return contents;
}

function describeFileError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new MoraError(`--limit must be a positive whole number, not "${value}".`, {
      code: 'invalid-limit',
      exitCode: ExitCode.usage,
      hint: 'Pass a row count, such as `--limit 20`. Leave it off for the default.',
    });
  }
  return limit;
}

function nextSteps(report: QueryReport): string[] {
  const steps: string[] = [];
  if (!report.reviewed) {
    steps.push(
      'This logic is not in the model, so nobody has reviewed it. If the answer is worth ' +
        'keeping, add it as a named view or query and run it by name.',
    );
  }
  if (report.local) {
    steps.push(
      'These rows came from the local cache, not the warehouse, so they are as old as the ' +
        'last `mora sync`. Re-run with --remote before treating any number here as current.',
    );
  }
  if (report.fellBackToWarehouse) {
    steps.push(
      'The local cache could not answer this, so the warehouse did. These rows are current. ' +
        'Run `mora sync` to cache what this reads, and the next probe over it is free.',
    );
  }
  if (report.cappedTables.length > 0) {
    steps.push(
      `The cache stopped at the row limit for ${report.cappedTables.join(', ')}. If this answer ` +
        'reads one of those, a count or a fraction over it is not the warehouse\u2019s answer. ' +
        'Check it with --remote, or raise `mora sync --limit`.',
    );
  }
  if (report.truncated) {
    steps.push('More rows matched than were returned. Raise --limit, or aggregate further.');
  }
  if (report.executed === false) {
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

  if (report.local) {
    prompts.log.warn(
      pc.yellow('From the cache: ') +
        `these rows are a local copy taken ${report.syncedAt ? age(report.syncedAt) : 'earlier'},\n` +
        'not the warehouse as it stands now. Re-run with --remote to check a number.',
    );
  }

  prompts.note(report.sql.trimEnd(), report.name ? `SQL for ${report.name}` : 'SQL');

  if (report.executed) {
    prompts.note(table(report.rows), report.truncated ? 'Rows (truncated)' : 'Rows');
  }

  prompts.note(report.nextSteps.map((step, i) => `${i + 1}. ${step}`).join('\n'), 'Next');

  const unreviewed = report.reviewed ? '' : pc.yellow(' (unreviewed)');
  const where = report.local ? pc.yellow(' from the cache') : '';
  prompts.outro(
    report.executed
      ? `${count(report.rowCount, 'row')}${where}${unreviewed}.`
      : pc.dim('Nothing ran.'),
  );
}

/** How long ago an instant was, in the same words `mora sync` uses. */
function age(syncedAt: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(syncedAt)) / 1000);
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${count(minutes, 'minute')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${count(hours, 'hour')} ago`;
  return `${count(Math.round(hours / 24), 'day')} ago`;
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
