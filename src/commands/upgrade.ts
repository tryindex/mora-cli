import { existsSync } from 'node:fs';
import path from 'node:path';
import * as prompts from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import { isDuckDbConnection, loadConfig, type MoraConfig } from '../config.js';
import { ExitCode, MoraError } from '../errors.js';
import { pendingMigrations, upgradeConfigFile } from '../migrate.js';
import { pluginAgentsNotes } from '../plugins/registry.js';
import {
  AGENT_DOCS_DIR,
  AGENTS_FILENAME,
  buildAgentDocs,
  CONFIG_FILENAME,
  DUCKDB_CONNECTION_NAME,
  EXAMPLE_MODEL_FILENAME,
  SAMPLE_DATA_DIR,
  type WrittenFile,
  writeScaffold,
} from '../scaffold.js';
import { renderAgentsDoc } from '../templates/agents-doc.js';
import { CLI_VERSION, compareSemver, PACKAGE_NAME } from '../version.js';

export interface UpgradeFlags {
  directory?: string;
  check?: boolean;
  yes?: boolean;
  json?: boolean;
}

export type UpgradeStatus = 'up-to-date' | 'pending' | 'cli-behind';

export interface UpgradeReport {
  ok: boolean;
  command: 'upgrade';
  root: string;
  check: boolean;
  status: UpgradeStatus;
  fromVersion: string | null;
  toVersion: string;
  configVersion: { from: number; to: number };
  migrations: string[];
  files: WrittenFile[];
  nextSteps: string[];
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description('Bring a project up to date with this version of Mora')
    .argument('[directory]', 'project directory', '.')
    .option('--check', 'report whether an upgrade is pending without writing')
    .option('-y, --yes', 'run without prompting (implied by --json)')
    .option('--json', 'print a machine-readable result instead of prose')
    .addHelpText(
      'after',
      `
Upgrade refreshes the docs Mora owns (.agents/ and the managed block in
AGENTS.md), applies any mora.yaml migrations, and stamps the running CLI
version into ${CONFIG_FILENAME}. Commit the result like any other change to the
semantic layer.

A project whose ${CONFIG_FILENAME} was written by a newer Mora refuses to
downgrade: update the binary first with \`npm i -g ${PACKAGE_NAME}@latest\`.

Agent usage:
  Pass --json to run without prompts. Exit codes: ${ExitCode.ok} up to date or
  upgraded, ${ExitCode.failure} upgrade pending (--check) or refused, ${ExitCode.usage} bad usage.

Examples:
  $ mora upgrade
  $ mora upgrade --check --json
  $ mora upgrade ./analytics --yes`,
    )
    .action(async (directory: string, flags: UpgradeFlags) => {
      const report = await runUpgrade(directory, flags);
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
      if (!report.ok) {
        process.exitCode = ExitCode.failure;
      }
    });
}

export async function runUpgrade(
  directory: string,
  flags: UpgradeFlags = {},
): Promise<UpgradeReport> {
  const prose = !flags.json;
  const root = path.resolve(process.cwd(), directory);
  const config = await loadConfig(root);
  const status = assessUpgrade(config);

  if (flags.check) {
    const report = checkReport(config, status);
    if (prose) reportCheck(report);
    return report;
  }

  if (status === 'cli-behind') {
    throw cliBehindError(config.cliVersion ?? 'unknown');
  }

  if (prose) {
    prompts.intro(pc.bgCyan(pc.black(' mora upgrade ')));
  }

  const files: WrittenFile[] = [];
  files.push(...(await refreshOwnedDocs(config)));
  files.push(...(await refreshAgentsManagedBlock(config)));

  const configUpgrade = await upgradeConfigFile(config.root, CLI_VERSION);
  if (configUpgrade.changed) {
    files.push({ path: CONFIG_FILENAME, action: 'updated' });
  }

  const changed = files.filter((file) => file.action !== 'unchanged');
  const report: UpgradeReport = {
    ok: true,
    command: 'upgrade',
    root: config.root,
    check: false,
    // After a successful run the project matches this CLI.
    status: 'up-to-date',
    fromVersion: config.cliVersion ?? null,
    toVersion: CLI_VERSION,
    configVersion: { from: configUpgrade.fromVersion, to: configUpgrade.toVersion },
    migrations: configUpgrade.applied,
    files: changed,
    nextSteps:
      changed.length > 0
        ? [
            'Review the diff, then commit it so the team upgrades together.',
            'Teammates on an older CLI should update with ' +
              `\`npm i -g ${PACKAGE_NAME}@latest\` before pulling.`,
          ]
        : ['Already current. Nothing to commit.'],
  };

  if (prose) {
    reportUpgrade(report);
  }

  return report;
}

export function assessUpgrade(config: MoraConfig): UpgradeStatus {
  const migrationsWaiting = pendingMigrations(config.version).length > 0;
  // A missing stamp means the project predates `mora upgrade`; treat it as pending.
  if (!config.cliVersion) return 'pending';
  const cmp = compareSemver(CLI_VERSION, config.cliVersion);
  if (cmp < 0) return 'cli-behind';
  if (cmp > 0 || migrationsWaiting) return 'pending';
  return 'up-to-date';
}

