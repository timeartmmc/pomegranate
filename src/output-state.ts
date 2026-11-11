import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';
import { generatedBanner } from './code.js';
import { ContractError, fail, keys, record } from './diagnostics.js';

export const inventoryName = '.pom-manifest.json';
export const lockName = '.pom-lock';
// Ownership files use a fixed protocol identifier, independent of the npm name.
// Registry renames must not change which output inventory POM owns.
const generator = '@pomegranate/compiler';
export type Files = Readonly<Record<string, string>>;
export type Existing = { content: string; hash: string } | undefined;
export type OutputPlan = {
  snapshots: Map<string, Existing>;
  changes: string[];
  conflicts: string[];
  removals: string[];
  warnings: OutputWarning[];
  nextManifest: string;
};
export type OutputWarning = Readonly<{
  code:
    | 'modified-output'
    | 'preserved-stale-output'
    | 'recovered-manifest'
    | 'recovered-output';
  path: string;
  message: string;
}>;
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

export async function outputDirectory(output: string): Promise<string> {
  const absolute = resolve(output);
  const suffix = [basename(absolute)];
  let parent = dirname(absolute);
  // A configured parent alias (such as macOS /tmp) selects the output's real
  // location once. Keep that canonical path for every subsequent operation;
  // the output directory itself and its owned files must still not be links.
  while (true) {
    try {
      const root = join(await realpath(parent), ...suffix);
      await safeDirectory(root);
      return root;
    } catch (error) {
      if (!hasCode(error, 'ENOENT') || dirname(parent) === parent) throw error;
      suffix.unshift(basename(parent));
      parent = dirname(parent);
    }
  }
}

const filename = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.ts$/;

export function filenames(names: readonly string[]): void {
  const aliases = new Map<string, string>();
  for (const name of names) {
    if (!filename.test(name))
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

function inventory(source: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    fail(inventoryName, 'invalid JSON');
  }
  const value = record(parsed, inventoryName);
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
  return Object.fromEntries(entries);
}

function manifest(hashes: Readonly<Record<string, string>>): string {
  return (
    JSON.stringify(
      {
        version: 1,
        generator,
        files: Object.fromEntries(
          Object.keys(hashes)
            .sort()
            .map((name) => [name, hashes[name]!]),
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
  let owned: Record<string, string> = {};
  let recovering = previous === undefined;
  if (previous) {
    try {
      owned = inventory(previous.content);
    } catch (error) {
      // Corrupt metadata supplies no ownership. Unsafe filename claims still
      // fail explicitly instead of bypassing the path and case checks.
      if (
        !(error instanceof ContractError) ||
        error.location === 'output inventory'
      )
        throw error;
      recovering = true;
    }
  }
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (hasCode(error, 'ENOENT')) return [];
      throw error;
    },
  );
  const names = new Set([...Object.keys(owned), ...Object.keys(expected)]);
  filenames([
    ...names,
    ...entries.map((entry) => entry.name).filter((name) => filename.test(name)),
  ]);
  for (const entry of entries) {
    if (!entry.isFile() || !filename.test(entry.name) || names.has(entry.name))
      continue;
    const current = await existingFile(join(root, entry.name));
    if (current?.content.startsWith(generatedBanner)) names.add(entry.name);
  }
  const snapshots = new Map<string, Existing>([[inventoryName, previous]]);
  const conflicts: string[] = [];
  const changes: string[] = [];
  const removals: string[] = [];
  const warnings: OutputWarning[] = [];
  const warn = (code: OutputWarning['code'], name: string, message: string) =>
    warnings.push({ code, path: join(root, name), message });
  if (
    recovering &&
    (previous || entries.some((entry) => names.has(entry.name)))
  )
    warn(
      'recovered-manifest',
      inventoryName,
      `${previous ? 'invalid' : 'missing'} manifest; recovering ownership only from the exact POM banner; uncertain stale files will be preserved`,
    );
  const hashes = Object.fromEntries(
    Object.entries(expected).map(([name, content]) => [name, hash(content)]),
  );
  for (const name of [...names].sort()) {
    const current = await snapshot(root, name, inputs);
    snapshots.set(name, current);
    const recorded = owned[name];
    if (Object.hasOwn(expected, name)) {
      if (current && recorded === undefined) {
        if (!current.content.startsWith(generatedBanner))
          conflicts.push(`unowned output: ${name}`);
        else
          warn(
            'recovered-output',
            name,
            current.content === expected[name]
              ? 'recovering output ownership from the exact POM banner'
              : 'overwriting output recovered from the exact POM banner; its prior hash is unavailable',
          );
      } else if (current && current.hash !== recorded) {
        changes.push(`modified owned output: ${name}`);
        warn(
          'modified-output',
          name,
          current.content === expected[name]
            ? 'updating the recorded hash of a modified owned output that matches the rendered output'
            : 'overwriting modified owned output',
        );
      }
      if (current?.content !== expected[name])
        changes.push(`${current ? 'changed' : 'missing'}: ${name}`);
    } else if (current) {
      changes.push(`stale: ${name}`);
      if (current.hash === recorded) removals.push(name);
      else {
        warn(
          'preserved-stale-output',
          name,
          recorded === undefined
            ? 'preserving stale output with uncertain ownership'
            : 'preserving modified stale output',
        );
        // Retain the original hash, never the edit's hash. A later run must not
        // mistake a preserved edit for unchanged, disposable generated content.
        if (recorded !== undefined) hashes[name] = recorded;
      }
    }
  }
  const nextManifest = manifest(hashes);
  if (previous?.content !== nextManifest)
    changes.push(`changed: ${inventoryName}`);
  return { snapshots, conflicts, changes, removals, warnings, nextManifest };
}
