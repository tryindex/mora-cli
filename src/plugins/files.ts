import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MANAGED_BEGIN, MANAGED_END, type ScaffoldFile } from '../scaffold.js';

/** What removal did, or refused to do, to one file a plugin owns. */
export type PluginFileAction = 'deleted' | 'kept-modified' | 'kept-by-flag' | 'missing';

export interface PluginFileRemoval {
  path: string;
  action: PluginFileAction;
}

type FileState = 'missing' | 'pristine' | 'modified';

/**
 * How each file a plugin owns compares to what the plugin would write now. A
 * file that still matches is safe to delete; one that does not carries an edit
 * someone made deliberately, and deleting it would throw away their work.
 */
export async function inspectPluginFiles(
  root: string,
  files: ScaffoldFile[],
): Promise<{ file: ScaffoldFile; state: FileState }[]> {
  const inspected: { file: ScaffoldFile; state: FileState }[] = [];

  for (const file of files) {
    const absolute = path.join(root, file.path);
    if (!existsSync(absolute)) {
      inspected.push({ file, state: 'missing' });
      continue;
    }

    // Only a whole-file `replace` can be compared as a whole. The other
    // strategies own a region of a file the project also writes to, so their
    // region is removed without asking whether the rest has changed.
    if (file.strategy !== 'replace') {
      inspected.push({ file, state: 'pristine' });
      continue;
    }

    const current = await readFile(absolute, 'utf8');
    inspected.push({ file, state: current === file.contents ? 'pristine' : 'modified' });
  }

  return inspected;
}

export interface RemoveFilesOptions {
  /** Delete even the files someone has edited since the plugin wrote them. */
  force: boolean;
  /** Leave every file in place and only stop tracking the plugin. */
  keepFiles: boolean;
}

export async function removePluginFiles(
  root: string,
  files: ScaffoldFile[],
  options: RemoveFilesOptions,
): Promise<PluginFileRemoval[]> {
  const removals: PluginFileRemoval[] = [];

  for (const { file, state } of await inspectPluginFiles(root, files)) {
    if (state === 'missing') {
      removals.push({ path: file.path, action: 'missing' });
      continue;
    }
    if (options.keepFiles) {
      removals.push({ path: file.path, action: 'kept-by-flag' });
      continue;
    }
    if (state === 'modified' && !options.force) {
      removals.push({ path: file.path, action: 'kept-modified' });
      continue;
    }

    const absolute = path.join(root, file.path);
    if (file.strategy === 'merge-lines') {
      await stripLines(absolute, file.contents.split('\n'));
    } else if (file.strategy === 'managed-block') {
      await stripManagedBlock(absolute);
    } else {
      await rm(absolute, { force: true });
    }
    removals.push({ path: file.path, action: 'deleted' });
  }

  return removals;
}

/**
 * Takes the plugin's lines back out of .gitignore, leaving every other line as
 * it is: the file is shared with the project and with whatever else Mora wrote.
 * Reports whether anything changed.
 */
export async function stripGitignoreEntries(root: string, entries: string[]): Promise<boolean> {
  if (entries.length === 0) return false;
  return stripLines(path.join(root, '.gitignore'), entries);
}

async function stripLines(absolute: string, lines: string[]): Promise<boolean> {
  if (!existsSync(absolute)) return false;

  const unwanted = new Set(lines.map((line) => line.trim()).filter((line) => line.length > 0));
  if (unwanted.size === 0) return false;

  const current = await readFile(absolute, 'utf8');
  const kept = current.split('\n').filter((line) => !unwanted.has(line.trim()));
  const updated = `${kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;

  if (updated === current) return false;
  await writeFile(absolute, updated, 'utf8');
  return true;
}

async function stripManagedBlock(absolute: string): Promise<void> {
  const current = await readFile(absolute, 'utf8');
  const start = current.indexOf(MANAGED_BEGIN);
  const end = current.indexOf(MANAGED_END);
  if (start === -1 || end <= start) return;

  const remaining = `${current.slice(0, start).trimEnd()}\n${current
    .slice(end + MANAGED_END.length)
    .trimStart()}`.trim();

  // A file that was nothing but the block has no reason to survive it.
  if (remaining.length === 0) {
    await rm(absolute, { force: true });
    return;
  }
  await writeFile(absolute, `${remaining}\n`, 'utf8');
}
