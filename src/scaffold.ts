import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { DatabaseId } from './databases.js';
import { MoraError } from './errors.js';
import { renderAgentsDoc } from './templates/agents-doc.js';
import { renderExampleModel } from './templates/example-model.js';
import { renderMoraConfig } from './templates/mora-config.js';
import { SAMPLE_ORDERS_CSV } from './templates/sample-data.js';

export const CONFIG_FILENAME = 'mora.yaml';
export const AGENTS_FILENAME = 'AGENTS.md';
export const EXAMPLE_MODEL_FILENAME = 'example.malloy';
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

export type WriteStrategy = 'replace' | 'merge-lines';

export interface ScaffoldFile {
  /** Path relative to the project root, using forward slashes. */
  path: string;
  contents: string;
  strategy: WriteStrategy;
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
  connectionName: string;
}

export function resolvePaths(spec: ScaffoldSpec): ScaffoldPaths {
  const modelsDir = normalizeRelative(spec.modelsDir);
  const dataDir = `${modelsDir}/data`;
  return {
    configPath: CONFIG_FILENAME,
    agentsPath: AGENTS_FILENAME,
    modelsDir,
    dataDir,
    exampleModelPath: `${modelsDir}/${EXAMPLE_MODEL_FILENAME}`,
    sampleDataPath: `${dataDir}/${SAMPLE_DATA_FILENAME}`,
    connectionName: spec.database === 'duckdb' ? DUCKDB_CONNECTION_NAME : WAREHOUSE_CONNECTION_NAME,
  };
}

const GITIGNORE_ENTRIES = ['# Mora', '.mora/', '*.duckdb', '*.duckdb.wal', '.env', '.env.*'];

export function buildScaffold(spec: ScaffoldSpec): ScaffoldFile[] {
  const paths = resolvePaths(spec);
  const files: ScaffoldFile[] = [];

  files.push({
    path: paths.configPath,
    strategy: 'replace',
    contents: renderMoraConfig({
      projectName: spec.projectName,
      modelsDir: paths.modelsDir,
      dataDir: paths.dataDir,
      database: spec.database,
      duckdbConnectionName: DUCKDB_CONNECTION_NAME,
      warehouseConnectionName: WAREHOUSE_CONNECTION_NAME,
    }),
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
        tablePath: SAMPLE_DATA_FILENAME,
      }),
    });
  } else {
    files.push({
      path: `${paths.modelsDir}/.gitkeep`,
      strategy: 'replace',
      contents: '',
    });
  }

  files.push({
    path: paths.agentsPath,
    strategy: 'replace',
    contents: renderAgentsDoc({
      projectName: spec.projectName,
      modelsDir: paths.modelsDir,
      dataDir: paths.dataDir,
      exampleModelPath: paths.exampleModelPath,
      connectionName: DUCKDB_CONNECTION_NAME,
      hasExample: spec.includeExample,
    }),
  });

  files.push({
    path: '.gitignore',
    strategy: 'merge-lines',
    contents: `${GITIGNORE_ENTRIES.join('\n')}\n`,
  });

  return files;
}

/** Files that already exist and would lose their current contents. */
export function findConflicts(root: string, files: ScaffoldFile[]): string[] {
  return files
    .filter((file) => file.strategy === 'replace' && existsSync(path.join(root, file.path)))
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

    const existed = existsSync(absolute);
    await writeFile(absolute, file.contents, 'utf8');
    written.push({ path: file.path, action: existed ? 'overwritten' : 'created' });
  }

  return written;
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
