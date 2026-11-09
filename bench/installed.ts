import assert from 'node:assert/strict';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { benchmarkDirectory, record, sha256 } from './controller.ts';

type InstalledFile =
  | { path: string; sha256: string }
  | { path: string; target: string };

// The npm lock identifies resolutions, while this inventory identifies the bytes
// actually present. Ordinary .bin links are permitted only inside this tree.
async function inventory(
  root: string,
  directory = root,
  files: InstalledFile[] = [],
): Promise<InstalledFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute).split(sep).join('/');
    if (entry.isSymbolicLink()) {
      const target = relative(root, await realpath(absolute));
      assert.ok(
        !isAbsolute(target) &&
          target !== '..' &&
          !target.startsWith(`..${sep}`),
        `${path}: installed dependency link escapes its consumer`,
      );
      files.push({ path, target: target.split(sep).join('/') });
    } else if (entry.isDirectory()) await inventory(root, absolute, files);
    else {
      assert.ok(entry.isFile(), `${path}: unsupported installed entry`);
      files.push({ path, sha256: sha256(await readFile(absolute)) });
    }
  }
  return files;
}

export async function installedTree(root: string) {
  const files = await inventory(await realpath(root));
  return { files, sha256: sha256(JSON.stringify(files)) };
}

// All maintained benchmark code lives in this tree; adding a helper must not
// require updating another controller's hand-maintained source-file list.
export async function benchmarkSources(directory = benchmarkDirectory) {
  const tree = await installedTree(directory);
  for (const file of tree.files)
    assert.ok('sha256' in file, 'benchmark source files must not be links');
  return tree;
}

export async function installedIdentity(
  consumer: string,
  archiveIntegrity: string,
) {
  const installed = join(consumer, 'node_modules/pomegranate-compiler');
  assert.equal(
    await realpath(installed),
    installed,
    'compiler must be installed without a source link',
  );
  const metadata = record(
    JSON.parse(
      await readFile(join(installed, 'package.json'), 'utf8'),
    ) as unknown,
  );
  assert.equal(metadata.name, 'pomegranate-compiler');
  assert.ok(
    typeof metadata.version === 'string' && metadata.version.length > 0,
  );
  const lockBytes = await readFile(join(consumer, 'package-lock.json'));
  const lock = record(JSON.parse(lockBytes.toString('utf8')) as unknown);
  assert.equal(
    lock.lockfileVersion,
    3,
    'benchmark preparation requires an npm v3 lock',
  );
  const packages = record(lock.packages);
  const compiler = record(packages['node_modules/pomegranate-compiler']);
  assert.ok(
    compiler.resolved === 'file:compiler.tgz' ||
      compiler.resolved === 'file:./compiler.tgz',
    'compiler lock must resolve the captured archive',
  );
  assert.equal(
    compiler.integrity,
    archiveIntegrity,
    'compiler lock must pin the captured archive',
  );
  for (const [path, value] of Object.entries(packages)) {
    if (path === '') continue;
    const dependency = record(value);
    assert.notEqual(
      dependency.link,
      true,
      `${path}: linked dependencies are unsupported; use packaged runtime dependencies`,
    );
    if (
      path === 'node_modules/pomegranate-compiler' ||
      dependency.inBundle === true
    )
      continue;
    assert.ok(
      typeof dependency.resolved === 'string' &&
        /^https?:\/\//.test(dependency.resolved) &&
        typeof dependency.integrity === 'string' &&
        dependency.integrity.length > 0,
      `${path}: unpinned dependency source; use integrity-pinned registry archives or bundled runtime dependencies`,
    );
  }
  const tree = await installedTree(join(consumer, 'node_modules'));
  return {
    packageVersion: metadata.version,
    lockSha256: sha256(lockBytes),
    treeSha256: tree.sha256,
    files: tree.files,
  };
}
