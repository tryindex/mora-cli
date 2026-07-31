import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QueryMaterializer, Runtime } from '@malloydata/malloy';
import { MoraError } from '../errors.js';
import { looksLikeMissingData } from './compile.js';
import { describeError, openRuntime, type RuntimeRequest } from './runtime.js';
import {
  type Definition,
  indexDefinitions,
  readVocabulary,
  resolveDefinition,
  type Vocabulary,
} from './vocabulary.js';

/** One row, as plain JSON-safe values ready to print or serialize. */
export type QueryRow = Record<string, unknown>;

export interface QueryRequest extends RuntimeRequest {
  /** Absolute project root, which model paths are relative to. */
  root: string;
  modelPaths: readonly string[];
  /** A definition to run: a `query:` declaration, or a view as `source.view`. */
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
    const vocabulary = await readVocabulary(opened.runtime, request.root, request.modelPaths);
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
      hint: 'Pass a definition name, or -e with Malloy to run.',
    });
  }

  const definition = resolve(request.name, vocabulary);
  const url = pathToFileURL(path.join(request.root, definition.model));
  const model = runtime.loadModel(url);

  const query =
    definition.kind === 'query'
      ? model.loadQueryByName(definition.name)
      : // A view is run as `source -> view` rather than through
        // loadExploreByName, which compiles the view against the source in
        // isolation and drops its joins: the SQL still selects the joined
        // column but never joins the table, and the database rejects it. This
        // is the form the guidance tells people to write anyway.
        model.loadQuery(`run: ${quoteName(definition.source)} -> ${quoteName(definition.view)}`);

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
  const document = asQueryDocument(expr);
  const named = vocabulary.sources.find((source) => mentions(expr, source.name));

  // An expression that brings its own source resolves without a model to hang it
  // off, and insisting on one would fail exactly where discovery begins: in a
  // project whose models directory is still empty.
  if (!named && declaresSource(document)) {
    return { query: runtime.loadQuery(document), name: null, model: null, reviewed: false };
  }

  const modelPath = named?.model ?? soleModel(request.modelPaths);
  const url = pathToFileURL(path.join(request.root, modelPath));

  return {
    query: runtime.loadModel(url).loadQuery(document),
    name: null,
    model: modelPath,
    reviewed: false,
  };
}

function declaresSource(document: string): boolean {
  return /(^|\n)\s*source\s*:/.test(document);
}

/**
 * A name out of the model, written so Malloy reads it back as that same name.
 * Backticks matter for the source someone declared as `` `year` ``: a reserved
 * word is a legal definition name and an illegal bare reference.
 */
function quoteName(name: string | undefined): string {
  return `\`${name ?? ''}\``;
}

/**
 * Malloy wants a statement; a bare `source -> {...}` is the natural thing to
 * type. Anything already beginning with a statement keyword is passed through
 * untouched, which is what lets an expression declare a scratch source of its
 * own before running against it — the shape discovery work takes, when the
 * table is not in the model yet.
 */
function asQueryDocument(expr: string): string {
  const trimmed = expr.trim();
  return STARTS_WITH_STATEMENT.test(trimmed) ? trimmed : `run: ${trimmed}`;
}

const STARTS_WITH_STATEMENT = /^(run\s*:|query\s*:|source\s*:|import\b|##)/;

/**
 * Whether an expression reads a source by name. The sources it names are the
 * only reliable signal of which model it belongs to, since the expression itself
 * says nothing about files.
 */
function mentions(expr: string, sourceName: string): boolean {
  return new RegExp(`(^|[^\\w.])${escapeRegExp(sourceName)}($|[^\\w])`).test(expr);
}

/**
 * The model an expression that named no source belongs to. One model is no
 * guess; more than one is, and guessing would silently resolve a field against
 * the wrong vocabulary.
 */
function soleModel(modelPaths: readonly string[]): string {
  if (modelPaths.length === 1) return modelPaths[0] as string;

  throw new MoraError('Cannot tell which model this expression belongs to.', {
    code: 'ambiguous-model',
    hint:
      modelPaths.length === 0
        ? 'This project has no models yet. Declare the source in the expression itself: `source: probe is <connection>.table(...)` followed by `run:`.'
        : 'Start the expression with the name of a source one of the models declares.',
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
    : 'Run `mora validate` to check the model, and read the model file to see what it defines.';

  return new MoraError(message, { code: 'query-failed', hint });
}
