import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { synchronizeOutputs } from '../dist/outputs.js';
import type { OutputWarning } from '../dist/index.js';
import { fileSnapshot, temporary } from './helpers.ts';

void test('check is read-only even when the output directory does not exist', async (t) => {
  const root = await temporary(t);
  const output = join(root, 'missing');
  const result = await synchronizeOutputs(
    output,
    { 'index.ts': 'one\n' },
    [],
    true,
  );
  assert.equal(result.clean, false);
  assert.ok(result.changes.includes('missing: index.ts'));
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

void test('generation is repeatable, check preserves files and unrelated files survive', async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, 'notes.txt'), 'user notes');
  const files = { 'index.ts': 'one\n', 'schemas.ts': 'two\n' };
  await synchronizeOutputs(root, files, [], false);
  const before = await fileSnapshot(root);
  assert.equal((await synchronizeOutputs(root, files, [], true)).clean, true);
  assert.deepEqual(await fileSnapshot(root), before);
  assert.equal((await synchronizeOutputs(root, files, [], false)).clean, true);
  assert.deepEqual(await fileSnapshot(root), before);
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'user notes');
});

void test('an unowned collision refuses the whole batch before replacing outputs', async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, 'schemas.ts'), 'user code');
  const before = await fileSnapshot(root);
  await assert.rejects(
    synchronizeOutputs(
      root,
      { 'index.ts': 'generated', 'schemas.ts': 'generated' },
      [],
      false,
    ),
    /unowned output: schemas.ts/,
  );
  assert.deepEqual(await fileSnapshot(root), before);
  assert.deepEqual((await readdir(root)).sort(), ['schemas.ts']);
});

void test('modified owned targets warn before replacement and checks remain read-only', async (t) => {
  const root = await temporary(t);
  await synchronizeOutputs(
    root,
    { 'index.ts': 'one', 'schemas.ts': 'two' },
    [],
    false,
  );
  await writeFile(join(root, 'schemas.ts'), 'user modification');
  const before = await fileSnapshot(root);
  const result = await synchronizeOutputs(
    root,
    { 'index.ts': 'new one', 'schemas.ts': 'new two' },
    [],
    true,
  );
  assert.ok(result.changes.includes('modified owned output: schemas.ts'));
  assert.deepEqual(await fileSnapshot(root), before);
  const warnings: OutputWarning[] = [];
  const generated = await synchronizeOutputs(
    root,
    { 'index.ts': 'new one', 'schemas.ts': 'new two' },
    [],
    false,
    (warning) => {
      assert.equal(
        readFileSync(join(root, 'schemas.ts'), 'utf8'),
        'user modification',
      );
      assert.equal(readFileSync(join(root, 'index.ts'), 'utf8'), 'one');
      warnings.push(warning);
    },
  );
  assert.deepEqual(warnings, generated.warnings);
  assert.deepEqual(
    warnings.map(({ code, path }) => ({ code, path })),
    [{ code: 'modified-output', path: join(root, 'schemas.ts') }],
  );
  assert.equal(await readFile(join(root, 'schemas.ts'), 'utf8'), 'new two');
  assert.equal(
    (
      await synchronizeOutputs(
        root,
        { 'index.ts': 'new one', 'schemas.ts': 'new two' },
        [],
        true,
      )
    ).clean,
    true,
  );
});

void test('modified owned bytes matching the rendered output only update ownership', async (t) => {
  const root = await temporary(t);
  const target = join(root, 'index.ts');
  await synchronizeOutputs(root, { 'index.ts': 'original' }, [], false);
  await writeFile(target, 'updated');
  const before = await stat(target);
  const files = { 'index.ts': 'updated' };
  const checked = await synchronizeOutputs(root, files, [], true);
  assert.deepEqual(checked.warnings, [
    {
      code: 'modified-output',
      path: target,
      message:
        'updating the recorded hash of a modified owned output that matches the rendered output',
    },
  ]);
  const generated = await synchronizeOutputs(root, files, [], false);
  assert.deepEqual(generated.warnings, checked.warnings);
  const after = await stat(target);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal((await synchronizeOutputs(root, files, [], true)).clean, true);
});

