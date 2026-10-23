import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import test from 'node:test';
import { synchronizeOutputs } from '../dist/outputs.js';
import { temporary } from './helpers.mjs';

test(
  'POSIX backslash names preserve ordinary directory and ownership behavior',
  { skip: sep !== '/' },
  async (t) => {
    const root = await temporary(t);
    const output = join(root, 'out\\literal');
    await synchronizeOutputs(output, { 'index.ts': 'generated\n' }, [], false);
    assert.equal(
      await readFile(join(output, 'index.ts'), 'utf8'),
      'generated\n',
    );
    assert.equal(
      (
        await synchronizeOutputs(
          output,
          { 'index.ts': 'generated\n' },
          [],
          true,
        )
      ).clean,
      true,
    );
    assert.deepEqual(await readdir(root), ['out\\literal']);
  },
);

for (const check of [true, false]) {
  for (const nested of [false, true]) {
    test(
      `POSIX backslash symlink ${nested ? 'ancestor' : 'output'} is rejected during ${check ? 'check' : 'generation'}`,
      { skip: sep !== '/' },
      async (t) => {
        const root = await temporary(t);
        const referent = join(root, 'outside');
        await mkdir(referent);
        await writeFile(join(referent, 'keep.txt'), 'application-owned\n');
        const link = join(root, 'out\\link');
        await symlink(referent, link);
        const output = nested ? join(link, 'generated') : link;
        await assert.rejects(
          synchronizeOutputs(output, { 'index.ts': 'generated\n' }, [], check),
          /output paths must contain only directories, without symbolic links/,
        );
        assert.deepEqual(await readdir(referent), ['keep.txt']);
        assert.equal(
          await readFile(join(referent, 'keep.txt'), 'utf8'),
          'application-owned\n',
        );
        assert.deepEqual((await readdir(root)).sort(), [
          'out\\link',
          'outside',
        ]);
      },
    );
  }
}
