import { readFile } from 'node:fs/promises';
import type { Runtime } from '@malloydata/malloy';
import { MoraError } from '../errors.js';

export interface RuntimeRequest {
  /** Connection name the models refer to, e.g. `duckdb`. */
  connectionName: string;
  /** Directory that relative table paths inside a model resolve from. */
  workingDirectory: string;
  /** `:memory:` or a path to a .duckdb file. Defaults to `:memory:`. */
  database?: string;
}

export interface OpenRuntime {
  ok: true;
  runtime: Runtime;
  close: () => Promise<void>;
}

export interface UnavailableRuntime {
  ok: false;
  /** Why Malloy could not be loaded, in a form worth showing a user. */
  reason: string;
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
 * A runtime over one DuckDB connection, shared by every command that needs to
 * compile or run Malloy. Callers must `close()` it: the connection holds a
 * DuckDB instance open until they do.
 */
export async function createRuntime(
  request: RuntimeRequest,
): Promise<OpenRuntime | UnavailableRuntime> {
  let loaded: Awaited<ReturnType<typeof loadMalloy>>;
  try {
    loaded = await loadMalloy();
  } catch (error) {
    return { ok: false, reason: describeError(error) };
  }

  const { malloy, duckdb } = loaded;
  const connection = new duckdb.DuckDBConnection(
    request.connectionName,
    request.database ?? ':memory:',
    request.workingDirectory,
  );

  const runtime = new malloy.SingleConnectionRuntime({
    connection,
    urlReader: {
      readURL: async (url: URL) => readFile(url, 'utf8'),
    },
  });

  return {
    ok: true,
    runtime,
    close: async () => {
      await connection.close().catch(() => {
        // A connection we are discarding anyway; a close failure is not news.
      });
    },
  };
}

/**
 * A runtime, or a failure loud enough to stop the command. Commands that read or
 * run models cannot degrade gracefully the way a compile check can: without
 * Malloy there is no answer to give.
 */
export async function openRuntime(request: RuntimeRequest): Promise<OpenRuntime> {
  const opened = await createRuntime(request);
  if (opened.ok) return opened;
  throw new MoraError(`Malloy could not be loaded (${opened.reason}).`, {
    code: 'malloy-unavailable',
    hint: 'Reinstall the CLI, or check that @malloydata/malloy and @malloydata/db-duckdb are installed.',
  });
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
