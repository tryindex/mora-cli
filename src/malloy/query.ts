import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QueryMaterializer, Runtime } from '@malloydata/malloy';
import { MoraError } from '../errors.js';
import { looksLikeMissingData } from './compile.js';
import {
  type Definition,
  describeModels,
  indexDefinitions,
  resolveDefinition,
  type Vocabulary,
} from './describe.js';
import { describeError, openRuntime, type RuntimeRequest } from './runtime.js';

/** One row, as plain JSON-safe values ready to print or serialize. */
export type QueryRow = Record<string, unknown>;

export interface QueryRequest extends RuntimeRequest {
  /** Absolute project root, which model paths are relative to. */
  root: string;
  modelPaths: readonly string[];
  /** A definition to run, as `mora describe` lists it. */
  name?: string;
  /** Malloy to run that the model does not define. */
  expr?: string;
  /** Largest number of rows to return. */
  limit: number;
  /** Print the SQL without running it. */
  sqlOnly?: boolean;
}

export interface QueryOutcome {
  /** The definition that ran, or null for an ad-hoc expression. */
  name: string | null;
  /**
   * Whether the logic that produced this came from the model. An ad-hoc
   * expression has not been through review, and an answer built on one should
   * say so.
   */
  reviewed: boolean;
  /** Model the query was compiled against. */
  model: string | null;
  sql: string;
  rows: QueryRow[];
  rowCount: number;
  /** True when the row limit cut the result short. */
  truncated: boolean;
  /** The vocabulary the name was resolved against, for error messages. */
  vocabulary: Vocabulary;
}

export async function runQuery(request: QueryRequest): Promise<QueryOutcome> {
  const opened = await openRuntime(request);

  try {
    const vocabulary = await describeModels(opened.runtime, request.root, request.modelPaths);
    const { query, name, model, reviewed } = request.expr
      ? adHoc(opened.runtime, request, vocabulary)
      : named(opened.runtime, request, vocabulary);

    const sql = await query.getSQL().catch((error: unknown) => {
      throw compileFailure(error);
    });

    if (request.sqlOnly) {
      return { name, reviewed, model, sql, rows: [], rowCount: 0, truncated: false, vocabulary };
    }

    // One extra row, so a result cut short can be reported as cut short rather
    // than silently looking complete.
    const result = await query.run({ rowLimit: request.limit + 1 }).catch((error: unknown) => {
      throw compileFailure(error);
    });

    // toJSON rather than toObject: bigints and Dates come back from toObject,
    // and JSON.stringify throws on the first bigint it meets.
    const all = result.data.toJSON() as QueryRow[];
    const rows = all.slice(0, request.limit);

    return {
      name,
      reviewed,
      model,
      sql,
      rows,
      rowCount: rows.length,
      truncated: all.length > rows.length,
      vocabulary,
    };
  } finally {
    await opened.close();
  }
}

interface LoadedQuery {
  query: QueryMaterializer;
  name: string | null;
  model: string | null;
  reviewed: boolean;
}

function named(runtime: Runtime, request: QueryRequest, vocabulary: Vocabulary): LoadedQuery {
  if (!request.name) {
    throw new MoraError('No query to run.', {
      code: 'no-query',
      hint: 'Pass a definition name, or -e with Malloy to run. `mora describe` lists the names.',
    });
  }

  const definition = resolve(request.name, vocabulary);
  const url = pathToFileURL(path.join(request.root, definition.model));
  const model = runtime.loadModel(url);

  const query =
    definition.kind === 'query'
      ? model.loadQueryByName(definition.name)
      : model
          .loadExploreByName(definition.source as string)
          .loadQueryByName(definition.view as string);

  return { query, name: definition.name, model: definition.model, reviewed: true };
}

/**
 * Turns a name into a definition, or into the real reason it is not there. A
 * model that failed to compile contributes nothing to the vocabulary, and
 * reporting that as "no such definition" sends the reader looking for a typo
 * instead of at the broken model.
 */
function resolve(name: string, vocabulary: Vocabulary): Definition {
  try {
    return resolveDefinition(indexDefinitions(vocabulary), name);
  } catch (error) {
    const failure = vocabulary.failures[0];
    if (failure && error instanceof MoraError && error.code === 'unknown-definition') {
      throw compileFailure(
        `${failure.model} did not compile, so "${name}" is not available:\n${failure.error}`,
      );
    }
    throw error;
  }
}

function adHoc(runtime: Runtime, request: QueryRequest, vocabulary: Vocabulary): LoadedQuery {
  const expr = request.expr as string;
  const modelPath = chooseModel(vocabulary, expr, request.modelPaths);
  const url = pathToFileURL(path.join(request.root, modelPath));

  return {
    query: runtime.loadModel(url).loadQuery(asQueryDocument(expr)),
    name: null,
    model: modelPath,
    reviewed: false,
  };
}

/** Malloy wants a statement; a bare `source -> {...}` is the natural thing to type. */
function asQueryDocument(expr: string): string {
  const trimmed = expr.trim();
  return /^(run|query)\s*:/.test(trimmed) ? trimmed : `run: ${trimmed}`;
}

/**
 * Which model an ad-hoc expression belongs to. The sources it names are the only
 * reliable signal, since the expression itself says nothing about files.
 */
function chooseModel(vocabulary: Vocabulary, expr: string, modelPaths: readonly string[]): string {
  const named = vocabulary.sources.find((source) =>
    new RegExp(`(^|[^\\w.])${escapeRegExp(source.name)}($|[^\\w])`).test(expr),
  );
  if (named) return named.model;

  if (modelPaths.length === 1) return modelPaths[0] as string;

  throw new MoraError('Cannot tell which model this expression belongs to.', {
    code: 'ambiguous-model',
    hint: 'Start the expression with a source name, as `mora describe` lists it.',
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileFailure(error: unknown): MoraError {
  const message = describeError(error);
  const hint = looksLikeMissingData(message)
    ? 'The tables the model reads are not readable here, which usually means the data is ' +
      'missing rather than the query being wrong. Data files are normally gitignored.'
    : 'Run `mora validate` to check the model, and `mora describe` to see what it defines.';

  return new MoraError(message, { code: 'query-failed', hint });
}
