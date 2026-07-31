import * as prompts from '@clack/prompts';
import type { Command } from 'commander';
import pc from 'picocolors';
import { loadConfig, type MoraConfig } from '../config.js';
import { ExitCode, MoraError } from '../errors.js';
import { forgetPlugin, recordPlugin } from '../plugins/config.js';
import {
  inspectPluginFiles,
  type PluginFileRemoval,
  removePluginFiles,
  stripGitignoreEntries,
} from '../plugins/files.js';
import { isPluginInstalled, uninstallPlugin } from '../plugins/loader.js';
import { BUILT_IN_PLUGINS, builtInPlugin } from '../plugins/registry.js';
import { resolvePlugin } from '../plugins/resolve.js';
import type { PluginContext, PluginSetup } from '../plugins/types.js';
import { CONFIG_FILENAME, type FileAction, writeScaffold } from '../scaffold.js';
import { refreshAgentsManagedBlock } from './upgrade.js';

interface AddFlags {
  directory: string;
  force?: boolean;
  yes?: boolean;
  json?: boolean;
}

interface RemoveFlags extends AddFlags {
  keepFiles?: boolean;
}

interface ListFlags {
  directory: string;
  json?: boolean;
}

/**
 * A file a plugin owns. `kept` is its own action because a project that already
 * had the plugin may have edited what it wrote, and reporting that as `unchanged`
 * would claim Mora agreed with the contents.
 */
export interface PluginWrittenFile {
  path: string;
  action: FileAction | 'kept';
}

export interface PluginIdentity {
  name: string;
  builtIn: boolean;
  package: string | null;
  version: string | null;
}

export interface PluginAddReport {
  ok: boolean;
  command: 'plugin add';
  root: string;
  plugin: PluginIdentity;
  files: PluginWrittenFile[];
  nextSteps: string[];
}

export interface PluginRemoveReport {
  ok: boolean;
  command: 'plugin remove';
  root: string;
  plugin: PluginIdentity;
  files: PluginFileRemoval[];
  nextSteps: string[];
}

export interface PluginSummary extends PluginIdentity {
  description: string | null;
  /** Recorded in mora.yaml, so it is part of the project. */
  added: boolean;
  /** Usable in this checkout right now, without installing anything. */
  installed: boolean;
}

export interface PluginListReport {
  ok: boolean;
  command: 'plugin list';
  root: string;
  plugins: PluginSummary[];
}

export function registerPluginCommand(program: Command): void {
  const plugin = program
    .command('plugin')
    .description('Add and remove the optional integrations a project uses')
    .addHelpText(
      'after',
      `
A plugin sets up one integration and nothing else: it writes files, records
itself in ${CONFIG_FILENAME}, and can be taken back out again.

Mora ships with ${BUILT_IN_PLUGINS.map((entry) => entry.name).join(', ')}. Anything else is an npm
package named mora-plugin-<name>, installed per checkout under .mora/plugins/,
which is why a fresh clone is told to run \`mora plugin add\` rather than having a
package fetched for it.

Examples:
  $ mora plugin list
  $ mora plugin add publisher
  $ mora plugin remove publisher`,
    );

  registerAdd(plugin);
  registerRemove(plugin);
  registerList(plugin);
}

function registerAdd(parent: Command): void {
  parent
    .command('add')
    .description('Set this project up for an integration and record it in mora.yaml')
    .argument('<name>', 'plugin name, e.g. publisher')
    .option('-C, --directory <dir>', 'project directory', '.')
    .option('-f, --force', 'overwrite files that have been edited since they were written')
    .option('-y, --yes', 'run without prompting (implied by --json)')
    .option('--json', 'print a machine-readable result instead of prose')
    .addHelpText(
      'after',
      `
Adding a plugin writes files the project then owns, so commit them like any
other change. Re-running add is safe: files that already match are left alone,
which is what a teammate runs in a fresh checkout to install a third-party
plugin's package.

Agent usage:
  Exit codes: ${ExitCode.ok} added, ${ExitCode.failure} the package could not be installed or loaded,
  ${ExitCode.usage} no such plugin, ${ExitCode.conflict} refused because files already exist.

Examples:
  $ mora plugin add publisher
  $ mora plugin add publisher --json
  $ mora plugin add forecast          # installs mora-plugin-forecast`,
    )
    .action(async (name: string, flags: AddFlags) => {
      const report = await runPluginAdd(flags.directory, name, flags);
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
      if (!report.ok) {
        process.exitCode = ExitCode.failure;
      }
    });
}

