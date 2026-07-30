import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { DatabaseId } from './databases.js';
import { collectEnvVars, ENV_EXAMPLE_FILENAME } from './env.js';
import { MoraError } from './errors.js';
import {
  type AgentDocsOptions,
  renderMalloyGuide,
  renderMoraGuide,
} from './templates/agent-docs.js';
import { renderAgentsDoc } from './templates/agents-doc.js';
import { renderEnvExample } from './templates/env.js';
import { renderExampleModel } from './templates/example-model.js';
import { renderMoraConfig } from './templates/mora-config.js';
import {
  PUBLISHER_CONFIG_FILENAME,
  PUBLISHER_MANIFEST_FILENAME,
  renderPublisherConfig,
  renderPublisherManifest,
} from './templates/publisher.js';
import { SAMPLE_ORDERS_CSV } from './templates/sample-data.js';
import { CLI_VERSION } from './version.js';

export const CONFIG_FILENAME = 'mora.yaml';
export const AGENTS_FILENAME = 'AGENTS.md';
/** Docs Mora owns outright, kept out of AGENTS.md so upgrades never conflict. */
export const AGENT_DOCS_DIR = '.agents';
export const EXAMPLE_MODEL_FILENAME = 'example.malloy';
export const SAMPLE_DATA_DIR = 'data';
export const SAMPLE_DATA_FILENAME = 'orders.csv';
export const DUCKDB_CONNECTION_NAME = 'duckdb';
export const WAREHOUSE_CONNECTION_NAME = 'warehouse';

export interface ScaffoldSpec {
  root: string;
  projectName: string;
  database: DatabaseId;
  modelsDir: string;
  includeExample: boolean;
}

export type WriteStrategy = 'replace' | 'merge-lines' | 'managed-block';

export const MANAGED_BEGIN = '<!-- mora:begin managed -->';
export const MANAGED_END = '<!-- mora:end managed -->';

export interface ScaffoldFile {
  /** Path relative to the project root, using forward slashes. */
  path: string;
  contents: string;
  strategy: WriteStrategy;
  /** Text placed around the block, outside what Mora rewrites later. */
  surround?: { before?: string; after?: string };
  /**
   * Mora owns this file entirely and rewrites it on every run, so an existing
   * copy is a previous version of Mora's own output rather than a conflict.
   */
  owned?: boolean;
}

export type FileAction = 'created' | 'overwritten' | 'updated' | 'unchanged';

export interface WrittenFile {
  path: string;
  action: FileAction;
}

export interface ScaffoldPaths {
  configPath: string;
  agentsPath: string;
  modelsDir: string;
  dataDir: string;
  exampleModelPath: string;
  sampleDataPath: string;
  /**
   * How the example model refers to its data: relative to the models directory
   * rather than to the data directory. Malloy Publisher resolves a package's
   * relative table paths from the package root, so a model written this way is
   * servable as-is instead of only compiling under Mora.
   */
  sampleTablePath: string;
  /** Package manifest, which lives beside the models it describes. */
  publisherManifestPath: string;
  /** Server config, which Publisher reads from the directory it starts in. */
  publisherConfigPath: string;
  connectionName: string;
}

export function resolvePaths(spec: ScaffoldSpec): ScaffoldPaths {
  const modelsDir = normalizeRelative(spec.modelsDir);
  const dataDir = `${modelsDir}/${SAMPLE_DATA_DIR}`;
  const sampleTablePath = `${SAMPLE_DATA_DIR}/${SAMPLE_DATA_FILENAME}`;
  return {
    configPath: CONFIG_FILENAME,
    agentsPath: AGENTS_FILENAME,
    modelsDir,
    dataDir,
    exampleModelPath: `${modelsDir}/${EXAMPLE_MODEL_FILENAME}`,
    sampleDataPath: `${modelsDir}/${sampleTablePath}`,
    sampleTablePath,
    publisherManifestPath: `${modelsDir}/${PUBLISHER_MANIFEST_FILENAME}`,
    publisherConfigPath: PUBLISHER_CONFIG_FILENAME,
    connectionName: spec.database === 'duckdb' ? DUCKDB_CONNECTION_NAME : WAREHOUSE_CONNECTION_NAME,
  };
}

