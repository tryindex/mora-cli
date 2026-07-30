import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type Document, isMap, parseDocument } from 'yaml';
import { parseConfig, SUPPORTED_CONFIG_VERSION } from './config.js';
import { MoraError } from './errors.js';
import { CONFIG_FILENAME } from './scaffold.js';

export interface Migration {
  /** Config schema version this migration produces. */
  toVersion: number;
  /** Stable id for reports and --json. */
  id: string;
  apply: (document: Document) => void;
}

/**
 * Ordered migrations keyed on the config schema `version` field. Empty today:
 * projects already on version 1 need no rewrite. When a future Mora release
 * changes the shape of mora.yaml, add a step here rather than asking teams to
 * hand-edit.
 */
export const MIGRATIONS: Migration[] = [];

export interface ConfigUpgradeResult {
  /** Schema version before any migration ran. */
  fromVersion: number;
  /** Schema version after migrations (and what Mora supports today). */
  toVersion: number;
  /** Migration ids that ran. */
  applied: string[];
  /** Whether mora.yaml contents changed for any reason (migration or stamp). */
  changed: boolean;
  /** Previous cli_version stamp, if any. */
  previousCliVersion: string | undefined;
}

/**
 * Applies pending schema migrations and writes the running CLI version into
 * `cli_version`. Edited as a YAML document so comments and ordering survive.
 */
export async function upgradeConfigFile(
  root: string,
  cliVersion: string,
): Promise<ConfigUpgradeResult> {
  const configPath = path.join(root, CONFIG_FILENAME);
  const original = await readFile(configPath, 'utf8');
  const document = parseDocument(original);

  const fromVersion = readSchemaVersion(document);
  const applied: string[] = [];
  let version = fromVersion;

  for (const migration of MIGRATIONS) {
    if (migration.toVersion <= version) continue;
    migration.apply(document);
    document.set('version', migration.toVersion);
    version = migration.toVersion;
    applied.push(migration.id);
  }

  if (version > SUPPORTED_CONFIG_VERSION) {
    throw new MoraError(
      `${CONFIG_FILENAME} reached version ${version}, which this Mora cannot read.`,
      {
        code: 'unsupported-config-version',
        hint: "This is a bug in Mora's migrations. Please report it.",
      },
    );
  }

  const previousCliVersion = readCliVersion(document);
  const stampChanged = previousCliVersion !== cliVersion;
  if (stampChanged) {
    document.set('cli_version', cliVersion);
  }

  // Avoid re-serializing when nothing logical changed: yaml's toString() can
  // reshuffle whitespace even for an identical document, and a no-op upgrade
  // must leave mora.yaml byte-identical.
  const changed = applied.length > 0 || stampChanged;
  if (changed) {
    const contents = document.toString();
    parseConfig(contents, root);
    await writeFile(configPath, contents, 'utf8');
  }

  return {
    fromVersion,
    toVersion: version,
    applied,
    changed,
    previousCliVersion,
  };
}

/** Schema migrations still waiting to run for a config at the given version. */
export function pendingMigrations(fromVersion: number): Migration[] {
  return MIGRATIONS.filter((migration) => migration.toVersion > fromVersion);
}

function readSchemaVersion(document: Document): number {
  const value = document.get('version');
  if (value === undefined || value === null) return 1;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw new MoraError(`${CONFIG_FILENAME} has an invalid \`version\`.`, {
    code: 'invalid-config',
  });
}

function readCliVersion(document: Document): string | undefined {
  if (!isMap(document.contents)) return undefined;
  const value = document.get('cli_version');
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : String(value);
}
