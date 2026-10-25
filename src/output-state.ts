import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, parse, sep } from 'node:path';
import { fail, keys, record } from './diagnostics.js';

export const inventoryName = '.pom-manifest.json';
export const journalName = '.pom-journal.json';
export const lockName = '.pom-lock';
// Ownership files use a fixed protocol identifier, independent of the npm name.
// Registry renames must not change which output inventory or journal POM owns.
const generator = '@pomegranate/compiler';
export type Files = Readonly<Record<string, string>>;
export type Existing = { content: string; hash: string } | undefined;
type Inventory = {
  version: 1;
  generator: typeof generator;
  files: Record<string, string>;
};
export type OutputPlan = {
  snapshots: Map<string, Existing>;
  changes: string[];
  conflicts: string[];
  nextManifest: string;
};
export type Journal = {
  version: 1;
  generator: typeof generator;
  previousManifest: string | null;
  nextManifest: string;
  before: Record<string, string | null>;
  files: Files;
};
export const hash = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');
export const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

export async function existingFile(path: string): Promise<Existing> {
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
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export async function safeDirectory(path: string): Promise<void> {
  const root = parse(path).root;
  // POSIX backslashes are filename data; walk the path the OS actually resolves.
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
      if (hasCode(error, 'ENOENT')) return;
      throw error;
    }
  }
}

export function filenames(names: readonly string[]): void {
  const aliases = new Map<string, string>();
  for (const name of names) {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.ts$/.test(name))
      fail(
        'output inventory',
        `unsafe generated filename ${JSON.stringify(name)}`,
      );
    const key = name.toLowerCase();
    const previous = aliases.get(key);
    if (previous !== undefined && previous !== name)
      fail(
        'output inventory',
        `case-insensitive filename collision: ${JSON.stringify(previous)} and ${JSON.stringify(name)}`,
      );
    aliases.set(key, name);
  }
}

function json(source: string, location: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    fail(location, 'invalid JSON; refusing to infer ownership');
  }
  return record(parsed, location);
}

function inventory(source: string): Inventory {
  const value = json(source, inventoryName);
  keys(value, ['version', 'generator', 'files'], inventoryName);
  if (value.version !== 1 || value.generator !== generator)
    fail(inventoryName, 'unsupported ownership inventory');
  const files = record(value.files, `${inventoryName}.files`);
  filenames(Object.keys(files));
  const entries = Object.entries(files).map(
    ([name, digest]): [string, string] => {
      if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest))
        fail(
          `${inventoryName}.files.${name}`,
          'expected a SHA-256 content hash',
        );
      return [name, digest];
    },
  );
  return {
    version: 1,
    generator,
    files: Object.fromEntries(entries),
  };
}

export function manifest(files: Files): string {
  return (
    JSON.stringify(
      {
        version: 1,
        generator,
        files: Object.fromEntries(
          Object.keys(files)
            .sort()
            .map((name) => [name, hash(files[name]!)]),
        ),
      },
      null,
      2,
    ) + '\n'
  );
}

export async function snapshot(
  root: string,
  name: string,
  inputs: ReadonlySet<string>,
): Promise<Existing> {
  const target = join(root, name);
  if (inputs.has(target))
    fail(target, 'generated output overlaps a protected input');
  const current = await existingFile(target);
  if (current && inputs.has(await realpath(target)))
    fail(target, 'generated output aliases a protected input');
  return current;
}

export async function inspectOutputs(
  root: string,
  expected: Files,
  inputs: ReadonlySet<string>,
): Promise<OutputPlan> {
  const previous = await snapshot(root, inventoryName, inputs);
  const owned = previous ? inventory(previous.content).files : {};
  const names = [
    ...new Set([...Object.keys(owned), ...Object.keys(expected)]),
  ].sort();
  filenames(names);
  const snapshots = new Map<string, Existing>([[inventoryName, previous]]);
  const conflicts: string[] = [];
  const changes: string[] = [];
  for (const name of names) {
    const current = await snapshot(root, name, inputs);
    snapshots.set(name, current);
    if (current && owned[name] === undefined)
      conflicts.push(`unowned output: ${name}`);
    else if (current && current.hash !== owned[name])
      conflicts.push(`modified owned output: ${name}`);
    if (Object.hasOwn(expected, name)) {
      if (current?.content !== expected[name])
        changes.push(`${current ? 'changed' : 'missing'}: ${name}`);
    } else if (current) changes.push(`stale: ${name}`);
  }
  const nextManifest = manifest(expected);
  if (previous?.content !== nextManifest)
    changes.push(`changed: ${inventoryName}`);
  return { snapshots, conflicts, changes, nextManifest };
}