const GITIGNORE_ENTRIES = [
  '# Mora',
  '.mora/',
  '*.duckdb',
  '*.duckdb.wal',
  // Malloy Publisher's persisted state and its copies of served packages. The
  // config that produces them is committed; these are per-machine.
  'publisher.db',
  'publisher.db.wal',
  'publisher_data/',
  '.env',
  '.env.*',
  // The example is the one env file that belongs in version control: it tells a
  // teammate which credentials to set without carrying any of them.
  `!${ENV_EXAMPLE_FILENAME}`,
];

export function buildScaffold(spec: ScaffoldSpec): ScaffoldFile[] {
  const paths = resolvePaths(spec);
  const files: ScaffoldFile[] = [];

  const config = renderMoraConfig({
    projectName: spec.projectName,
    modelsDir: paths.modelsDir,
    database: spec.database,
    duckdbConnectionName: DUCKDB_CONNECTION_NAME,
    warehouseConnectionName: WAREHOUSE_CONNECTION_NAME,
    cliVersion: CLI_VERSION,
  });

  files.push({
    path: paths.configPath,
    strategy: 'replace',
    contents: config,
  });

  // Scaffolded once and then the team's, like mora.yaml: a Publisher config
  // grows warehouse connections and access rules that Mora must not clobber.
  const publisher = { projectName: spec.projectName, modelsDir: paths.modelsDir };
  files.push({
    path: paths.publisherManifestPath,
    strategy: 'replace',
    contents: renderPublisherManifest(publisher),
  });
  files.push({
    path: paths.publisherConfigPath,
    strategy: 'replace',
    contents: renderPublisherConfig(publisher),
  });

  if (spec.includeExample) {
    files.push({
      path: paths.sampleDataPath,
      strategy: 'replace',
      contents: SAMPLE_ORDERS_CSV,
    });
    files.push({
      path: paths.exampleModelPath,
      strategy: 'replace',
      contents: renderExampleModel({
        // The example always reads local CSV, so it stays on the DuckDB
        // connection even when the project targets a warehouse.
        connectionName: DUCKDB_CONNECTION_NAME,
        tablePath: paths.sampleTablePath,
      }),
    });
  } else {
    files.push({
      path: `${paths.modelsDir}/.gitkeep`,
      strategy: 'replace',
      contents: '',
    });
  }

  const agentsDoc = renderAgentsDoc({
    projectName: spec.projectName,
    modelsDir: paths.modelsDir,
    dataDir: paths.dataDir,
    exampleModelPath: paths.exampleModelPath,
    hasExample: spec.includeExample,
    agentDocsDir: AGENT_DOCS_DIR,
  });

  files.push({
    path: paths.agentsPath,
    // A team adds its own conventions to AGENTS.md, and those must survive Mora
    // rewriting the part it owns.
    strategy: 'managed-block',
    contents: agentsDoc.managed,
    surround: { before: agentsDoc.title, after: agentsDoc.teamSection },
  });

  files.push(
    ...buildAgentDocs({
      modelsDir: paths.modelsDir,
      connectionName: DUCKDB_CONNECTION_NAME,
    }),
  );

  // Derived from the config we just rendered, so the two can never disagree
  // about which credentials the project needs. A DuckDB-only project references
  // none, and then there is nothing worth committing.
  const variables = collectEnvVars(parseYaml(config));
  if (variables.length > 0) {
    files.push({
      path: ENV_EXAMPLE_FILENAME,
      strategy: 'replace',
      contents: renderEnvExample({ projectName: spec.projectName, variables }),
    });
  }

  files.push({
    path: '.gitignore',
    strategy: 'merge-lines',
    contents: `${GITIGNORE_ENTRIES.join('\n')}\n`,
  });

  return files;
}

/**
 * The docs Mora writes and keeps current. Kept separate from the rest of the
 * scaffold so `mora upgrade` can refresh them in a project it did not create,
 * rather than leaving a checkout frozen at whichever version of Mora scaffolded
 * it.
 */
export function buildAgentDocs(options: AgentDocsOptions): ScaffoldFile[] {
  return [
    {
      path: `${AGENT_DOCS_DIR}/malloy.md`,
      strategy: 'replace',
      owned: true,
      contents: renderMalloyGuide(options),
    },
    {
      path: `${AGENT_DOCS_DIR}/mora.md`,
      strategy: 'replace',
      owned: true,
      contents: renderMoraGuide(options),
    },
  ];
}