function registerRemove(parent: Command): void {
  parent
    .command('remove')
    .description('Take an integration back out: delete its files and unrecord it')
    .argument('<name>', 'plugin name, as recorded in mora.yaml')
    .option('-C, --directory <dir>', 'project directory', '.')
    .option('-f, --force', 'delete files even if they have been edited')
    .option('--keep-files', 'leave every file in place and only unrecord the plugin')
    .option('-y, --yes', 'run without prompting (implied by --json)')
    .option('--json', 'print a machine-readable result instead of prose')
    .addHelpText(
      'after',
      `
Remove deletes only the files the plugin would write today, so a file someone
has edited since is refused rather than thrown away. Use --force to delete it
anyway, or --keep-files to leave the files and only stop tracking the plugin.

Agent usage:
  Nothing is written when a file is refused, so a failed remove leaves the
  project exactly as it was. Exit codes: ${ExitCode.ok} removed, ${ExitCode.failure} the plugin could not
  be loaded, ${ExitCode.usage} the project does not use that plugin, ${ExitCode.conflict} refused because
  files have local edits.

Examples:
  $ mora plugin remove publisher
  $ mora plugin remove publisher --force --json
  $ mora plugin remove forecast --keep-files`,
    )
    .action(async (name: string, flags: RemoveFlags) => {
      const report = await runPluginRemove(flags.directory, name, flags);
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
    .description('Show which plugins this project uses and which ones Mora offers')
    .option('-C, --directory <dir>', 'project directory', '.')
    .option('--json', 'print a machine-readable result instead of prose')
    .addHelpText(
      'after',
      `
Agent usage:
  \`added\` means the project records the plugin in ${CONFIG_FILENAME}; \`installed\`
  means it is usable in this checkout. A plugin that is added but not installed
  needs \`mora plugin add <name>\` to fetch its package.

Examples:
  $ mora plugin list
  $ mora plugin list --json`,
    )
    .action(async (flags: ListFlags) => {
      const report = await runPluginList(flags.directory, flags);
      if (flags.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      }
    });
}

export async function runPluginAdd(
  directory: string,
  name: string,
  flags: Partial<AddFlags> = {},
): Promise<PluginAddReport> {
  const config = await loadConfig(directory);
  const prose = !flags.json;

  if (prose) {
    prompts.intro(pc.bgCyan(pc.black(' mora plugin add ')));
  }

  const spinner = prose && process.stdout.isTTY ? prompts.spinner() : undefined;
  spinner?.start(`Resolving ${name}`);
  const resolved = await resolvePlugin(config.root, name, { install: true }).catch((error) => {
    spinner?.error(`Could not resolve ${name}`);
    throw error;
  });
  spinner?.stop(
    resolved.builtIn ? `${resolved.plugin.name} ships with Mora` : `Installed ${resolved.package}`,
  );

  const setup = await resolved.plugin.setup(pluginContext(config));
  const alreadyAdded = config.plugins.some((entry) => entry.name === resolved.plugin.name);

  const inspected = await inspectPluginFiles(config.root, setup.files);
  const modified = inspected.filter((entry) => entry.state === 'modified');

  // A path that already holds something else is a conflict; the same path holding
  // an edited copy of what this plugin wrote is just a project that has moved on.
  if (modified.length > 0 && !flags.force && !alreadyAdded) {
    throw new MoraError(
      `Refusing to overwrite existing files: ${modified.map((entry) => entry.file.path).join(', ')}`,
      {
        code: 'files-exist',
        exitCode: ExitCode.conflict,
        hint: `Re-run with --force to overwrite, or remove those files first.`,
      },
    );
  }

  const keep = flags.force ? [] : modified.map((entry) => entry.file.path);
  const toWrite = setup.files.filter((file) => !keep.includes(file.path));

  const files: PluginWrittenFile[] = [
    ...(await writeScaffold(config.root, toWrite)).written,
    ...keep.map((path): PluginWrittenFile => ({ path, action: 'kept' })),
  ];

  if (setup.gitignore && setup.gitignore.length > 0) {
    files.push(
      ...(
        await writeScaffold(config.root, [
          {
            path: '.gitignore',
            strategy: 'merge-lines',
            contents: `${setup.gitignore.join('\n')}\n`,
          },
        ])
      ).written,
    );
  }

  if (!alreadyAdded) {
    await recordPlugin(config, {
      name: resolved.plugin.name,
      package: resolved.package,
      version: resolved.version,
    });
    files.push({ path: CONFIG_FILENAME, action: 'updated' });
  }

  // Re-read so the docs are rendered from the config as it now stands, the same
  // way `mora upgrade` will render them later.
  files.push(...(await refreshAgentsManagedBlock(await loadConfig(config.root))));

  const report: PluginAddReport = {
    ok: true,
    command: 'plugin add',
    root: config.root,
    plugin: identity(resolved.plugin.name, resolved.builtIn, resolved.package, resolved.version),
    files: files.filter((file) => file.action !== 'unchanged'),
    nextSteps: [
      ...(setup.nextSteps ?? []),
      `Run \`mora plugin remove ${resolved.plugin.name}\` to take it back out.`,
    ],
  };

  if (prose) {
    reportAdd(report, setup);
  }

  return report;
}

export async function runPluginRemove(
  directory: string,
  name: string,
  flags: Partial<RemoveFlags> = {},
): Promise<PluginRemoveReport> {
  const config = await loadConfig(directory);
  const prose = !flags.json;

  const entry = config.plugins.find((recorded) => recorded.name === name);
  if (!entry) {
    throw new MoraError(`This project does not use a plugin called "${name}".`, {
      code: 'plugin-not-added',
      exitCode: ExitCode.usage,
      hint:
        config.plugins.length > 0
          ? `It uses: ${config.plugins.map((recorded) => recorded.name).join(', ')}.`
          : `No plugins are recorded in ${CONFIG_FILENAME}. Run \`mora plugin list\` to see what Mora offers.`,
    });
  }

  if (prose) {
    prompts.intro(pc.bgCyan(pc.black(' mora plugin remove ')));
  }

  let setup: PluginSetup | undefined;
  try {
    const resolved = await resolvePlugin(config.root, name, { install: !flags.keepFiles });
    setup = await resolved.plugin.setup(pluginContext(config));
  } catch (error) {
    // With --keep-files there is nothing to compute: no file is touched either
    // way, so a plugin whose package has gone missing can still be unrecorded.
    if (!flags.keepFiles) throw error;
  }

  if (setup && !flags.force && !flags.keepFiles) {
    const inspected = await inspectPluginFiles(config.root, setup.files);
    const modified = inspected.filter((file) => file.state === 'modified');
    if (modified.length > 0) {
      // Refused before anything is written, so a project is never left half
      // removed: either the plugin goes cleanly or it stays as it was.
      throw new MoraError(
        `These files have changed since ${name} wrote them: ${modified
          .map((file) => file.file.path)
          .join(', ')}`,
        {
          code: 'files-modified',
          exitCode: ExitCode.conflict,
          hint: `Re-run with --force to delete them anyway, or --keep-files to unrecord ${name} and keep them.`,
        },
      );
    }
  }

  if (prose && !flags.yes && (await declined(setup, flags))) {
    prompts.cancel('Cancelled. Nothing was removed.');
    process.exit(ExitCode.ok);
  }

  const files = setup
    ? await removePluginFiles(config.root, setup.files, {
        force: flags.force === true,
        keepFiles: flags.keepFiles === true,
      })
    : [];

  if (setup?.gitignore && !flags.keepFiles) {
    await stripGitignoreEntries(config.root, setup.gitignore);
  }

  await forgetPlugin(config, name);
  const reloaded = await loadConfig(config.root);
  await refreshAgentsManagedBlock(reloaded);

  if (entry.package) {
    await uninstallPlugin(config.root, entry.package);
  }

  const report: PluginRemoveReport = {
    ok: true,
    command: 'plugin remove',
    root: config.root,
    plugin: identity(name, builtInPlugin(name) !== undefined, entry.package, entry.version),
    files,
    nextSteps: [
      `Review the diff and commit it, so the team stops using ${name} together.`,
      ...(files.some((file) => file.action === 'kept-by-flag')
        ? [`Its files were left in place. Delete them by hand if they are no longer wanted.`]
        : []),
      `Run \`mora plugin add ${name}\` to set it up again.`,
    ],
  };

  if (prose) {
    reportRemove(report);
  }

  return report;
}

export async function runPluginList(
  directory: string,
  flags: { json?: boolean } = {},
): Promise<PluginListReport> {
  const config = await loadConfig(directory);

  const summaries: PluginSummary[] = BUILT_IN_PLUGINS.map((plugin) => ({
    ...identity(plugin.name, true, undefined, undefined),
    description: plugin.description,
    added: config.plugins.some((entry) => entry.name === plugin.name),
    installed: true,
  }));

  for (const entry of config.plugins) {
    if (summaries.some((summary) => summary.name === entry.name)) continue;
    summaries.push({
      ...identity(entry.name, false, entry.package, entry.version),
      // Reading a description means importing the package, which listing must
      // not do: `mora plugin list` should be safe to run on a fresh clone.
      description: null,
      added: true,
      installed: entry.package !== undefined && isPluginInstalled(config.root, entry.package),
    });
  }

  const report: PluginListReport = {
    ok: true,
    command: 'plugin list',
    root: config.root,
    plugins: summaries,
  };

  if (!flags.json) {
    prompts.intro(pc.bgCyan(pc.black(' mora plugin list ')));
    prompts.note(summaries.map(listLine).join('\n'), 'Plugins');
    const added = summaries.filter((summary) => summary.added).length;
    prompts.outro(
      added === 0
        ? 'None added. Run `mora plugin add <name>` to set one up.'
        : `${added === 1 ? '1 plugin' : `${added} plugins`} in use.`,
    );
  }

  return report;
}

function pluginContext(config: MoraConfig): PluginContext {
  return {
    root: config.root,
    projectName: config.projectName,
    modelsDir: config.modelsDir,
  };
}

function identity(
  name: string,
  builtIn: boolean,
  packageName: string | undefined,
  version: string | undefined,
): PluginIdentity {
  return {
    name,
    builtIn,
    package: packageName ?? null,
    version: version ?? null,
  };
}

/** Asks before deleting anything, since the files being removed may be committed. */
async function declined(
  setup: PluginSetup | undefined,
  flags: Partial<RemoveFlags>,
): Promise<boolean> {
  if (flags.keepFiles || !setup || !process.stdin.isTTY) return false;

  const paths = setup.files.map((file) => file.path);
  if (paths.length === 0) return false;

  prompts.log.warn(`This deletes:\n${paths.map((file) => `  ${file}`).join('\n')}`);
  const confirmed = await prompts.confirm({ message: 'Remove them?', initialValue: false });
  return prompts.isCancel(confirmed) || confirmed === false;
}

function listLine(summary: PluginSummary): string {
  const marks: string[] = [];
  if (summary.added) marks.push(pc.green('added'));
  if (summary.added && !summary.installed) marks.push(pc.yellow('not installed'));
  if (!summary.builtIn) marks.push(pc.dim(summary.package ?? 'third-party'));
  if (summary.description) marks.push(pc.dim(summary.description));
  return `  ${pc.cyan(summary.name)}  ${marks.join('  ')}`;
}

function reportAdd(report: PluginAddReport, setup: PluginSetup): void {
  if (report.files.length > 0) {
    prompts.note(
      report.files.map((file) => `${actionLabel(file.action)} ${file.path}`).join('\n'),
      'Files',
    );
  } else {
    prompts.log.info('Everything this plugin writes was already in place.');
  }

  const kept = report.files.filter((file) => file.action === 'kept');
  if (kept.length > 0) {
    prompts.log.info(
      `Left alone, because they have been edited since: ${kept
        .map((file) => file.path)
        .join(', ')}.`,
    );
  }

  if (setup.nextSteps && setup.nextSteps.length > 0) {
    prompts.note(setup.nextSteps.map((step, i) => `${i + 1}. ${step}`).join('\n'), 'Next');
  }
  prompts.outro(`${pc.cyan(report.plugin.name)} is set up in this project.`);
}

function reportRemove(report: PluginRemoveReport): void {
  if (report.files.length > 0) {
    prompts.note(
      report.files.map((file) => `${removalLabel(file.action)} ${file.path}`).join('\n'),
      'Files',
    );
  }
  prompts.note(report.nextSteps.map((step, i) => `${i + 1}. ${step}`).join('\n'), 'Next');
  prompts.outro(`${pc.cyan(report.plugin.name)} removed from this project.`);
}

function actionLabel(action: PluginWrittenFile['action']): string {
  switch (action) {
    case 'created':
      return pc.green('create');
    case 'overwritten':
      return pc.yellow('replace');
    case 'updated':
      return pc.yellow('update');
    case 'kept':
      return pc.yellow('  keep');
    case 'unchanged':
      return pc.dim('  skip');
  }
}

function removalLabel(action: PluginFileRemoval['action']): string {
  switch (action) {
    case 'deleted':
      return pc.red('delete');
    case 'kept-by-flag':
      return pc.yellow('  keep');
    case 'kept-modified':
      return pc.yellow('edited');
    case 'missing':
      return pc.dim('  gone');
  }
}
