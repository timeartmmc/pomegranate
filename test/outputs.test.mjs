import assert from 'node:assert/strict';
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
import { temporary } from './helpers.mjs';

async function snapshot(root) {
  const result = {};
  for (const name of (await readdir(root)).sort()) {
    const entry = await stat(join(root, name));
    if (entry.isFile())
      result[name] = {
        text: await readFile(join(root, name), 'utf8'),
        mtime: entry.mtimeMs,
      };
  }
  return result;
}

test('check is read-only even when the output directory does not exist', async (t) => {
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

test('generation is repeatable, check preserves files and unrelated files survive', async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, 'notes.txt'), 'user notes');
  const files = { 'index.ts': 'one\n', 'schemas.ts': 'two\n' };
  await synchronizeOutputs(root, files, [], false);
  const before = await snapshot(root);
  assert.equal((await synchronizeOutputs(root, files, [], true)).clean, true);
  assert.deepEqual(await snapshot(root), before);
  assert.equal((await synchronizeOutputs(root, files, [], false)).clean, true);
  assert.deepEqual(await snapshot(root), before);
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'user notes');
});

test('an unowned collision refuses the whole batch before replacing outputs', async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, 'schemas.ts'), 'user code');
  const before = await snapshot(root);
  await assert.rejects(
    synchronizeOutputs(
      root,
      { 'index.ts': 'generated', 'schemas.ts': 'generated' },
      [],
      false,
    ),
    /unowned output: schemas.ts/,
  );
  assert.deepEqual(await snapshot(root), before);
  assert.deepEqual((await readdir(root)).sort(), ['schemas.ts']);
});

test('modified owned outputs block updates and checks report drift without writing', async (t) => {
  const root = await temporary(t);
  await synchronizeOutputs(
    root,
    { 'index.ts': 'one', 'schemas.ts': 'two' },
    [],
    false,
  );
  await writeFile(join(root, 'schemas.ts'), 'user modification');
  const before = await snapshot(root);
  const result = await synchronizeOutputs(
    root,
    { 'index.ts': 'new one', 'schemas.ts': 'new two' },
    [],
    true,
  );
  assert.ok(result.changes.includes('modified owned output: schemas.ts'));
  assert.deepEqual(await snapshot(root), before);
  await assert.rejects(
    synchronizeOutputs(
      root,
      { 'index.ts': 'new one', 'schemas.ts': 'new two' },
      [],
      false,
    ),
    /modified owned output: schemas.ts/,
  );
  assert.deepEqual(await snapshot(root), before);
});

test('only unchanged inventoried stale files are removed', async (t) => {
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

test('modified stale output is preserved and blocks all replacement', async (t) => {
  const root = await temporary(t);
  await synchronizeOutputs(
    root,
    { 'index.ts': 'one', 'old.ts': 'old' },
    [],
    false,
  );
  await writeFile(join(root, 'old.ts'), 'changed by a person');
  const before = await snapshot(root);
  await assert.rejects(
    synchronizeOutputs(root, { 'index.ts': 'new' }, [], false),
    /modified owned output: old.ts/,
  );
  assert.deepEqual(await snapshot(root), before);
});

test('missing owned outputs can be regenerated', async (t) => {
  const root = await temporary(t);
  await synchronizeOutputs(root, { 'index.ts': 'one' }, [], false);
  await rm(join(root, 'index.ts'));
  await synchronizeOutputs(root, { 'index.ts': 'one' }, [], false);
  assert.equal(await readFile(join(root, 'index.ts'), 'utf8'), 'one');
});

test('malformed and unsafe inventories refuse cleanup', async (t) => {
  const root = await temporary(t);
  for (const source of [
    '{',
    '{"version":2,"generator":"@pomegranate/compiler","files":{}}',
    '{"version":1,"generator":"other","files":{}}',
    JSON.stringify({
      version: 1,
      generator: '@pomegranate/compiler',
      files: { '../escape.ts': '0'.repeat(64) },
    }),
  ]) {
    await writeFile(join(root, '.pom-manifest.json'), source);
    const before = await snapshot(root);
    await assert.rejects(
      synchronizeOutputs(root, { 'index.ts': 'one' }, [], false),
    );
    assert.deepEqual(await snapshot(root), before);
  }
});

test('active, stale and inventory paths cannot overlap inputs', async (t) => {
  const root = await temporary(t);
  await synchronizeOutputs(
    root,
    { 'index.ts': 'one', 'old.ts': 'old' },
    [],
    false,
  );
  const before = await snapshot(root);
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
  assert.deepEqual(await snapshot(root), before);
});

test(
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

test('another generation lock is preserved', async (t) => {
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
