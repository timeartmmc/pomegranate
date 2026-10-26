import assert from 'node:assert/strict';
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import test from 'node:test';
import { synchronizeOutputs } from '../dist/outputs.js';
import { runProject } from '../dist/index.js';
import { json, record } from './assertions.ts';
import { fixture, fileSnapshot, temporary } from './helpers.ts';

for (const check of [true, false]) {
  const mode = check ? 'check' : 'generation';

  void test(`case aliases in expected filenames fail before ${mode} creates output`, async (t) => {
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

  void test(`case aliases in an inventory block ${mode} without replacing or deleting files`, async (t) => {
    const root = await temporary(t);
    const files = { 'runtime.ts': 'runtime', 'index.ts': 'entry' };
    await synchronizeOutputs(root, files, [], false);
    const manifestPath = join(root, '.pom-manifest.json');
    const manifest = record(json(await readFile(manifestPath, 'utf8')));
    const inventory = record(manifest.files);
    inventory['RUNTIME.ts'] = inventory['runtime.ts'];
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

  void test(`a stale filename cannot alias an expected filename during ${mode}`, async (t) => {
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

void test(
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
  void test(
    `POSIX backslash symlink output is rejected during ${check ? 'check' : 'generation'}`,
    { skip: sep !== '/' },
    async (t) => {
      const root = await temporary(t);
      const referent = join(root, 'outside');
      await mkdir(referent);
      await writeFile(join(referent, 'keep.txt'), 'application-owned\n');
      const link = join(root, 'out\\link');
      await symlink(referent, link);
      const output = link;
      await assert.rejects(
        synchronizeOutputs(output, { 'index.ts': 'generated\n' }, [], check),
        /output paths must contain only directories, without symbolic links/,
      );
      assert.deepEqual(await readdir(referent), ['keep.txt']);
      assert.equal(
        await readFile(join(referent, 'keep.txt'), 'utf8'),
        'application-owned\n',
      );
      assert.deepEqual((await readdir(root)).sort(), ['out\\link', 'outside']);
    },
  );
}

void test(
  'parent symlinks resolve once across missing directories, generation, drift and protected inputs',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await temporary(t);
    const real = join(root, 'actual');
    await mkdir(real);
    const alias = join(root, sep === '/' ? 'parent\\alias' : 'parent-alias');
    await symlink(real, alias);
    const output = join(alias, 'missing', 'generated');
    const canonical = join(real, 'missing', 'generated');
    const expected = { 'index.ts': 'first\n' };
    const before = await fileSnapshot(real);
    const missing = await synchronizeOutputs(output, expected, [], true);
    assert.equal(missing.output, canonical);
    assert.equal(missing.clean, false);
    assert.deepEqual(await fileSnapshot(real), before);
    await assert.rejects(stat(join(real, 'missing')), { code: 'ENOENT' });
    assert.equal(
      (await synchronizeOutputs(output, expected, [], false)).output,
      canonical,
    );
    const generated = await fileSnapshot(canonical);
    assert.equal(
      (await synchronizeOutputs(output, expected, [], true)).clean,
      true,
    );
    assert.deepEqual(await fileSnapshot(canonical), generated);
    for (const check of [false, true]) {
      await assert.rejects(
        synchronizeOutputs(
          output,
          { 'index.ts': 'replacement\n' },
          [join(alias, 'missing', 'generated', 'index.ts')],
          check,
        ),
        /protected input/,
      );
      assert.deepEqual(await fileSnapshot(canonical), generated);
    }
  },
);

void test('runProject supports an absolute output under the platform temporary directory alias', async (t) => {
  const root = await temporary(t);
  const directory = process.platform === 'darwin' ? '/tmp' : tmpdir();
  const canonicalTemporary = await realpath(directory);
  const output = join(directory, 'pom-parent-alias-' + basename(root));
  const canonical = join(canonicalTemporary, basename(output));
  t.after(() => rm(canonical, { recursive: true, force: true }));
  await writeFile(join(root, 'openapi.json'), JSON.stringify(fixture()));
  const config = join(root, 'pom.json');
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output,
      clients: ['consumer'],
    }),
  );
  const missing = await runProject(config, { check: true });
  assert.equal(missing.output, canonical);
  await assert.rejects(stat(canonical), { code: 'ENOENT' });
  await runProject(config);
  assert.equal((await runProject(config, { check: true })).clean, true);
});