export function journal(plan: OutputPlan, files: Files): Journal {
  return {
    version: 1,
    generator,
    previousManifest: plan.snapshots.get(inventoryName)?.content ?? null,
    nextManifest: plan.nextManifest,
    before: Object.fromEntries(
      [...plan.snapshots]
        .filter(([name]) => name !== inventoryName && name !== journalName)
        .map(([name, value]) => [name, value?.hash ?? null]),
    ),
    files,
  };
}

export function readJournal(source: string): Journal {
  const value = json(source, journalName);
  keys(
    value,
    [
      'version',
      'generator',
      'previousManifest',
      'nextManifest',
      'before',
      'files',
    ],
    journalName,
  );
  if (value.version !== 1 || value.generator !== generator)
    fail(journalName, 'unsupported recovery journal');
  if (
    value.previousManifest !== null &&
    typeof value.previousManifest !== 'string'
  )
    fail(journalName, 'invalid previous manifest');
  const owned =
    value.previousManifest === null
      ? {}
      : inventory(value.previousManifest).files;
  const rawFiles = record(value.files, `${journalName}.files`);
  const files = Object.fromEntries(
    Object.entries(rawFiles).map(([name, content]): [string, string] => {
      if (typeof content !== 'string')
        fail(`${journalName}.files.${name}`, 'expected generated source');
      return [name, content];
    }),
  );
  // Detect edited or damaged recovery payloads independently of current target
  // files, including payloads that had not reached their target before failure.
  if (value.nextManifest !== manifest(files))
    fail(journalName, 'intended output hashes do not match journal contents');
  const names = [
    ...new Set([...Object.keys(owned), ...Object.keys(files)]),
  ].sort();
  filenames(names);
  const before = record(value.before, `${journalName}.before`);
  if (
    Object.keys(before).length !== names.length ||
    names.some((name) => !Object.hasOwn(before, name))
  )
    fail(journalName, 'recovery inventory does not match its files');
  const entries = names.map((name): [string, string | null] => {
    const digest = before[name];
    // A journal can record a missing owned file, but cannot retroactively claim
    // an existing unowned file. Its old hashes must agree with the inventory.
    if (
      digest !== null &&
      (typeof digest !== 'string' || digest !== owned[name])
    )
      fail(journalName, `invalid prior ownership for ${name}`);
    return [name, digest];
  });
  return {
    version: 1,
    generator,
    previousManifest: value.previousManifest,
    nextManifest: value.nextManifest,
    before: Object.fromEntries(entries),
    files,
  };
}

export async function inspectRecovery(
  root: string,
  pending: Journal,
  currentJournal: NonNullable<Existing>,
  inputs: ReadonlySet<string>,
): Promise<OutputPlan> {
  const snapshots = new Map<string, Existing>([[journalName, currentJournal]]);
  const nextManifest = manifest(pending.files);
  const previous = await snapshot(root, inventoryName, inputs);
  const priorHash =
    pending.previousManifest === null
      ? undefined
      : hash(pending.previousManifest);
  if (previous?.hash !== priorHash && previous?.hash !== hash(nextManifest))
    fail(
      inventoryName,
      'manifest changed during interrupted generation; preserving recovery files',
    );
  snapshots.set(inventoryName, previous);
  for (const [name, oldHash] of Object.entries(pending.before)) {
    const current = await snapshot(root, name, inputs);
    const nextHash = Object.hasOwn(pending.files, name)
      ? hash(pending.files[name]!)
      : undefined;
    if (current?.hash !== (oldHash ?? undefined) && current?.hash !== nextHash)
      fail(
        join(root, name),
        'recovery conflict: output matches neither its prior nor intended contents',
      );
    snapshots.set(name, current);
  }
  return {
    snapshots,
    nextManifest,
    conflicts: [],
    changes: ['recovered interrupted generation'],
  };
}
