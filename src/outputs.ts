import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, parse, resolve, sep } from 'node:path';
import { fail, keys, record } from './diagnostics.js';

const inventoryName = '.pom-manifest.json';
const lockName = '.pom-lock';
type Files = Readonly<Record<string, string>>;
type Inventory = {
  version: 1;
  generator: '@pomegranate/compiler';
  files: Record<string, string>;
};
type Existing = { content: string; hash: string } | undefined;
const hash = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

async function existingFile(path: string): Promise<Existing> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      fail(
        path,
        'output must be a regular file; symbolic links and directories are protected',
      );
    const bytes = await readFile(path);
    return { content: bytes.toString('utf8'), hash: hash(bytes) };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
}

async function safeDirectory(path: string): Promise<void> {
  const root = parse(path).root;
  // Walk exactly the path the filesystem will resolve. On POSIX a backslash is
  // part of a filename; treating it as a separator could skip a real symlink.
  const segments = path.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        fail(
          current,
          'output paths must contain only directories, without symbolic links',
        );
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return;
      throw error;
    }
  }
}

function filename(name: string): void {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.ts$/.test(name))
    fail(
      'output inventory',
      `unsafe generated filename ${JSON.stringify(name)}`,
    );
}

function inventory(source: string): Inventory {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    fail(inventoryName, 'invalid JSON; refusing to infer ownership');
  }
  const value = record(parsed, inventoryName);
  keys(value, ['version', 'generator', 'files'], inventoryName);
  if (value.version !== 1 || value.generator !== '@pomegranate/compiler')
    fail(inventoryName, 'unsupported ownership inventory');
  const files = record(value.files, `${inventoryName}.files`);
  for (const [name, digest] of Object.entries(files)) {
    filename(name);
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
      fail(`${inventoryName}.files.${name}`, 'expected a SHA-256 content hash');
  }
  return {
    version: 1,
    generator: '@pomegranate/compiler',
    files: files as Record<string, string>,
  };
}

export type OutputResult = Readonly<{
  output: string;
  clean: boolean;
  changes: readonly string[];
}>;

/** An inventory is an ownership claim, not permission to overwrite edited files. */
export async function synchronizeOutputs(
  output: string,
  expected: Files,
  inputs: readonly string[],
  check: boolean,
): Promise<OutputResult> {
  const root = resolve(output);
  await safeDirectory(root);
  for (const name of Object.keys(expected)) filename(name);
  const protectedInputs = new Set(
    await Promise.all(inputs.map((input) => realpath(input))),
  );
  const inspect = async () => {
    const manifest = await existingFile(join(root, inventoryName));
    const previous = manifest ? inventory(manifest.content) : undefined;
    const names = [
      ...new Set([
        ...Object.keys(previous?.files ?? {}),
        ...Object.keys(expected),
      ]),
    ].sort();
    const snapshots = new Map<string, Existing>();
    const conflicts: string[] = [];
    const changes: string[] = [];
    for (const name of [...names, inventoryName]) {
      const target = join(root, name);
      if (protectedInputs.has(target))
        fail(target, 'generated output overlaps a protected input');
      const current =
        name === inventoryName ? manifest : await existingFile(target);
      if (current && protectedInputs.has(await realpath(target)))
        fail(target, 'generated output aliases a protected input');
      snapshots.set(name, current);
      if (name === inventoryName) continue;
      const oldHash = previous?.files[name];
      if (current && oldHash === undefined)
        conflicts.push(`unowned output: ${name}`);
      else if (current && current.hash !== oldHash)
        conflicts.push(`modified owned output: ${name}`);
      if (Object.hasOwn(expected, name)) {
        if (current?.content !== expected[name])
          changes.push(`${current ? 'changed' : 'missing'}: ${name}`);
      } else if (current) changes.push(`stale: ${name}`);
    }
    const next: Inventory = {
      version: 1,
      generator: '@pomegranate/compiler',
      files: Object.fromEntries(
        Object.keys(expected)
          .sort()
          .map((name) => [name, hash(expected[name]!)]),
      ),
    };
    const nextManifest = `${JSON.stringify(next, null, 2)}\n`;
    if (manifest?.content !== nextManifest)
      changes.push(`changed: ${inventoryName}`);
    return { snapshots, changes, conflicts, nextManifest };
  };
  if (check) {
    const state = await inspect();
    const changes = [...state.conflicts, ...state.changes];
    return { output: root, clean: changes.length === 0, changes };
  }
  // Rendering precedes this function. The per-output lock coordinates POM
  // writers; preflight protects all outputs before the first replacement.
  await mkdir(root, { recursive: true });
  try {
    await mkdir(join(root, lockName));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      fail(
        root,
        `output is locked (${lockName}); another generation may be running`,
      );
    throw error;
  }
  let stage: string | undefined;
  try {
    await safeDirectory(root);
    const state = await inspect();
    if (state.conflicts.length)
      fail(
        root,
        `refusing to replace protected files: ${state.conflicts.join('; ')}`,
      );
    if (state.changes.length === 0)
      return { output: root, clean: true, changes: [] };
    stage = await mkdtemp(join(root, '.pom-stage-'));
    for (const [name, source] of Object.entries(expected))
      await writeFile(join(stage, name), source, 'utf8');
    await writeFile(join(stage, inventoryName), state.nextManifest, 'utf8');
    // A second snapshot catches cooperative edits made while files were staged.
    for (const [name, snapshot] of state.snapshots) {
      if ((await existingFile(join(root, name)))?.hash !== snapshot?.hash)
        fail(
          join(root, name),
          'output changed during generation; refusing to overwrite it',
        );
    }
    for (const [name, source] of Object.entries(expected)) {
      if (state.snapshots.get(name)?.content !== source)
        await rename(join(stage, name), join(root, name));
    }
    for (const name of state.snapshots.keys()) {
      if (
        name !== inventoryName &&
        !Object.hasOwn(expected, name) &&
        state.snapshots.get(name)
      )
        await rm(join(root, name));
    }
    await rename(join(stage, inventoryName), join(root, inventoryName));
    return { output: root, clean: false, changes: state.changes };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rm(join(root, lockName), { recursive: true });
  }
}
