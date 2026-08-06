import path from 'node:path';
import * as prompts from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import { type LocalCache, openLocalCache, requireCache } from '../cache.js';
import { loadConfig, type MoraConfig, supportedConnections } from '../config.js';
import { ExitCode } from '../errors.js';
import { compileProject, type ModelCompileResult } from '../malloy/compile.js';
import { requireConnection, requireModels } from '../project.js';

interface ValidateFlags {
  local?: boolean;
  json?: boolean;
}

export interface CompileSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface ProjectValidation {
  /** The connection a model naming none was compiled against. */
  connection: string;
  /** Every connection the models could read from, by name. */
  connections: string[];
  /**
   * True when the models were compiled against the local cache rather than the
   * warehouse. A pass then means the columns exist in the copy, which is a
   * weaker promise: a column added upstream since the last sync is not there,
   * and one dropped upstream still is.
   */
  local: boolean;
  models: ModelCompileResult[];
  summary: CompileSummary;
}

export interface ValidateReport extends ProjectValidation {
  ok: boolean;
  command: 'validate';
  root: string;
  project: {
    name: string;
    models: string;
  };
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Compile every Malloy model in the project')
    .argument('[directory]', 'project directory', '.')
    .option('--local', 'compile against the local cache instead of the warehouse')
    .option('--json', 'print a machine-readable result instead of prose')
    .addHelpText(
      'after',
      `
What a pass means:
  Malloy resolves table schemas while it compiles, so a pass means the model
  parses and the columns it names really exist. That is the point of the check.

  --local compiles against what \`mora sync\` copied, which is fast enough to run
  on every edit but is a weaker promise: it proves the columns exist in the copy.
  A column added upstream since the sync is not there, and one dropped upstream
  still is. Run it without --local before opening a pull request.

Agent usage:
  Exit codes: ${ExitCode.ok} every model compiles, ${ExitCode.failure} at least one failed
  or the project could not be read, ${ExitCode.usage} bad usage.

Examples:
  $ mora validate
  $ mora validate --local
  $ mora validate ./analytics --json`,
    )
    .action(async (directory: string, flags: ValidateFlags) => {
      const report = await runValidate(directory, flags);
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
      if (!report.ok) {
        process.exitCode = ExitCode.failure;
      }
    });
}

export async function runValidate(
  directory: string,
  flags: ValidateFlags = {},
): Promise<ValidateReport> {
  const prose = !flags.json;
  const root = path.resolve(process.cwd(), directory);
  const config = await loadConfig(root);

  if (prose) {
    prompts.intro(pc.bgCyan(pc.black(' mora validate ')));
  }

  const validation = await validateProject(config, { prose, local: flags.local });

  const report: ValidateReport = {
    ok: validation.summary.failed === 0,
    command: 'validate',
    root: config.root,
    project: { name: config.projectName, models: config.modelsDir },
    ...validation,
  };

  if (prose) {
    reportProse(report);
  }

  return report;
}

export interface ValidateProjectOptions {
  prose?: boolean;
  /** Compile against the local cache rather than opening the warehouse. */
  local?: boolean;
  /**
   * Report every model as skipped instead of compiling, for a caller that
   * already knows the attempt cannot succeed. `mora init` uses this when a
   * credential is unset: it has just told the reader which one, and a compile
   * error about the same thing adds nothing.
   */
  skipReason?: string;
}

/**
 * Compiles every model in a loaded project. Shared with `mora init`, which runs
 * the same check when it joins a project someone else set up.
 */
