import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMap, parseDocument, type Scalar, type YAMLMap } from 'yaml';
import { type MoraConfig, parseConfig } from './config.js';
import type { DatabaseId } from './databases.js';
import { collectEnvVars, ENV_EXAMPLE_FILENAME } from './env.js';
import { ExitCode, MoraError } from './errors.js';
import { CONFIG_FILENAME } from './scaffold.js';
import { renderEnvExample } from './templates/env.js';

export interface NewConnection {
  name: string;
  type: DatabaseId;
  /** Settings as they should be written, `${VAR}` references included. */
  settings: Record<string, string>;
  /** Notes to write above individual settings, keyed by setting. */
  comments?: Record<string, string>;
  /** Make this the connection models fall back to. */
  makeDefault: boolean;
}

/** A name that reads as an identifier in a model: `warehouse.table('...')`. */
const CONNECTION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertConnectionName(name: string): void {
  if (CONNECTION_NAME_PATTERN.test(name) && name !== 'default') return;
  throw new MoraError(`"${name}" cannot be used as a connection name.`, {
    code: 'invalid-connection-name',
    exitCode: ExitCode.usage,
    hint: 'Models refer to a connection by name, so it must start with a letter or underscore and contain only letters, digits and underscores. `default` is reserved.',
  });
}

/**
 * Adds a connection to an existing mora.yaml. The file is edited as a document
 * rather than re-rendered, so the comments and layout a team put there survive
 * a command that only means to add ten lines.
 */
export async function addConnection(
  config: MoraConfig,
  connection: NewConnection,
): Promise<{ configPath: string; contents: string }> {
  assertConnectionName(connection.name);

  const configPath = path.join(config.root, CONFIG_FILENAME);
  const document = parseDocument(await readFile(configPath, 'utf8'));

  if (!isMap(document.get('connections'))) {
    // A project with no connections block at all: give it one rather than
    // failing, since the alternative is asking the reader to hand-edit YAML.
    document.set('connections', document.createNode({}));
  }
  const connections = document.get('connections') as YAMLMap;

  if (connections.has(connection.name)) {
    throw new MoraError(
      `${CONFIG_FILENAME} already has a connection called "${connection.name}".`,
      {
        code: 'connection-exists',
        exitCode: ExitCode.usage,
        hint: 'Pick another name, or edit the existing block by hand.',
      },
    );
  }

  const block = document.createNode({
    type: connection.type,
    ...connection.settings,
  }) as YAMLMap<Scalar, unknown>;
  for (const [key, comment] of Object.entries(connection.comments ?? {})) {
    const item = block.items.find((entry) => entry.key.value === key);
    if (item) item.key.commentBefore = ` ${comment}`;
  }

  const key = document.createNode(connection.name) as Scalar;
  // On the key, not the block: a comment on the value node is rendered inside
  // it, under the name it is meant to introduce.
  key.commentBefore = ` Added by \`mora connection add\`.`;
  connections.set(key, block);
  if (connection.makeDefault) {
    connections.set(document.createNode('default'), connection.name);
  }

  const contents = document.toString();
  // Parsing before writing: a config Mora cannot read back is worse than a
  // command that refused, because every later command would fail instead.
  parseConfig(contents, config.root);
  await writeFile(configPath, contents, 'utf8');

  return { configPath: CONFIG_FILENAME, contents };
}

export interface EnvExampleUpdate {
  path: string;
  action: 'created' | 'updated' | 'unchanged';
  /** Variables this run added to the file. */
  added: string[];
}

/**
 * Records any new `${VAR}` references in `.env.example`, which is the committed
 * list of what a checkout needs. Existing lines are left alone: they may carry a
 * comment or an example value someone wrote deliberately.
 */
export async function syncEnvExample(
  root: string,
  projectName: string,
  contents: string,
): Promise<EnvExampleUpdate> {
  const required = collectEnvVars(parseDocument(contents).toJS());
  const target = path.join(root, ENV_EXAMPLE_FILENAME);

  if (required.length === 0) {
    return { path: ENV_EXAMPLE_FILENAME, action: 'unchanged', added: [] };
  }

  if (!existsSync(target)) {
    await writeFile(target, renderEnvExample({ projectName, variables: required }), 'utf8');
    return { path: ENV_EXAMPLE_FILENAME, action: 'created', added: required };
  }

  const current = await readFile(target, 'utf8');
  const declared = new Set(
    current
      .split('\n')
      .map((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined),
  );

  const added = required.filter((name) => !declared.has(name));
  if (added.length === 0) {
    return { path: ENV_EXAMPLE_FILENAME, action: 'unchanged', added: [] };
  }

  const appended = `${current.trimEnd()}\n${added.map((name) => `${name}=`).join('\n')}\n`;
  await writeFile(target, appended, 'utf8');
  return { path: ENV_EXAMPLE_FILENAME, action: 'updated', added };
}
