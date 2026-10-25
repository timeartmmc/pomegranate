import assert from 'node:assert/strict';
import {
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, sep } from 'node:path';
import test from 'node:test';
import { synchronizeOutputs } from '../dist/outputs.js';
import { fileSnapshot, temporary } from './helpers.mjs';

for (const check of [true, false]) {
  const mode = check ? 'check' : 'generation';

  test(`case aliases in expected filenames fail before ${mode} creates output`, async (t) => {
    const root = await temporary(t);
    const output = join(root, 'missing');
    await assert.rejects(
      synchronizeOutputs(
        output,
        { 'runtime.ts': 'one', 'RUNTIME.ts': 'two' },
        [],
        check,
      ),
      /case-insensitive filename collision/,
    );
    await assert.rejects(stat(output), { code: 'ENOENT' });
  });

  test(`case aliases in an inventory block ${mode} without replacing or deleting files`, async (t) => {
    const root = await temporary(t);
    const files = { 'runtime.ts': 'runtime', 'index.ts': 'entry' };
    await synchronizeOutputs(root, files, [], false);
    const manifestPath = join(root, '.pom-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files['RUNTIME.ts'] = manifest.files['runtime.ts'];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const before = await fileSnapshot(root);
    await assert.rejects(
      synchronizeOutputs(
        root,
        { 'runtime.ts': 'new runtime', 'index.ts': 'new entry' },
        [],
        check,
      ),
      /case-insensitive filename collision/,
    );
    assert.deepEqual(await fileSnapshot(root), before);
    assert.deepEqual((await readdir(root)).sort(), [
      '.pom-manifest.json',
      'index.ts',
      'runtime.ts',
    ]);
  });

  test(`a stale filename cannot alias an expected filename during ${mode}`, async (t) => {
    const root = await temporary(t);
    await synchronizeOutputs(
      root,
      { 'RUNTIME.ts': 'runtime', 'index.ts': 'entry' },
      [],
      false,
    );
    const before = await fileSnapshot(root);
    await assert.rejects(
      synchronizeOutputs(
        root,
        { 'runtime.ts': 'new runtime', 'index.ts': 'new entry' },
        [],
        check,
      ),
      /case-insensitive filename collision/,
    );
    assert.deepEqual(await fileSnapshot(root), before);
    assert.deepEqual((await readdir(root)).sort(), [
      '.pom-manifest.json',
      'RUNTIME.ts',
      'index.ts',
    ]);
  });
}

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
