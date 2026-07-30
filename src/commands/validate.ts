import path from 'node:path';
import * as prompts from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, type MoraConfig } from '../config.js';
import { ExitCode } from '../errors.js';
import { compileProject, type ModelCompileResult } from '../malloy/compile.js';
import { requireDuckDbConnection, requireModels } from '../project.js';

interface ValidateFlags {
  json?: boolean;
}

export interface CompileSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface ProjectValidation {
  /** Name of the connection the models were compiled against. */
  connection: string;
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
    .option('--json', 'print a machine-readable result instead of prose')
    .addHelpText(
      'after',
      `
Agent usage:
  Exit codes: ${ExitCode.ok} every model compiles, ${ExitCode.failure} at least one failed
  or the project could not be read, ${ExitCode.usage} bad usage.

Examples:
  $ mora validate
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

  const validation = await validateProject(config, { prose });

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

/**
 * Compiles every model in a loaded project. Shared with `mora init`, which runs
 * the same check when it joins a project someone else set up.
 */
export async function validateProject(
  config: MoraConfig,
  options: { prose?: boolean } = {},
): Promise<ProjectValidation> {
  const connection = requireDuckDbConnection(config);
  const modelPaths = await requireModels(config);

  const spinner = options.prose && process.stdout.isTTY ? prompts.spinner() : undefined;
  spinner?.start(`Compiling ${count(modelPaths.length, 'model')}`);

  const models = await compileProject({
    root: config.root,
    modelPaths,
    connections: config.connections,
    connectionName: connection.name,
    workingDirectory: connection.workingDirectory,
    database: connection.database,
  });

  const summary = summarize(models);
  spinner?.stop(
    summary.failed > 0
      ? `${count(summary.failed, 'model')} failed to compile`
      : `Compiled ${count(summary.passed, 'model')}`,
  );

  return { connection: connection.name, models, summary };
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

  const { passed, failed } = report.summary;
  prompts.outro(
    report.ok
      ? `${count(passed, 'model')} compiled against ${pc.cyan(report.connection)}.`
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
