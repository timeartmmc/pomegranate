import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { synchronizeOutputs } from '../dist/outputs.js';
import { fileSnapshot, temporary } from './helpers.ts';

// Builtin export changes remain in this test file's isolated Node process.
function mockFilesystem(
  t: TestContext,
  methods: { writeFile?: typeof fs.writeFile; rm?: typeof fs.rm },
) {
  if (methods.writeFile) t.mock.method(fs, 'writeFile', methods.writeFile);
  if (methods.rm) t.mock.method(fs, 'rm', methods.rm);
  syncBuiltinESMExports();
  return () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  };
}

void test('a staging failure keeps its identity when cleanup succeeds', async (t) => {
  const root = await temporary(t);
  const failure = new Error('staging failed');
  const write = fs.writeFile;
  const restore = mockFilesystem(t, {
    writeFile: async (path, ...args) => {
      if (typeof path === 'string' && path.includes('.pom-stage-'))
        throw failure;
      return write(path, ...args);
    },
  });
  try {
    await assert.rejects(
      synchronizeOutputs(root, { 'index.ts': 'entry' }, [], false),
      (error) => error === failure,
    );
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    restore();
  }
});

void test('a failed staging cleanup preserves the primary error and still removes the lock', async (t) => {
  const root = await temporary(t);
  const files = { 'index.ts': 'entry' };
  await synchronizeOutputs(root, files, [], false);
  const before = await fileSnapshot(root);
  const failure = new Error('staging failed');
  const cleanupFailure = new Error('staging cleanup failed');
  const remove = fs.rm;
  const write = fs.writeFile;
  const cleanupAttempts: string[] = [];
  const restore = mockFilesystem(t, {
    writeFile: async (path, ...args) => {
      if (typeof path === 'string' && path.includes('.pom-stage-'))
        throw failure;
      return write(path, ...args);
    },
    rm: async (path, options) => {
      if (typeof path === 'string' && path.includes('.pom-stage-')) {
        cleanupAttempts.push('stage');
        throw cleanupFailure;
      }
      cleanupAttempts.push('lock');
      return remove(path, options);
    },
  });
  try {
    await assert.rejects(
      synchronizeOutputs(root, { 'index.ts': 'new entry' }, [], false),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, failure);
        assert.deepEqual(error.errors, [failure, cleanupFailure]);
        assert.match(error.message, /staging failed.*staging cleanup failed/);
        return true;
      },
    );
    assert.deepEqual(cleanupAttempts, ['stage', 'lock']);
    await assert.rejects(fs.stat(join(root, '.pom-lock')), { code: 'ENOENT' });
    assert.deepEqual(await fileSnapshot(root), before);
  } finally {
    restore();
  }
});

void test('both cleanup failures are reported after successful generation', async (t) => {
  const root = await temporary(t);
  const files = { 'index.ts': 'entry' };
  const stageFailure = new Error('staging cleanup failed');
  const lockFailure = new Error('lock cleanup failed');
  const cleanupAttempts: string[] = [];
  const remove = fs.rm;
  const restore = mockFilesystem(t, {
    rm: async (path, ...args) => {
      if (typeof path === 'string' && path.includes('.pom-stage-')) {
        cleanupAttempts.push('stage');
        throw stageFailure;
      }
      if (typeof path === 'string' && path.endsWith('.pom-lock')) {
        cleanupAttempts.push('lock');
        throw lockFailure;
      }
      return remove(path, ...args);
    },
  });
  try {
    await assert.rejects(
      synchronizeOutputs(root, files, [], false),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, undefined);
        assert.deepEqual(error.errors, [stageFailure, lockFailure]);
        assert.match(
          error.message,
          /staging cleanup failed.*lock cleanup failed/,
        );
        return true;
      },
    );
    assert.deepEqual(cleanupAttempts, ['stage', 'lock']);
    assert.equal((await synchronizeOutputs(root, files, [], true)).clean, true);
    assert.equal(await fs.readFile(join(root, 'index.ts'), 'utf8'), 'entry');
  } finally {
    restore();
  }
});
