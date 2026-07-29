import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export interface CompileRequest {
  /** Absolute path to the .malloy file to compile. */
  modelPath: string;
  /** Directory that relative table paths inside the model resolve from. */
  workingDirectory: string;
  /** Connection name the model refers to, e.g. `duckdb`. */
  connectionName: string;
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
 * Malloy and DuckDB are loaded lazily. They pull in native and wasm bundles, so
 * paying that cost on every `mora --help` would be wasteful, and a broken
 * install should degrade to a warning rather than take the whole CLI down.
 */
async function loadMalloy() {
  const [malloyModule, duckdbModule] = await Promise.all([
    import('@malloydata/malloy'),
    import('@malloydata/db-duckdb'),
  ]);
  // Both packages ship CommonJS, where the namespace object lands on `default`.
  const malloy =
    (malloyModule as unknown as { default?: typeof malloyModule }).default ?? malloyModule;
  const duckdb =
    (duckdbModule as unknown as { default?: typeof duckdbModule }).default ?? duckdbModule;
  return { malloy, duckdb };
}

/**
 * Compiles a model against a real DuckDB connection. This is a smoke test with
 * teeth: Malloy resolves table schemas during compilation, so a pass means the
 * model parses *and* the underlying data actually has the referenced columns.
 */
export async function compileModel(request: CompileRequest): Promise<CompileResult> {
  const startedAt = Date.now();

  let malloy: Awaited<ReturnType<typeof loadMalloy>>['malloy'];
  let duckdb: Awaited<ReturnType<typeof loadMalloy>>['duckdb'];
  try {
    ({ malloy, duckdb } = await loadMalloy());
  } catch (error) {
    return {
      status: 'skipped',
      reason: `Malloy could not be loaded (${describe(error)})`,
      durationMs: Date.now() - startedAt,
    };
  }

  const connection = new duckdb.DuckDBConnection(
    request.connectionName,
    ':memory:',
    request.workingDirectory,
  );

  try {
    const runtime = new malloy.SingleConnectionRuntime({
      connection,
      urlReader: {
        readURL: async (url: URL) => readFile(url, 'utf8'),
      },
    });

    const model = await runtime.getModel(pathToFileURL(request.modelPath));

    return {
      status: 'passed',
      sources: model.explores.map((explore) => explore.name),
      queries: model.namedQueries.map((query) => query.name),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      status: 'failed',
      error: describe(error),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await connection.close().catch(() => {
      // A connection we are discarding anyway; a close failure is not news.
    });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