function checkReport(config: MoraConfig, status: UpgradeStatus): UpgradeReport {
  const migrations = pendingMigrations(config.version).map((migration) => migration.id);
  const nextSteps =
    status === 'up-to-date'
      ? ['Nothing to do. This project matches the running Mora.']
      : status === 'cli-behind'
        ? [
            `Update the CLI: \`npm i -g ${PACKAGE_NAME}@latest\`, then re-run \`mora upgrade --check\`.`,
          ]
        : ['Run `mora upgrade` to refresh Mora-owned files and stamp this version.'];

  return {
    ok: status === 'up-to-date',
    command: 'upgrade',
    root: config.root,
    check: true,
    status,
    fromVersion: config.cliVersion ?? null,
    toVersion: CLI_VERSION,
    configVersion: { from: config.version, to: config.version },
    migrations,
    files: [],
    nextSteps,
  };
}

function cliBehindError(projectVersion: string): MoraError {
  return new MoraError(
    `This project is at ${projectVersion}, but you are running Mora ${CLI_VERSION}.`,
    {
      code: 'cli-behind',
      exitCode: ExitCode.failure,
      hint: `Update with \`npm i -g ${PACKAGE_NAME}@latest\` (or \`npx ${PACKAGE_NAME}@latest upgrade\`), then try again.`,
    },
  );
}

async function refreshOwnedDocs(config: MoraConfig): Promise<WrittenFile[]> {
  return writeScaffold(
    config.root,
    buildAgentDocs({
      modelsDir: config.modelsDir,
      connectionName: config.connections.find(isDuckDbConnection)?.name ?? DUCKDB_CONNECTION_NAME,
    }),
  );
}

/**
 * Rewrites the part of AGENTS.md Mora owns from the project as it now stands.
 * Shared with `mora plugin`, so a plugin's layout note appears the moment it is
 * added rather than at the next upgrade.
 */
export async function refreshAgentsManagedBlock(config: MoraConfig): Promise<WrittenFile[]> {
  const exampleModelPath = `${config.modelsDir}/${EXAMPLE_MODEL_FILENAME}`;
  const hasExample = existsSync(path.join(config.root, exampleModelPath));
  const agentsDoc = renderAgentsDoc({
    projectName: config.projectName,
    modelsDir: config.modelsDir,
    dataDir: `${config.modelsDir}/${SAMPLE_DATA_DIR}`,
    exampleModelPath,
    hasExample,
    agentDocsDir: AGENT_DOCS_DIR,
    pluginNotes: pluginAgentsNotes(config.plugins, {
      root: config.root,
      projectName: config.projectName,
      modelsDir: config.modelsDir,
    }),
  });

  return writeScaffold(config.root, [
    {
      path: AGENTS_FILENAME,
      strategy: 'managed-block',
      contents: agentsDoc.managed,
      surround: { before: agentsDoc.title, after: agentsDoc.teamSection },
    },
  ]);
}

function reportCheck(report: UpgradeReport): void {
  prompts.intro(pc.bgCyan(pc.black(' mora upgrade --check ')));
  if (report.status === 'up-to-date') {
    prompts.log.success(`Project matches Mora ${pc.cyan(report.toVersion)}.`);
  } else if (report.status === 'cli-behind') {
    prompts.log.error(
      `Project is at ${pc.cyan(report.fromVersion ?? 'unknown')}; running Mora is ${pc.cyan(report.toVersion)}.`,
    );
  } else {
    prompts.log.warn(
      `Upgrade pending: project is at ${pc.cyan(report.fromVersion ?? '(no stamp)')}, ` +
        `running Mora is ${pc.cyan(report.toVersion)}.`,
    );
  }
  prompts.note(report.nextSteps.map((step, i) => `${i + 1}. ${step}`).join('\n'), 'Next');
  prompts.outro(
    report.ok
      ? 'Up to date.'
      : pc.yellow(report.status === 'cli-behind' ? 'CLI is behind.' : 'Upgrade pending.'),
  );
}

function reportUpgrade(report: UpgradeReport): void {
  if (report.files.length > 0) {
    prompts.note(
      report.files.map((file) => `${actionLabel(file.action)} ${file.path}`).join('\n'),
      'Files',
    );
  } else {
    prompts.log.info('No files needed changing.');
  }

  if (report.migrations.length > 0) {
    prompts.note(report.migrations.map((id) => `• ${id}`).join('\n'), 'Migrations');
  }

  prompts.log.message(
    `cli_version: ${report.fromVersion ?? '(none)'} → ${pc.cyan(report.toVersion)}`,
  );
  prompts.note(report.nextSteps.map((step, i) => `${i + 1}. ${step}`).join('\n'), 'Next');
  prompts.outro(`Project upgraded to Mora ${pc.cyan(report.toVersion)}.`);
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
