import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { installedIdentity } from '../bench/installed.ts';
import { temporary } from './helpers.ts';

const integrity = 'sha512-synthetic-archive-identity';

async function fixture(t: TestContext) {
  const root = await temporary(t);
  const compiler = join(root, 'node_modules/pomegranate-compiler');
  await mkdir(compiler, { recursive: true });
  await writeFile(
    join(compiler, 'package.json'),
    '{"name":"pomegranate-compiler","version":"0.0.0"}',
  );
  await writeFile(join(compiler, 'index.js'), 'export const value = 1;\n');
  const packages: Record<string, unknown> = {
    '': { name: 'synthetic-consumer' },
    'node_modules/pomegranate-compiler': {
      resolved: 'file:compiler.tgz',
      integrity,
    },
  };
  const save = () =>
    writeFile(
      join(root, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages }),
    );
  await save();
  return { root, compiler, packages, save };
}

void test('installed identity covers actual bytes, bundled code and contained bin links', async (t) => {
  const value = await fixture(t);
  const bundled = join(value.compiler, 'node_modules/bundled');
  await mkdir(bundled, { recursive: true });
  await writeFile(join(bundled, 'index.js'), 'export const bundled = true;\n');
  value.packages['node_modules/pomegranate-compiler/node_modules/bundled'] = {
    inBundle: true,
  };
  await value.save();
  await mkdir(join(value.root, 'node_modules/.bin'));
  await symlink(
    '../pomegranate-compiler/index.js',
    join(value.root, 'node_modules/.bin/pom'),
  );
  const before = await installedIdentity(value.root, integrity);
  assert.equal(before.packageVersion, '0.0.0');
  assert.ok(
    before.files.some((file) => file.path === '.bin/pom' && 'target' in file),
  );
  assert.ok(
    before.files.some(
      (file) =>
        file.path === 'pomegranate-compiler/node_modules/bundled/index.js',
    ),
  );
  await writeFile(join(bundled, 'index.js'), 'export const bundled = false;\n');
  const after = await installedIdentity(value.root, integrity);
  assert.equal(after.lockSha256, before.lockSha256);
  assert.notEqual(after.treeSha256, before.treeSha256);
});

void test('installed identity rejects unpinned directory and git dependencies', async (t) => {
  const value = await fixture(t);
  for (const dependency of [
    { link: true, resolved: '../source' },
    { resolved: 'file:../source' },
    { resolved: 'git+https://example.invalid/source#commit' },
    { resolved: 'https://example.invalid/package.tgz' },
  ]) {
    value.packages['node_modules/helper'] = dependency;
    await value.save();
    await assert.rejects(
      installedIdentity(value.root, integrity),
      /linked dependencies|unpinned dependency/,
    );
  }
});

void test('installed identity rejects outside source links even with plausible lock metadata', async (t) => {
  const value = await fixture(t);
  const outside = join(value.root, 'external-source');
  await mkdir(outside);
  await writeFile(join(outside, 'index.js'), 'export const outside = true;\n');
  value.packages['node_modules/helper'] = {
    resolved: 'https://example.invalid/helper.tgz',
    integrity: 'sha512-synthetic',
  };
  await value.save();
  await symlink(
    outside,
    join(value.root, 'node_modules/helper'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await assert.rejects(
    installedIdentity(value.root, integrity),
    /link escapes its consumer/,
  );
  assert.equal(
    await readFile(join(outside, 'index.js'), 'utf8'),
    'export const outside = true;\n',
  );
});

void test('installed identity requires the captured root archive integrity', async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    installedIdentity(value.root, 'sha512-other-archive'),
    /captured archive/,
  );
});
