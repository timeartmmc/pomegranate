import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { temporary } from './helpers.mjs';

const exec = promisify(execFile);

test('cleaning compiler output unlinks a dist symlink without traversing its target', async (t) => {
  const root = await temporary(t);
  const checkout = join(root, 'compiler');
  const outside = join(root, 'application');
  await mkdir(join(checkout, 'scripts'), { recursive: true });
  await mkdir(outside);
  const sentinel = join(outside, 'keep.ts');
  await writeFile(sentinel, 'application-owned source\n');
  await copyFile(
    new URL('../scripts/clean-dist.mjs', import.meta.url),
    join(checkout, 'scripts/clean-dist.mjs'),
  );
  await symlink(
    outside,
    join(checkout, 'dist'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await exec(process.execPath, [join(checkout, 'scripts/clean-dist.mjs')]);
  assert.equal(await readFile(sentinel, 'utf8'), 'application-owned source\n');
  await assert.rejects(stat(join(checkout, 'dist')), { code: 'ENOENT' });
});