export async function validateProject(
  config: MoraConfig,
  options: ValidateProjectOptions = {},
): Promise<ProjectValidation> {
  const defaultConnection = requireConnection(config);
  const connections = supportedConnections(config);
  const modelPaths = await requireModels(config);

  const names = connections.map((connection) => connection.name);

  if (options.skipReason) {
    return {
      connection: defaultConnection.name,
      connections: names,
      local: false,
      models: modelPaths.map((path) => ({
        path,
        status: 'skipped' as const,
        reason: options.skipReason,
      })),
      summary: summarize(modelPaths.map(() => ({ path: '', status: 'skipped' as const }))),
    };
  }

  if (options.local) requireCache(config);

  const spinner = options.prose && process.stdout.isTTY ? prompts.spinner() : undefined;
  spinner?.start(`Compiling ${count(modelPaths.length, 'model')}`);

  let cache: LocalCache | null = null;
  let models: ModelCompileResult[];
  try {
    cache = options.local ? await openLocalCache(config) : null;
    models = await compileProject({
      root: config.root,
      modelPaths,
      declaredConnections: config.connections,
      connections,
      openedConnections: cache?.connections,
      defaultConnectionName: defaultConnection.name,
    });
  } catch (error) {
    // A connection that cannot be opened at all, such as one missing a
    // credential. That is one problem with the project, not one per model.
    spinner?.stop('Could not open the project connections');
    throw error;
  } finally {
    await cache?.close().catch(() => undefined);
  }

  const summary = summarize(models);
  spinner?.stop(
    summary.failed > 0
      ? `${count(summary.failed, 'model')} failed to compile`
      : `Compiled ${count(summary.passed, 'model')}`,
  );

  return {
    connection: defaultConnection.name,
    connections: connections.map((connection) => connection.name),
    local: Boolean(options.local),
    models,
    summary,
  };
}

export function summarize(models: ModelCompileResult[]): CompileSummary {
  return {
    total: models.length,
    passed: models.filter((model) => model.status === 'passed').length,
    failed: models.filter((model) => model.status === 'failed').length,
    skipped: models.filter((model) => model.status === 'skipped').length,
  };
}

function reportProse(report: ValidateReport): void {
  printModelResults(report.models, report.project.models);

  if (report.models.length === 0) {
    prompts.outro(pc.yellow('No models found.'));
    return;
  }

  if (report.local) {
    prompts.log.warn(
      pc.yellow('Against the cache: ') +
        'this proves the columns exist in the local copy, not in the\n' +
        'warehouse. Run `mora validate` without --local before opening a pull request.',
    );
  }

  const { passed, failed } = report.summary;
  const against = report.local
    ? pc.yellow('the local cache')
    : report.connections.map((name) => pc.cyan(name)).join(', ') || pc.cyan(report.connection);
  prompts.outro(
    report.ok
      ? `${count(passed, 'model')} compiled against ${against}.`
      : pc.red(`${count(failed, 'model')} failed to compile.`),
  );
}

/** Shared with `mora init`, so a compile result reads the same in both commands. */
export function printModelResults(models: ModelCompileResult[], modelsDir: string): void {
  if (models.length === 0) {
    prompts.log.warn(`No .malloy files found in ${modelsDir}/. There is nothing to validate yet.`);
    return;
  }

  const lines = models.map((model) => `${statusLabel(model)} ${model.path}${detail(model)}`);
  prompts.note(lines.join('\n'), 'Models');

  for (const model of models) {
    if (model.status === 'failed') {
      prompts.log.error(`${model.path}\n${model.error ?? 'unknown error'}`);
    } else if (model.status === 'skipped' && model.reason) {
      prompts.log.warn(`${model.path}: ${model.reason}`);
    }
  }
}

function statusLabel(model: ModelCompileResult): string {
  switch (model.status) {
    case 'passed':
      return pc.green('  pass');
    case 'failed':
      return pc.red('  fail');
    case 'skipped':
      return pc.dim('  skip');
  }
}

function detail(model: ModelCompileResult): string {
  if (model.status !== 'passed') return '';
  const sources = model.sources?.length ?? 0;
  const queries = model.queries?.length ?? 0;
  return pc.dim(`  ${count(sources, 'source')}, ${count(queries, 'named query', 'named queries')}`);
}

export function count(n: number, noun: string, plural?: string): string {
  if (n === 1) return `${n} ${noun}`;
  return `${n} ${plural ?? `${noun}s`}`;
}
