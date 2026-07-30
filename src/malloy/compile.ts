import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Runtime } from '@malloydata/malloy';
import { type ConnectionConfig, isSupportedConnection } from '../config.js';
import { createRuntime, describeError, type RuntimeRequest } from './runtime.js';

export interface CompileRequest extends RuntimeRequest {
  /** Absolute path to the .malloy file to compile. */
  modelPath: string;
  /** Declared connections Mora cannot open, used to explain compile failures. */
  unsupportedConnections?: readonly ConnectionConfig[];
}

export interface CompileResult {
  status: 'passed' | 'failed' | 'skipped';
  /** Why the check did not run, when status is `skipped`. */
  reason?: string;
  sources?: string[];
  queries?: string[];
  error?: string;
  durationMs?: number;
}

/**
 * Compiles a model against the project's real connections. This is a smoke test
 * with teeth: Malloy resolves table schemas during compilation, so a pass means
 * the model parses *and* the underlying data actually has the referenced columns.
 */
export async function compileModel(request: CompileRequest): Promise<CompileResult> {
  const startedAt = Date.now();

  const opened = await createRuntime(request);
  if (!opened.ok) {
    return {
      status: 'skipped',
      reason: `Malloy could not be loaded (${opened.reason})`,
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    return await compileWithRuntime(opened.runtime, request);
  } finally {
    await opened.close();
  }
}

async function compileWithRuntime(
  runtime: Runtime,
  request: CompileRequest,
): Promise<CompileResult> {
  const startedAt = Date.now();
  try {
    const model = await runtime.getModel(pathToFileURL(request.modelPath));

    return {
      status: 'passed',
      sources: model.explores.map((explore) => explore.name),
      queries: model.queries().named,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: explain(describeError(error), request.unsupportedConnections ?? []),
      durationMs: Date.now() - startedAt,
    };
  }
}

export interface ModelCompileResult extends CompileResult {
  /** Path relative to the project root, using forward slashes. */
  path: string;
}

export interface ProjectCompileRequest extends RuntimeRequest {
  /** Absolute project root, which model paths are relative to. */
  root: string;
  /** Model files to compile, relative to the root. */
  modelPaths: readonly string[];
  /** Every connection declared in mora.yaml, used to explain failures. */
  declaredConnections: readonly ConnectionConfig[];
}

/**
 * Compiles every model in the project against one set of connections. The
 * connections are opened once and reused: a warehouse client is expensive to
 * build, and there is nothing to gain from rebuilding it per file. Models are
 * still compiled in a stable order, which makes failures easier to read than a
 * faster interleaved run would be.
 */
export async function compileProject(
  request: ProjectCompileRequest,
): Promise<ModelCompileResult[]> {
  const unsupported = request.declaredConnections.filter(
    (connection) => !isSupportedConnection(connection),
  );

  const opened = await createRuntime(request);
  if (!opened.ok) {
    const reason = `Malloy could not be loaded (${opened.reason})`;
    return request.modelPaths.map((path) => ({ path, status: 'skipped', reason }));
  }

  try {
    const results: ModelCompileResult[] = [];
    for (const relativePath of request.modelPaths) {
      const modelPath = path.join(request.root, relativePath);
      const result = await compileWithRuntime(opened.runtime, {
        ...request,
        modelPath,
        unsupportedConnections: await referencedConnections(modelPath, unsupported),
      });
      results.push({ path: relativePath, ...result });
    }
    return results;
  } finally {
    await opened.close();
  }
}

/**
 * Which of the given connections the model actually reads from. A model naming a
 * connection Mora has no driver for fails deep inside Malloy, for a reason that
 * reads like a broken model. Knowing the reference up front lets us say what
 * really went wrong.
 */
async function referencedConnections(
  modelPath: string,
  connections: readonly ConnectionConfig[],
): Promise<ConnectionConfig[]> {
  if (connections.length === 0) return [];
  const source = await readFile(modelPath, 'utf8').catch(() => '');
  return connections.filter((connection) =>
    new RegExp(`(^|[^\\w.])${escapeRegExp(connection.name)}\\s*\\.`, 'm').test(source),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SKIPPED_DIRECTORIES = new Set(['data', 'node_modules']);

/**
 * Finds every `.malloy` file under the models directory. Paths are returned
 * relative to the project root and sorted, so reports are stable across runs.
 */
export async function discoverModels(root: string, modelsDir: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(relativeDir: string): Promise<void> {
    const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) continue;
        await walk(relativePath);
      } else if (entry.isFile() && entry.name.endsWith('.malloy')) {
        found.push(relativePath);
      }
    }
  }

  await walk(modelsDir);
  return found.sort();
}

function explain(error: string, unsupported: readonly ConnectionConfig[]): string {
  const notes = unsupported.map(
    (connection) =>
      `This model reads from "${connection.name}" (${connection.type}), which Mora has no ` +
      'driver for, so the errors above may be about the wrong database. Mora can open ' +
      'duckdb and bigquery connections.',
  );

  if (looksLikeMissingData(error)) {
    notes.push(
      'The tables this model references are not readable here, which usually means the ' +
        'data is missing rather than the model being wrong. Data files and .duckdb ' +
        'databases are normally gitignored, so a fresh checkout has the models without them.',
    );
  }

  return notes.length === 0 ? error : [error, ...notes].join('\n');
}

const MISSING_DATA_PATTERNS = [
  /Table with name .* does not exist/i,
  /No files found that match the pattern/i,
  /IO Error: No files found/i,
  /Catalog Error: Table/i,
];

export function looksLikeMissingData(error: string): boolean {
  return MISSING_DATA_PATTERNS.some((pattern) => pattern.test(error));
}
