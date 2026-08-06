import * as prompts from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import {
  CACHE_DIR,
  type CachedSummary,
  cacheExists,
  type SyncedTableOutcome,
  summarizeCache,
  syncCache,
} from '../cache.js';
import { loadConfig, type MoraConfig } from '../config.js';
import { ExitCode, MoraError } from '../errors.js';
import { count } from './validate.js';

/**
 * Rows per table to stop at. Large enough that a probe over it answers the
 * shape questions honestly, small enough that a wide fact table does not fill
 * a laptop. A table that hits it is marked capped everywhere it is reported.
 */
const DEFAULT_LIMIT = 100_000;

interface SyncFlags {
  directory: string;
  connection?: string;
  table?: string[];
  limit?: string;
  status?: boolean;
  json?: boolean;
}

export interface SyncReport {
  ok: boolean;
  command: 'sync';
  root: string;
  /** Cache directory, relative to the project root. */
  cacheDir: string;
  /** False under --status, where the cache was read but nothing was pulled. */
  executed: boolean;
  /** Models the table list was derived from. */
  models: string[];
  /** Models that did not compile, so tables only they name were not cached. */
  modelFailures: { model: string; error: string }[];
  /** What this run pulled. Empty under --status. */
  synced: SyncedTableOutcome[];
  /** Everything the cache holds afterwards. */
  cached: CachedSummary[];
  /** Oldest table in the cache, as an ISO instant, or null when it is empty. */
  syncedAt: string | null;
  /** How stale the oldest table is, in words, or null. */
  age: string | null;
  rows: number;
  limit: number;
  nextSteps: string[];
}

export function registerSyncCommand(program: Command): void {
  program
    .command('sync')
    .description('Copy the tables the models read into a local cache for fast, free probing')
    .option('-c, --connection <name>', 'only sync this connection (default: all of them)')
    .option('-t, --table <path>', 'also cache a table no model reads yet', collect)
    .option('-l, --limit <n>', `rows per table to stop at (default: ${DEFAULT_LIMIT})`)
    .option('--status', 'report what the cache holds without syncing anything')
    .option('-C, --directory <dir>', 'project directory', '.')
    .option('--json', 'print a machine-readable result instead of prose')
    .addHelpText(
      'after',
      `
What this is for:
  Probing the data is the expensive half of modelling: checking a join is really
  one-to-one, or what fraction of a column is null, takes many queries and none
  of the answers go in a dashboard. Syncing copies those tables into local
  Parquet so the checks cost nothing and hit no warehouse bill.

  The copy is a copy. It is as old as the last sync and it stops at --limit
  rows, so a count over a capped table is not the real count. Every result that
  reads it says so.

Agent usage:
  After this, \`mora query -f probe.malloy\` reads the cache automatically when it
  can, and falls back to the warehouse when a table is not cached. A named
  definition always reads the warehouse unless you pass --local. Exit codes:
  ${ExitCode.ok} every table synced, ${ExitCode.failure} at least one failed, ${ExitCode.usage} bad usage.

Examples:
  $ mora sync
  $ mora sync --status --json
  $ mora sync --limit 5000
  $ mora sync --table analytics.orders --table analytics.customers
  $ mora sync --connection warehouse`,
    )
    .action(async (flags: SyncFlags) => {
      const report = await runSync(flags.directory, flags);
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
      if (!report.ok) {
        process.exitCode = ExitCode.failure;
      }
    });
}

/** Repeatable `--table`, without a default that would print as `(default: [])`. */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export async function runSync(
  directory: string,
  flags: Omit<SyncFlags, 'directory'> = {},
): Promise<SyncReport> {
  const prose = !flags.json;
  const limit = parseLimit(flags.limit);
  const config = await loadConfig(directory);

  if (prose) {
    prompts.intro(pc.bgCyan(pc.black(' mora sync ')));
  }

  if (flags.status) {
    const report = await statusReport(config, limit);
    if (prose) reportProse(report);
    return report;
  }

  const spinner = prose && process.stdout.isTTY ? prompts.spinner() : undefined;
  spinner?.start('Reading the models');

  let outcome: Awaited<ReturnType<typeof syncCache>>;
  try {
    outcome = await syncCache({
      config,
      tables: flags.table,
      connectionName: flags.connection,
      limit,
      onProgress: (message) => spinner?.message(message),
    });
  } catch (error) {
    spinner?.error('Sync failed');
    throw error;
  }

  const failed = outcome.tables.filter((table) => table.status === 'failed');
  spinner?.stop(
    failed.length > 0
      ? `${count(failed.length, 'table')} failed`
      : `Cached ${count(outcome.tables.length, 'table')}`,
  );

  const cached = await summarizeCache(config);
  const report: SyncReport = {
    ok: failed.length === 0,
    command: 'sync',
    root: config.root,
    cacheDir: CACHE_DIR,
    executed: true,
    models: outcome.models,
    modelFailures: outcome.modelFailures,
    synced: outcome.tables,
    cached,
    syncedAt: outcome.syncedAt,
    age: cached[0]?.age ?? null,
    rows: outcome.rows,
    limit,
    nextSteps: nextSteps(outcome.tables, outcome.modelFailures, cached),
  };

  if (prose) reportProse(report);
  return report;
}

