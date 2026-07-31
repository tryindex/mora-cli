import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DATABASES, type DatabaseId, defaultConnectionSettings } from './databases.js';
import { collectEnvVars, ENV_EXAMPLE_FILENAME } from './env.js';
import { MoraError } from './errors.js';
import {
  type AgentDocsOptions,
  renderMalloyGuide,
  renderModelingGuide,
  renderMoraGuide,
} from './templates/agent-docs.js';
import { renderAgentsDoc } from './templates/agents-doc.js';
import { renderEnvExample } from './templates/env.js';
import { renderMoraConfig } from './templates/mora-config.js';

export const CONFIG_FILENAME = 'mora.yaml';
export const AGENTS_FILENAME = 'AGENTS.md';
/** Docs Mora owns outright, kept out of AGENTS.md so a team's own writing is never touched. */
export const AGENT_DOCS_DIR = '.agents';

export interface ScaffoldSpec {
  root: string;
  projectName: string;
  database: DatabaseId;
  modelsDir: string;
  /** Name models will use for the connection, as in `warehouse.table('...')`. */
  connectionName: string;
  /**
   * Settings for that connection, as they should appear in mora.yaml. When
   * omitted, the registry's suggested defaults (`${VAR}` references) are used.
   */
  connectionSettings?: Record<string, string>;
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
  connectionName: string;
}

export function resolvePaths(spec: ScaffoldSpec): ScaffoldPaths {
  return {
    configPath: CONFIG_FILENAME,
    agentsPath: AGENTS_FILENAME,
    modelsDir: normalizeRelative(spec.modelsDir),
    connectionName: spec.connectionName,
  };
}

const GITIGNORE_ENTRIES = [
  '# Mora',
  '.mora/',
  '*.duckdb',
  '*.duckdb.wal',
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
    connection: {
      name: spec.connectionName,
      type: spec.database,
      settings:
        spec.connectionSettings ?? defaultConnectionSettings(spec.database, paths.modelsDir),
    },
  });

  files.push({
    path: paths.configPath,
    strategy: 'replace',
    contents: config,
  });

  // The models directory is the semantic layer, and it starts empty: what
  // belongs in it is sources over the reader's own tables, which only they can
  // write. Git needs the placeholder to carry an empty directory.
  files.push({
    path: `${paths.modelsDir}/.gitkeep`,
    strategy: 'replace',
    contents: '',
  });

  const agentsDoc = renderAgentsDoc({
    projectName: spec.projectName,
    modelsDir: paths.modelsDir,
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
      connectionName: spec.connectionName,
      sampleTablePath: DATABASES[spec.database].sampleTable,
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
 * The docs Mora writes and owns. Kept separate from the rest of the scaffold
 * because they are rewritten on every run: an existing copy is a previous
 * version of Mora's own output, never something a team wrote.
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
      path: `${AGENT_DOCS_DIR}/modeling.md`,
      strategy: 'replace',
      owned: true,
      contents: renderModelingGuide(options),
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

/**
 * What the project looked like before Mora touched it, kept so a run that
 * cannot finish can leave the directory exactly as it found it. `init` refuses
 * to leave a half-built project behind, and half-built is what a scaffold with
 * an unreachable connection would be.
 */
export interface ScaffoldSnapshot {
  root: string;
  /** Prior contents of each file touched; undefined means it did not exist. */
  files: Map<string, string | undefined>;
  /** Directories Mora created, including the root when it made that too. */
  createdDirs: string[];
}

export function createSnapshot(root: string): ScaffoldSnapshot {
  return { root, files: new Map(), createdDirs: [] };
}

/**
 * Remembers a file's current contents before anything writes to it. Recording
 * twice keeps the first answer, which is the state Mora actually found.
 */
export async function recordFile(snapshot: ScaffoldSnapshot, relativePath: string): Promise<void> {
  if (snapshot.files.has(relativePath)) return;
  const absolute = path.join(snapshot.root, relativePath);
  snapshot.files.set(
    relativePath,
    existsSync(absolute) ? await readFile(absolute, 'utf8') : undefined,
  );
}

/** Creates a directory and its missing parents, noting which ones are new. */
export async function ensureDirectory(
  snapshot: ScaffoldSnapshot,
  absoluteDir: string,
): Promise<void> {
  const missing: string[] = [];
  for (let current = absoluteDir; !existsSync(current); current = path.dirname(current)) {
    missing.push(current);
    if (path.dirname(current) === current) break;
  }
  snapshot.createdDirs.push(...missing);
  await mkdir(absoluteDir, { recursive: true });
}

/**
 * Puts everything in the snapshot back: files Mora overwrote get their contents
 * again, files it created are removed, and directories it created go with them
 * once they are empty. A directory that has since gained a file of someone
 * else's is left alone.
 */
export async function revertScaffold(snapshot: ScaffoldSnapshot): Promise<void> {
  for (const [relativePath, previous] of snapshot.files) {
    const absolute = path.join(snapshot.root, relativePath);
    if (previous === undefined) {
      await rm(absolute, { force: true });
    } else {
      await writeFile(absolute, previous, 'utf8');
    }
  }

  // Deepest first, so a parent is only considered once its children are gone.
  const deepestFirst = [...new Set(snapshot.createdDirs)].sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length,
  );
  for (const directory of deepestFirst) {
    await rmdir(directory).catch(() => undefined);
  }
}

export async function writeScaffold(
  root: string,
  files: ScaffoldFile[],
  snapshot: ScaffoldSnapshot = createSnapshot(root),
): Promise<{ written: WrittenFile[]; snapshot: ScaffoldSnapshot }> {
  const written: WrittenFile[] = [];

  for (const file of files) {
    const absolute = path.join(root, file.path);
    await ensureDirectory(snapshot, path.dirname(absolute));
    await recordFile(snapshot, file.path);

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

  return { written, snapshot };
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