void test('only unchanged inventoried stale files are removed', async (t) => {
  const root = await temporary(t);
  await synchronizeOutputs(
    root,
    { 'index.ts': 'one', 'old.ts': 'old' },
    [],
    false,
  );
  await writeFile(join(root, 'unrelated.ts'), 'user code');
  await synchronizeOutputs(root, { 'index.ts': 'new' }, [], false);
  await assert.rejects(stat(join(root, 'old.ts')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'unrelated.ts'), 'utf8'), 'user code');
  assert.equal(
    (await synchronizeOutputs(root, { 'index.ts': 'new' }, [], true)).clean,
    true,
  );
});

void test('modified stale output stays protected across generations until explicitly resolved', async (t) => {
  const root = await temporary(t);
  await synchronizeOutputs(
    root,
    { 'index.ts': 'one', 'old.ts': 'old' },
    [],
    false,
  );
  await writeFile(join(root, 'old.ts'), 'changed by a person');
  for (const index of ['new', 'newer']) {
    const result = await synchronizeOutputs(
      root,
      { 'index.ts': index },
      [],
      false,
    );
    assert.ok(
      result.warnings.some(
        (warning) =>
          warning.code === 'preserved-stale-output' &&
          warning.path === join(root, 'old.ts'),
      ),
    );
    assert.equal(
      await readFile(join(root, 'old.ts'), 'utf8'),
      'changed by a person',
    );
    assert.equal(await readFile(join(root, 'index.ts'), 'utf8'), index);
  }
  const before = await fileSnapshot(root);
  assert.equal(
    (await synchronizeOutputs(root, { 'index.ts': 'newer' }, [], true)).clean,
    false,
  );
  assert.deepEqual(await fileSnapshot(root), before);
  await writeFile(join(root, 'old.ts'), 'old');
  await synchronizeOutputs(root, { 'index.ts': 'newer' }, [], false);
  await assert.rejects(stat(join(root, 'old.ts')), { code: 'ENOENT' });
});

void test('missing owned outputs can be regenerated', async (t) => {
  const root = await temporary(t);
  await synchronizeOutputs(root, { 'index.ts': 'one' }, [], false);
  await rm(join(root, 'index.ts'));
  await synchronizeOutputs(root, { 'index.ts': 'one' }, [], false);
  assert.equal(await readFile(join(root, 'index.ts'), 'utf8'), 'one');
});

void test('corrupt manifests recover only banner-marked targets and preserve uncertain stale files', async (t) => {
  const root = await temporary(t);
  const banner = '// Generated by Pomegranate. Do not edit.\n';
  await writeFile(join(root, 'index.ts'), banner + 'old');
  await writeFile(join(root, 'old.ts'), banner + 'uncertain stale');
  await writeFile(join(root, 'unrelated.ts'), 'application code');
  for (const source of [
    '{',
    '{"version":2,"generator":"@pomegranate/compiler","files":{}}',
    '{"version":1,"generator":"other","files":{}}',
    '{"version":1,"generator":"@pomegranate/compiler","files":{"index.ts":"bad hash"}}',
  ]) {
    await writeFile(join(root, '.pom-manifest.json'), source);
    const before = await fileSnapshot(root);
    const expected = { 'index.ts': banner + 'new' };
    const checking = await synchronizeOutputs(root, expected, [], true);
    assert.equal(checking.clean, false);
    assert.deepEqual(await fileSnapshot(root), before);
    const result = await synchronizeOutputs(root, expected, [], false);
    assert.ok(
      result.warnings.some((warning) => warning.code === 'recovered-manifest'),
    );
    assert.ok(
      result.warnings.some(
        (warning) => warning.code === 'preserved-stale-output',
      ),
    );
    assert.equal(
      await readFile(join(root, 'index.ts'), 'utf8'),
      expected['index.ts'],
    );
    assert.equal(
      await readFile(join(root, 'old.ts'), 'utf8'),
      banner + 'uncertain stale',
    );
    assert.equal(
      await readFile(join(root, 'unrelated.ts'), 'utf8'),
      'application code',
    );
  }
});

