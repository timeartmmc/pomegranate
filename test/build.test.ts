import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { temporary } from './helpers.ts';

const exec = promisify(execFile);

void test('cleaning compiler output unlinks a dist symlink without traversing its target', async (t) => {
  const root = await temporary(t);
  const checkout = join(root, 'compiler');
  const outside = join(root, 'application');
  await mkdir(join(checkout, 'scripts'), { recursive: true });
  await mkdir(outside);
  const sentinel = join(outside, 'keep.ts');
  await writeFile(sentinel, 'application-owned source\n');
  await copyFile(
    new URL('../scripts/clean-dist.ts', import.meta.url),
    join(checkout, 'scripts/clean-dist.ts'),
  );
  await symlink(
    outside,
    join(checkout, 'dist'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await exec(process.execPath, [join(checkout, 'scripts/clean-dist.ts')]);
  assert.equal(await readFile(sentinel, 'utf8'), 'application-owned source\n');
  await assert.rejects(stat(join(checkout, 'dist')), { code: 'ENOENT' });
});

void test('preparing test signatures replaces a symlink while preserving its target', async (t) => {
  const root = await temporary(t);
  const checkout = join(root, 'compiler');
  const outside = join(root, 'application');
  await mkdir(join(checkout, 'scripts'), { recursive: true });
  await mkdir(join(checkout, 'test'));
  await mkdir(join(checkout, 'examples/json'), { recursive: true });
  await mkdir(outside);
  const sentinel = join(outside, 'keep.ts');
  await writeFile(sentinel, 'application-owned source\n');
  await writeFile(join(checkout, 'package.json'), '{"type":"module"}');
  await copyFile(
    new URL('../scripts/prepare-tests.ts', import.meta.url),
    join(checkout, 'scripts/prepare-tests.ts'),
  );
  await copyFile(
    new URL('../examples/json/openapi.json', import.meta.url),
    join(checkout, 'examples/json/openapi.json'),
  );
  for (const name of [
    'helpers.ts',
    'assertions.ts',
    'schema-helpers.ts',
    'schema-fixture.ts',
    'nullable-type-fixture.ts',
    'multipart-fixture.ts',
    'deep-fixture.ts',
    'symbol-fixture.ts',
    'query-fixture.ts',
  ])
    await copyFile(
      new URL(name, import.meta.url),
      join(checkout, 'test', name),
    );
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(
    fileURLToPath(new URL('../dist', import.meta.url)),
    join(checkout, 'dist'),
    linkType,
  );
  await symlink(outside, join(checkout, 'test/.generated'), linkType);
  await exec(process.execPath, [join(checkout, 'scripts/prepare-tests.ts')]);
  assert.equal(await readFile(sentinel, 'utf8'), 'application-owned source\n');
  assert.equal(
    (await lstat(join(checkout, 'test/.generated'))).isSymbolicLink(),
    false,
  );
  assert.ok(
    (
      await stat(join(checkout, 'test/.generated/runtime/client.consumer.ts'))
    ).isFile(),
  );
});
