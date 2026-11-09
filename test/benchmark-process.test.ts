import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeFailure } from '../bench/controller.ts';
import { nodeEnvironment, runLogged } from '../bench/process.ts';
import { json, record } from './assertions.ts';

void test('a worker ignoring SIGTERM is killed and cannot become a late success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pom-worker-timeout-'));
  try {
    const log = join(root, 'child');
    await assert.rejects(
      runLogged(
        process.execPath,
        [
          '-e',
          `
        process.on('SIGTERM',()=>{});
        process.stdout.write('ready');
        process.stderr.write('diagnostic');
        setTimeout(()=>process.exit(0),3000);
      `,
        ],
        root,
        log,
        nodeEnvironment(),
        1000,
      ),
      (error: unknown) => record(error).signal === 'SIGKILL',
    );
    assert.equal(await readFile(`${log}.stdout.log`, 'utf8'), 'ready');
    assert.equal(await readFile(`${log}.stderr.log`, 'utf8'), 'diagnostic');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('failure evidence preserves bounded nested causes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pom-failure-evidence-'));
  try {
    await writeFailure(
      root,
      'qualification',
      new Error('control setup failed', {
        cause: new Error('missing /explicit/generated/path', {
          cause: 'x'.repeat(100_000),
        }),
      }),
    );
    const failure = record(
      json(await readFile(join(root, 'failure.json'), 'utf8')),
    );
    assert.equal(failure.status, 'invalid');
    assert.equal(failure.error, 'control setup failed');
    assert.equal(typeof failure.details, 'string');
    assert.match(
      String(failure.details),
      /missing \/explicit\/generated\/path/,
    );
    assert.ok(String(failure.details).length <= 32_768);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
