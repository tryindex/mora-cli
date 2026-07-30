import * as prompts from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import { ExitCode } from '../errors.js';
import {
  definitionCount,
  describeProject,
  type FieldDescription,
  filterVocabulary,
  type SourceDescription,
  type Vocabulary,
} from '../malloy/describe.js';
import { openProject } from '../project.js';
import { count } from './validate.js';

interface DescribeFlags {
  json?: boolean;
}

export interface DescribeReport extends Vocabulary {
  ok: boolean;
  command: 'describe';
  root: string;
  project: {
    name: string;
    models: string;
  };
  /** The filter that was applied, or null when everything is listed. */
  pattern: string | null;
  summary: {
    sources: number;
    dimensions: number;
    measures: number;
    views: number;
    queries: number;
  };
}

export function registerDescribeCommand(program: Command): void {
  program
    .command('describe')
    .description('List the sources, dimensions, measures and views in the semantic layer')
    .argument('[pattern]', 'only show definitions whose name contains this text')
    .option('-C, --directory <dir>', 'project directory', '.')
    .option('--json', 'print a machine-readable result instead of prose')
    .addHelpText(
      'after',
      `
Agent usage:
  Run this before writing a query, so an answer reuses a reviewed definition
  instead of inventing one. Exit codes: ${ExitCode.ok} success, ${ExitCode.failure} the project could
  not be read, ${ExitCode.usage} bad usage.

Examples:
  $ mora describe
  $ mora describe revenue
  $ mora describe --json`,
    )
    .action(async (pattern: string | undefined, flags: DescribeFlags & { directory: string }) => {
      const report = await runDescribe(flags.directory, pattern, flags);
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
      if (!report.ok) {
        process.exitCode = ExitCode.failure;
      }
    });
}

export async function runDescribe(
  directory: string,
  pattern: string | undefined,
  flags: DescribeFlags = {},
): Promise<DescribeReport> {
  const prose = !flags.json;
  const { config, connection, modelPaths } = await openProject(directory);

  if (prose) {
    prompts.intro(pc.bgCyan(pc.black(' mora describe ')));
  }

  const all = await describeProject({
    root: config.root,
    modelPaths,
    connectionName: connection.name,
    workingDirectory: connection.workingDirectory,
    database: connection.database,
  });

  const vocabulary = pattern ? filterVocabulary(all, pattern) : all;

  const report: DescribeReport = {
    // A model that does not compile cannot be described, and an agent that
    // trusts a partial vocabulary will write queries against definitions that
    // are not really there.
    ok: vocabulary.failures.length === 0,
    command: 'describe',
    root: config.root,
    project: { name: config.projectName, models: config.modelsDir },
    pattern: pattern ?? null,
    ...vocabulary,
    summary: summarize(vocabulary),
  };

  if (prose) {
    reportProse(report);
  }

  return report;
}

function summarize(vocabulary: Vocabulary): DescribeReport['summary'] {
  const total = (pick: (source: SourceDescription) => FieldDescription[]) =>
    vocabulary.sources.reduce((sum, source) => sum + pick(source).length, 0);

  return {
    sources: vocabulary.sources.length,
    dimensions: total((source) => source.dimensions),
    measures: total((source) => source.measures),
    views: total((source) => source.views),
    queries: vocabulary.queries.length,
  };
}

function reportProse(report: DescribeReport): void {
  for (const failure of report.failures) {
    prompts.log.error(`${failure.model} did not compile, so its definitions are missing.`);
  }

  if (report.sources.length === 0 && report.queries.length === 0) {
    prompts.outro(
      pc.yellow(
        report.pattern
          ? `Nothing matches "${report.pattern}".`
          : `No definitions found in ${report.project.models}/.`,
      ),
    );
    return;
  }

  for (const source of report.sources) {
    prompts.note(sourceLines(source).join('\n'), `${source.name}  ${pc.dim(source.model)}`);
  }

  if (report.queries.length > 0) {
    prompts.note(
      report.queries
        .map((query) => `${pc.cyan(query.name)}  ${pc.dim(`mora query ${query.name}`)}`)
        .join('\n'),
      'Named queries',
    );
  }

  const { summary } = report;
  prompts.outro(
    `${count(summary.sources, 'source')}, ${count(summary.measures, 'measure')}, ` +
      `${count(summary.dimensions, 'dimension')}, ${count(summary.views, 'view')}, ` +
      `${count(summary.queries, 'named query', 'named queries')}.`,
  );
}

function sourceLines(source: SourceDescription): string[] {
  if (definitionCount(source) === 0) return [pc.dim('  (no fields)')];

  // Measures first: they are what a question is usually asking for, and the
  // list of dimensions is long enough to bury them otherwise.
  return [
    ...group('measures', source.measures),
    ...group('dimensions', source.dimensions),
    ...group('views', source.views),
    ...group('joins', source.joins),
  ];
}

function group(label: string, fields: FieldDescription[]): string[] {
  if (fields.length === 0) return [];
  return [
    pc.dim(label),
    ...fields.map((field) => `  ${field.name}${field.type ? pc.dim(`  ${field.type}`) : ''}`),
  ];
}
