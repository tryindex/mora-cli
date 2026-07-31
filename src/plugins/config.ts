import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isMap, isScalar, isSeq, parseDocument, type Scalar, type YAMLSeq } from 'yaml';
import { type MoraConfig, type PluginEntry, parseConfig } from '../config.js';
import { CONFIG_FILENAME } from '../scaffold.js';

/** The one line in mora.yaml that belongs to this command rather than the team. */
const PLUGINS_COMMENT = ' Integrations added with `mora plugin add`.';

/**
 * Records a plugin in mora.yaml. The file is edited as a document rather than
 * re-rendered, so the comments and layout a team put there survive a command
 * that only means to add a line.
 */
export async function recordPlugin(config: MoraConfig, entry: PluginEntry): Promise<void> {
  const configPath = path.join(config.root, CONFIG_FILENAME);
  const document = parseDocument(await readFile(configPath, 'utf8'));

  if (!isSeq(document.get('plugins'))) {
    // The comment goes on the key, not the value: on a value node it is rendered
    // inside the list, under the name it is meant to introduce.
    const key = document.createNode('plugins') as Scalar;
    key.commentBefore = PLUGINS_COMMENT;
    document.set(key, document.createNode([]));
  }

  const plugins = document.get('plugins') as YAMLSeq;
  if (indexOfPlugin(plugins, entry.name) !== -1) return;

  plugins.add(
    entry.package === undefined
      ? document.createNode(entry.name)
      : document.createNode({ name: entry.name, package: entry.package, version: entry.version }),
  );

  await writeConfig(configPath, config.root, document.toString());
}

/** Removes a plugin from mora.yaml, dropping the list when it was the last one. */
export async function forgetPlugin(config: MoraConfig, name: string): Promise<void> {
  const configPath = path.join(config.root, CONFIG_FILENAME);
  const document = parseDocument(await readFile(configPath, 'utf8'));

  const plugins = document.get('plugins');
  if (!isSeq(plugins)) return;

  const index = indexOfPlugin(plugins, name);
  if (index === -1) return;

  plugins.delete(index);

  // An empty `plugins: []` says nothing a missing key does not, and leaving it
  // behind makes a project look like it still has an integration.
  const dropped = plugins.items.length === 0;
  if (dropped) {
    document.delete('plugins');
  }

  await writeConfig(
    configPath,
    config.root,
    dropped ? withoutPluginsComment(document.toString()) : document.toString(),
  );
}

/**
 * Drops the comment that introduced `plugins:` once the key is gone. It has to be
 * done on the text: a re-parsed file attaches that comment to whatever precedes
 * it, so deleting the key leaves the line behind, dangling and re-indented under
 * an unrelated block. Only the exact line Mora writes is removed; a comment
 * someone else put there is theirs.
 */
function withoutPluginsComment(contents: string): string {
  const marker = `#${PLUGINS_COMMENT}`.trim();
  return contents
    .split('\n')
    .filter((line) => line.trim() !== marker)
    .join('\n');
}

async function writeConfig(configPath: string, root: string, contents: string): Promise<void> {
  // Parsing before writing: a config Mora cannot read back is worse than a
  // command that refused, because every later command would fail instead.
  parseConfig(contents, root);
  await writeFile(configPath, contents, 'utf8');
}

function indexOfPlugin(plugins: YAMLSeq, name: string): number {
  return plugins.items.findIndex((item) => pluginName(item) === name);
}

function pluginName(item: unknown): string | undefined {
  if (isScalar(item)) return typeof item.value === 'string' ? item.value.trim() : undefined;
  if (isMap(item)) {
    const value = item.get('name');
    return typeof value === 'string' ? value.trim() : undefined;
  }
  return undefined;
}