async function statusReport(config: MoraConfig, limit: number): Promise<SyncReport> {
  const cached = await summarizeCache(config);
  const oldest = cached.reduce<CachedSummary | null>(
    (worst, table) => (!worst || table.syncedAt < worst.syncedAt ? table : worst),
    null,
  );

  return {
    ok: true,
    command: 'sync',
    root: config.root,
    cacheDir: CACHE_DIR,
    executed: false,
    models: [],
    modelFailures: [],
    synced: [],
    cached,
    syncedAt: oldest?.syncedAt ?? null,
    age: oldest?.age ?? null,
    rows: cached.reduce((total, table) => total + table.rows, 0),
    limit,
    nextSteps: cacheExists(config)
      ? [
          'Run `mora sync` again to refresh these tables against the warehouse.',
          'Probes read this automatically: `mora query -f probe.malloy`.',
        ]
      : ['Nothing is cached yet. Run `mora sync` to copy the tables the models read.'],
  };
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new MoraError(`--limit must be a positive whole number, not "${value}".`, {
      code: 'invalid-limit',
      exitCode: ExitCode.usage,
      hint: 'Pass a row count, such as `--limit 5000`. Leave it off for the default.',
    });
  }
  return limit;
}

function nextSteps(
  synced: SyncedTableOutcome[],
  modelFailures: { model: string; error: string }[],
  cached: CachedSummary[],
): string[] {
  const steps: string[] = [];

  const failed = synced.filter((table) => table.status === 'failed');
  if (failed.length > 0) {
    steps.push(
      `Could not read ${failed.map((table) => table.table).join(', ')}. Run \`mora schema\` to check the names, and \`mora connection test\` to check access.`,
    );
  }

  for (const failure of modelFailures) {
    steps.push(
      `${failure.model} did not compile, so any table only it reads was not cached. Run \`mora validate\`.`,
    );
  }

  if (synced.length === 0 && failed.length === 0 && modelFailures.length === 0) {
    steps.push(
      'No models reference a table yet, so there was nothing to cache. Write a source in the models directory, or name a table with --table.',
    );
    return steps;
  }

  const capped = cached.filter((table) => table.capped);
  if (capped.length > 0) {
    steps.push(
      `${capped.map((table) => table.table).join(', ')} stopped at the row limit. Counts and fractions over ${capped.length === 1 ? 'it' : 'them'} are not the warehouse's answer; raise --limit or check those against the warehouse with --remote.`,
    );
  }

  const unreachable = cached.filter((table) => table.pathNote !== null);
  if (unreachable.length > 0) {
    steps.push(
      `${unreachable.map((table) => table.table).join(', ')} could not be reproduced under the same path locally, so --local will not resolve ${unreachable.length === 1 ? 'it' : 'them'}. The rows are cached; the path is the problem.`,
    );
  }

  steps.push(
    'Probe the cache for free: `mora query -f probe.malloy`. It reads the cache when it can and the warehouse when it cannot, and says which.',
  );
  steps.push(
    'The cache is a copy, as old as this sync. Check a number against the warehouse with --remote before it goes in a definition.',
  );
  return steps;
}

function reportProse(report: SyncReport): void {
  for (const failure of report.modelFailures) {
    prompts.log.warn(`${failure.model} did not compile.\n${failure.error}`);
  }

  for (const table of report.synced) {
    if (table.status === 'failed') {
      prompts.log.error(`${table.table} could not be read.\n${table.error ?? 'unknown error'}`);
    } else if (table.skippedColumns.length > 0) {
      prompts.log.warn(
        `${table.table}: dropped ${table.skippedColumns.join(', ')}. The cache cannot store ${table.skippedColumns.length === 1 ? 'that column' : 'those columns'} faithfully, so ${table.skippedColumns.length === 1 ? 'it is' : 'they are'} not there to read.`,
      );
    }
  }

  if (report.cached.length === 0) {
    prompts.log.warn('The cache is empty.');
  } else {
    prompts.note(cachedLines(report.cached).join('\n'), `Cached in ${report.cacheDir}/`);
  }

  prompts.note(report.nextSteps.map((step, index) => `${index + 1}. ${step}`).join('\n'), 'Next');

  if (!report.executed) {
    prompts.outro(
      report.cached.length === 0
        ? pc.dim('Nothing cached.')
        : `${count(report.cached.length, 'table')}, oldest ${report.age}.`,
    );
    return;
  }

  const failed = report.synced.filter((table) => table.status === 'failed').length;
  prompts.outro(
    report.ok
      ? `${count(report.synced.length, 'table')}, ${count(report.rows, 'row')}.`
      : pc.red(`${count(failed, 'table')} failed.`),
  );
}

function cachedLines(cached: CachedSummary[]): string[] {
  const width = Math.max(...cached.map((table) => table.table.length));
  return cached.map((table) => {
    const rows = table.capped ? pc.yellow(`${table.rows} rows (capped)`) : `${table.rows} rows`;
    return `  ${pc.cyan(table.table.padEnd(width))}  ${rows}  ${pc.dim(table.age)}`;
  });
}