/** Files that already exist and would lose their current contents. */
export function findConflicts(root: string, files: ScaffoldFile[]): string[] {
  return files
    .filter(
      (file) =>
        file.strategy === 'replace' && !file.owned && existsSync(path.join(root, file.path)),
    )
    .map((file) => file.path);
}

export async function writeScaffold(root: string, files: ScaffoldFile[]): Promise<WrittenFile[]> {
  const written: WrittenFile[] = [];

  for (const file of files) {
    const absolute = path.join(root, file.path);
    await mkdir(path.dirname(absolute), { recursive: true });

    if (file.strategy === 'merge-lines') {
      written.push(await mergeLines(absolute, file));
      continue;
    }

    if (file.strategy === 'managed-block') {
      written.push(await writeManagedBlock(absolute, file));
      continue;
    }

    if (!existsSync(absolute)) {
      await writeFile(absolute, file.contents, 'utf8');
      written.push({ path: file.path, action: 'created' });
      continue;
    }

    // Rewriting a file with what it already contains is not worth reporting, and
    // for the docs Mora refreshes on every run it would be all a report said.
    const current = await readFile(absolute, 'utf8');
    if (current === file.contents) {
      written.push({ path: file.path, action: 'unchanged' });
      continue;
    }

    await writeFile(absolute, file.contents, 'utf8');
    written.push({ path: file.path, action: 'overwritten' });
  }

  return written;
}

/**
 * Rewrites only the region Mora owns, leaving anything a team wrote around it
 * intact. A file that predates the markers keeps its contents and gains the
 * block at the end, which is friendlier than refusing to touch it.
 */
async function writeManagedBlock(absolute: string, file: ScaffoldFile): Promise<WrittenFile> {
  const block = `${MANAGED_BEGIN}\n${file.contents.trimEnd()}\n${MANAGED_END}\n`;
  const before = file.surround?.before?.trimEnd();
  const after = file.surround?.after?.trim();

  if (!existsSync(absolute)) {
    await writeFile(absolute, join([before, block.trimEnd(), after]), 'utf8');
    return { path: file.path, action: 'created' };
  }

  const current = await readFile(absolute, 'utf8');
  const start = current.indexOf(MANAGED_BEGIN);
  const end = current.indexOf(MANAGED_END);
  const hasBlock = start !== -1 && end > start;

  let updated: string;
  if (!hasBlock) {
    updated = `${current.trimEnd()}\n\n${block}`;
  } else {
    const above = current.slice(0, start);
    // A block sitting at the top of the file has lost its heading, or never had
    // one. Restoring it keeps the document readable without touching anything a
    // team wrote. There is deliberately no matching rule for the text below: a
    // section someone chose to delete should stay deleted.
    const heading = above.trim().length === 0 && before ? `${before}\n\n` : above;
    updated = heading + block.trimEnd() + current.slice(end + MANAGED_END.length);
  }

  if (updated === current) {
    return { path: file.path, action: 'unchanged' };
  }

  await writeFile(absolute, updated, 'utf8');
  return { path: file.path, action: 'updated' };
}

function join(sections: (string | undefined)[]): string {
  return `${sections.filter((section) => section && section.length > 0).join('\n\n')}\n`;
}

async function mergeLines(absolute: string, file: ScaffoldFile): Promise<WrittenFile> {
  if (!existsSync(absolute)) {
    await writeFile(absolute, file.contents, 'utf8');
    return { path: file.path, action: 'created' };
  }

  const current = await readFile(absolute, 'utf8');
  const present = new Set(current.split('\n').map((line) => line.trim()));
  const missing = file.contents
    .split('\n')
    .filter((line) => line.length > 0 && !present.has(line.trim()));

  if (missing.length === 0) {
    return { path: file.path, action: 'unchanged' };
  }

  const separator = current.endsWith('\n') ? '' : '\n';
  await writeFile(absolute, `${current}${separator}\n${missing.join('\n')}\n`, 'utf8');
  return { path: file.path, action: 'updated' };
}

/** Reads back what we just wrote, so a malformed template fails loudly here. */
export async function assertConfigParses(root: string): Promise<void> {
  const absolute = path.join(root, CONFIG_FILENAME);
  const contents = await readFile(absolute, 'utf8');
  try {
    parseYaml(contents);
  } catch (error) {
    throw new MoraError(
      `Generated ${CONFIG_FILENAME} is not valid YAML: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { code: 'invalid-config' },
    );
  }
}

export function normalizeRelative(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}
