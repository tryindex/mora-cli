import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export const ENV_FILENAME = '.env';
export const ENV_EXAMPLE_FILENAME = '.env.example';

const ENV_VAR_REFERENCE = /\$\{(\w+)\}/g;

/**
 * Every `${VAR}` a parsed config refers to, sorted and deduplicated. Walking the
 * parsed document rather than the file text means commented-out connection
 * blocks are excluded without having to reason about YAML comments, and any
 * variable a team adds by hand is picked up for free.
 */
export function collectEnvVars(value: unknown): string[] {
  const names = new Set<string>();

  function walk(node: unknown): void {
    if (typeof node === 'string') {
      for (const match of node.matchAll(ENV_VAR_REFERENCE)) {
        const name = match[1];
        if (name) names.add(name);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === 'object' && node !== null) {
      for (const item of Object.values(node)) walk(item);
    }
  }

  walk(value);
  return [...names].sort();
}

/** Values a `${VAR}` reference can be resolved from, in priority order. */
export interface EnvLookup {
  processEnv?: NodeJS.ProcessEnv;
  /** Values read out of the project's `.env`, used when the process has none. */
  envFile?: Record<string, string>;
}

export interface ResolvedValue {
  /** The setting with every `${VAR}` replaced, or undefined when any is unset. */
  value: string | undefined;
  /** Variables the setting refers to that have no value anywhere. */
  missing: string[];
}

/**
 * Substitutes `${VAR}` references in a single setting. The process environment
 * wins over the project `.env`, so a shell or CI can override a checked-out
 * default without editing files. A setting with any unset variable resolves to
 * nothing rather than to a half-interpolated string, which would otherwise
 * reach a driver as a nonsense project id or path.
 */
export function resolveEnvRefs(setting: string | undefined, lookup: EnvLookup = {}): ResolvedValue {
  if (setting === undefined) return { value: undefined, missing: [] };

  const { processEnv = process.env, envFile = {} } = lookup;
  const missing: string[] = [];

  const value = setting.replace(ENV_VAR_REFERENCE, (_match, name: string) => {
    const found = firstSet(processEnv[name], envFile[name]);
    if (found === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return '';
    }
    return found;
  });

  return { value: missing.length > 0 ? undefined : value, missing };
}

function firstSet(...values: (string | undefined)[]): string | undefined {
  return values.find(isSet);
}

export type EnvVarSource = 'environment' | 'env-file';

export interface EnvVarStatus {
  name: string;
  set: boolean;
  /** Where the value came from, or null when it is still missing. */
  source: EnvVarSource | null;
}

export interface EnvironmentReport {
  /** The env file consulted, relative to the project root. */
  envFile: string;
  required: EnvVarStatus[];
  missing: string[];
}

/**
 * Reads a `.env` file into a plain object. Values are only ever inspected, never
 * merged into `process.env`: Mora reports on credentials, so a project's file
 * should not silently change how anything else in the process behaves.
 */
export async function readEnvFile(absolutePath: string): Promise<Record<string, string>> {
  if (!existsSync(absolutePath)) return {};

  const contents = await readFile(absolutePath, 'utf8');
  const values: Record<string, string> = {};

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator <= 0) continue;

    const key = line
      .slice(0, separator)
      .replace(/^export\s+/, '')
      .trim();
    if (key.length === 0) continue;

    values[key] = unquote(line.slice(separator + 1).trim());
  }

  return values;
}

export function describeEnvironment(
  required: readonly string[],
  envFileValues: Record<string, string>,
  processEnv: NodeJS.ProcessEnv = process.env,
): EnvironmentReport {
  const statuses = required.map<EnvVarStatus>((name) => {
    if (isSet(processEnv[name])) return { name, set: true, source: 'environment' };
    if (isSet(envFileValues[name])) return { name, set: true, source: 'env-file' };
    return { name, set: false, source: null };
  });

  return {
    envFile: ENV_FILENAME,
    required: statuses,
    missing: statuses.filter((status) => !status.set).map((status) => status.name),
  };
}

/** A placeholder copied from `.env.example` is still an empty value, not a credential. */
function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function unquote(value: string): string {
  const quoted = /^(['"])(.*)\1$/s.exec(value);
  return quoted?.[2] ?? value;
}
