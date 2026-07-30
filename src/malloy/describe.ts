import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Explore, Model, Runtime } from '@malloydata/malloy';
import { ExitCode, MoraError } from '../errors.js';
import type { RuntimeRequest } from './runtime.js';
import { describeError, openRuntime } from './runtime.js';

export interface FieldDescription {
  name: string;
  /** Data type for fields, join relationship for joins, `view` for views. */
  type: string;
}

export interface SourceDescription {
  name: string;
  /** Model file the source is declared in, relative to the project root. */
  model: string;
  dimensions: FieldDescription[];
  measures: FieldDescription[];
  views: FieldDescription[];
  joins: FieldDescription[];
}

export interface QueryDescription {
  name: string;
  model: string;
}

export interface ModelFailure {
  model: string;
  error: string;
}

export interface Vocabulary {
  sources: SourceDescription[];
  /** Top-level `query:` declarations, which can be run by name. */
  queries: QueryDescription[];
  /** Models that did not compile. Described projects degrade rather than die. */
  failures: ModelFailure[];
}

export interface DescribeRequest extends RuntimeRequest {
  /** Absolute project root, which model paths are relative to. */
  root: string;
  /** Model files to read, relative to the root. */
  modelPaths: readonly string[];
}

/**
 * Reads the vocabulary out of every model in the project. This is the same walk
 * `mora describe` prints and `mora query` resolves names against, so a name that
 * shows up in one is runnable by the other.
 */
export async function describeProject(request: DescribeRequest): Promise<Vocabulary> {
  const opened = await openRuntime(request);
  try {
    return await describeModels(opened.runtime, request.root, request.modelPaths);
  } finally {
    await opened.close();
  }
}

/**
 * The walk itself, over a runtime the caller owns. `mora query` needs both the
 * vocabulary and the runtime that produced it, and opening DuckDB twice to get
 * them would be wasteful.
 */
export async function describeModels(
  runtime: Runtime,
  root: string,
  modelPaths: readonly string[],
): Promise<Vocabulary> {
  const vocabulary: Vocabulary = { sources: [], queries: [], failures: [] };

  for (const relativePath of modelPaths) {
    let model: Model;
    try {
      model = await runtime.getModel(pathToFileURL(path.join(root, relativePath)));
    } catch (error) {
      vocabulary.failures.push({ model: relativePath, error: describeError(error) });
      continue;
    }

    for (const explore of model.explores) {
      vocabulary.sources.push(describeSource(explore, relativePath));
    }
    for (const name of model.queries().named) {
      vocabulary.queries.push({ name, model: relativePath });
    }
  }

  return vocabulary;
}

function describeSource(explore: Explore, model: string): SourceDescription {
  const source: SourceDescription = {
    name: explore.name,
    model,
    dimensions: [],
    measures: [],
    views: [],
    joins: [],
  };

  for (const field of explore.allFields) {
    if (field.isQueryField()) {
      source.views.push({ name: field.name, type: 'view' });
    } else if (field.isExploreField()) {
      source.joins.push({ name: field.name, type: field.joinRelationship });
    } else if (field.isAtomicField()) {
      const described = { name: field.name, type: field.type };
      // A calculation is an aggregate: the difference between "amount" and
      // "revenue is amount.sum()", which is the distinction that matters most
      // when an agent is choosing what to group by.
      if (field.isCalculation()) {
        source.measures.push(described);
      } else {
        source.dimensions.push(described);
      }
    }
  }

  return source;
}

/** Restricts a vocabulary to names containing `pattern`, case-insensitively. */
export function filterVocabulary(vocabulary: Vocabulary, pattern: string): Vocabulary {
  const needle = pattern.toLowerCase();
  const matches = (name: string) => name.toLowerCase().includes(needle);

  const sources: SourceDescription[] = [];
  for (const source of vocabulary.sources) {
    // A source whose own name matches is shown whole: someone asking about
    // "orders" wants the vocabulary of orders, not the one field called orders.
    if (matches(source.name)) {
      sources.push(source);
      continue;
    }

    const narrowed: SourceDescription = {
      ...source,
      dimensions: source.dimensions.filter((field) => matches(field.name)),
      measures: source.measures.filter((field) => matches(field.name)),
      views: source.views.filter((field) => matches(field.name)),
      joins: source.joins.filter((field) => matches(field.name)),
    };
    if (definitionCount(narrowed) > 0) sources.push(narrowed);
  }

  return {
    sources,
    queries: vocabulary.queries.filter((query) => matches(query.name)),
    failures: vocabulary.failures,
  };
}

export function definitionCount(source: SourceDescription): number {
  return (
    source.dimensions.length + source.measures.length + source.views.length + source.joins.length
  );
}

/** A runnable definition: either a `query:` declaration or a view on a source. */
export interface Definition {
  kind: 'query' | 'view';
  /** The name as a user would type it: `monthly_revenue` or `orders.by_month`. */
  name: string;
  model: string;
  /** Source the view belongs to, for views. */
  source?: string;
  /** View name within that source, for views. */
  view?: string;
}

/** Every name `mora query` can run, in the order it should be offered. */
export function indexDefinitions(vocabulary: Vocabulary): Definition[] {
  const definitions: Definition[] = vocabulary.queries.map((query) => ({
    kind: 'query' as const,
    name: query.name,
    model: query.model,
  }));

  for (const source of vocabulary.sources) {
    for (const view of source.views) {
      definitions.push({
        kind: 'view',
        name: `${source.name}.${view.name}`,
        model: source.model,
        source: source.name,
        view: view.name,
      });
    }
  }

  return definitions;
}

/**
 * Finds the definition a name refers to. Queries win over views on a tie,
 * because a `query:` declaration is the entry point its author intended. A bare
 * view name resolves only when one source has it; otherwise the caller is told
 * to qualify it, rather than being handed whichever one came first.
 */
export function resolveDefinition(definitions: readonly Definition[], name: string): Definition {
  const exact = definitions.filter((definition) => definition.name === name);
  if (exact.length > 0) return preferQuery(exact);

  const byView = definitions.filter(
    (definition) => definition.kind === 'view' && definition.view === name,
  );
  if (byView.length === 1) return byView[0] as Definition;

  if (byView.length > 1) {
    throw new MoraError(`"${name}" is a view on more than one source.`, {
      code: 'ambiguous-definition',
      hint: `Qualify it with the source: ${byView.map((d) => d.name).join(', ')}.`,
    });
  }

  throw new MoraError(`No definition named "${name}".`, {
    code: 'unknown-definition',
    hint:
      definitions.length === 0
        ? 'This project has no named queries or views yet. Add one, or run `mora query -e` with Malloy.'
        : `Run \`mora describe\` to see the vocabulary. Available: ${definitions
            .map((definition) => definition.name)
            .join(', ')}.`,
  });
}

function preferQuery(candidates: readonly Definition[]): Definition {
  return (
    candidates.find((definition) => definition.kind === 'query') ?? (candidates[0] as Definition)
  );
}

/** Raised when a project has nothing to describe, which is a usage problem. */
export function assertHasModels(modelPaths: readonly string[], modelsDir: string): void {
  if (modelPaths.length > 0) return;
  throw new MoraError(`No .malloy files found in ${modelsDir}/.`, {
    code: 'no-models',
    exitCode: ExitCode.failure,
    hint: `Add a model to ${modelsDir}/, or run \`mora init\` to scaffold an example.`,
  });
}
