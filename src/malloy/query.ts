import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { QueryMaterializer, Runtime } from '@malloydata/malloy';
import { ExitCode, MoraError } from '../errors.js';
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
  // Checked before anything is opened: a document that cannot produce one answer
  // should cost nothing to be turned away.
  if (request.expr !== undefined) assertOneQuery(asQueryDocument(request.expr));

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

/**
 * Refuses a document that does not run exactly one query.
 *
 * Malloy compiles the whole document and materializes only its last query, so a
 * probe stacking several `run:` statements comes back as one result with nothing
 * to say the others were dropped. Someone batching five checks would read five
 * answers off a result that only ever held one, which is the quiet kind of wrong
 * this tool exists to prevent.
 */
function assertOneQuery(document: string): void {
  const code = withoutCommentsOrStrings(document);
  const runs = (code.match(RUN_STATEMENT) ?? []).length;
  if (runs === 1) return;

  if (runs > 1) {
    throw new MoraError(
      `This document has ${runs} \`run:\` statements, and a query runs one of them.`,
      {
        code: 'multiple-queries',
        exitCode: ExitCode.usage,
        hint:
          'Malloy would return only the last one and say nothing about the rest. Ask one ' +
          'question per document, or combine them into a single `run:` with several aggregates.',
      },
    );
  }

  const declared = code.match(NAMED_QUERY)?.[1];
  throw new MoraError('This document has no `run:` statement, so there is nothing to run.', {
    code: 'no-query-in-document',
    exitCode: ExitCode.usage,
    hint: declared
      ? `It declares \`${declared}\` but never runs it. Add \`run: ${declared}\`, or put the query in a model and run it by name.`
      : 'Add one, such as `run: my_source -> { aggregate: rows is count() }`.',
  });
}

/**
 * `run` is a statement keyword, so a `run:` token that is not inside a comment or
 * a string is always a statement, wherever on the line it happens to sit. Two of
 * them on one line is as much a stacked probe as two on separate lines.
 */
const RUN_STATEMENT = /\brun\s*:/g;

const NAMED_QUERY = /\bquery\s*:\s*(`[^`]+`|[A-Za-z_]\w*)/;

function declaresSource(document: string): boolean {
  return /(^|\n)\s*source\s*:/.test(withoutCommentsOrStrings(document));
}

/**
 * The document with everything that is not code blanked out: block comments,
 * comments to end of line (`//` and `--`), annotations and doc strings (`#`), and
 * string literals. Malloy's own parser would be the obvious way to find the
 * statements instead, but its symbol walker returns nothing at all for a query
 * containing a `nest:`, which would refuse a perfectly good probe.
 *
 * Blanked rather than deleted, so that nothing written on two lines is joined
 * into a token nobody wrote.
 */
function withoutCommentsOrStrings(document: string): string {
  let code = '';
  let index = 0;

  while (index < document.length) {
    const character = document[index] as string;
    const pair = document.slice(index, index + 2);
    let end: number;

    if (pair === '/*') {
      const close = document.indexOf('*/', index + 2);
      end = close === -1 ? document.length : close + 2;
    } else if (pair === '//' || pair === '--' || character === '#') {
      const newline = document.indexOf('\n', index);
      end = newline === -1 ? document.length : newline;
    } else if (character === "'" || character === '"') {
      end = endOfString(document, index);
    } else {
      code += character;
      index += 1;
      continue;
    }

    code += document.slice(index, end).replace(/[^\n]/g, ' ');
    index = end;
  }

  return code;
}

/** Just past the closing quote, or the end of an unterminated string. */
function endOfString(document: string, start: number): number {
  const quote = document[start];
  for (let index = start + 1; index < document.length; index += 1) {
    if (document[index] === '\\') {
      index += 1;
      continue;
    }
    if (document[index] === quote) return index + 1;
  }
  return document.length;
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