void test('ownership recovery requires the complete exact first-line POM banner', async (t) => {
  const root = await temporary(t);
  const banner = '// Generated by Pomegranate. Do not edit.\n';
  for (const content of [
    'application code',
    ' ' + banner,
    '\ufeff' + banner,
    banner.replace('\n', '\r\n'),
    banner.trimEnd(),
    '// Generated by Pomegranate. Do not edit. Extra\n',
  ]) {
    await writeFile(join(root, 'index.ts'), content);
    const before = await fileSnapshot(root);
    await assert.rejects(
      synchronizeOutputs(root, { 'index.ts': banner + 'new' }, [], false),
      /unowned output/,
    );
    assert.deepEqual(await fileSnapshot(root), before);
  }
  await writeFile(join(root, 'index.ts'), banner + 'old');
  const recovered = await synchronizeOutputs(
    root,
    { 'index.ts': banner + 'new' },
    [],
    false,
  );
  assert.ok(
    recovered.warnings.some((warning) => warning.code === 'recovered-output'),
  );
  assert.equal(
    (await synchronizeOutputs(root, { 'index.ts': banner + 'new' }, [], true))
      .clean,
    true,
  );
});

void test('unsafe inventory filenames refuse all writes', async (t) => {
  const root = await temporary(t);
  await writeFile(
    join(root, '.pom-manifest.json'),
    JSON.stringify({
      version: 1,
      generator: '@pomegranate/compiler',
      files: { '../escape.ts': '0'.repeat(64) },
    }),
  );
  const before = await fileSnapshot(root);
  for (const check of [true, false])
    await assert.rejects(
      synchronizeOutputs(root, { 'index.ts': 'one' }, [], check),
      /unsafe generated filename/,
    );
  assert.deepEqual(await fileSnapshot(root), before);
});

void test('active, stale and inventory paths cannot overlap inputs', async (t) => {
  const root = await temporary(t);
  await synchronizeOutputs(
    root,
    { 'index.ts': 'one', 'old.ts': 'old' },
    [],
    false,
  );
  const before = await fileSnapshot(root);
  for (const name of ['index.ts', 'old.ts', '.pom-manifest.json']) {
    await assert.rejects(
      synchronizeOutputs(
        root,
        { 'index.ts': 'new' },
        [join(root, name)],
        false,
      ),
      /protected input/,
    );
  }
  assert.deepEqual(await fileSnapshot(root), before);
});

void test(
  'symbolic links at the output root or target files are rejected',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await temporary(t);
    const referent = join(root, 'referent');
    await mkdir(referent);
    await symlink(referent, join(root, 'link'));
    await assert.rejects(
      synchronizeOutputs(join(root, 'link'), { 'index.ts': 'one' }, [], false),
      /symbolic links/,
    );
    const missing = await synchronizeOutputs(
      join(root, 'link', 'nested'),
      { 'index.ts': 'one' },
      [],
      true,
    );
    assert.equal(missing.output, join(referent, 'nested'));
    assert.equal(missing.clean, false);
    assert.deepEqual(await readdir(referent), []);
    await writeFile(join(referent, 'user.ts'), 'user code');
    const output = join(root, 'output');
    await mkdir(output);
    await symlink(join(referent, 'user.ts'), join(output, 'index.ts'));
    await assert.rejects(
      synchronizeOutputs(output, { 'index.ts': 'one' }, [], false),
      /symbolic links/,
    );
    assert.equal(
      await readFile(join(referent, 'user.ts'), 'utf8'),
      'user code',
    );
  },
);

void test('another generation lock is preserved', async (t) => {
  const root = await temporary(t);
  await mkdir(join(root, '.pom-lock'));
  await writeFile(join(root, '.pom-lock', 'owner'), 'another process');
  await assert.rejects(
    synchronizeOutputs(root, { 'index.ts': 'one' }, [], false),
    /output is locked/,
  );
  assert.equal(
    await readFile(join(root, '.pom-lock', 'owner'), 'utf8'),
    'another process',
  );
  await assert.rejects(stat(join(root, 'index.ts')), { code: 'ENOENT' });
});
