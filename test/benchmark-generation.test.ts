import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectGeneration,
  generationMetrics,
  generationProject,
  generationSettings,
} from '../bench/generation.ts';
import {
  generationSmoke,
  generationWorkload,
} from '../bench/cases/generation.ts';
import { nodeEnvironment, runLogged } from '../bench/process.ts';
import { temporary } from './helpers.ts';

const worker = fileURLToPath(
  new URL('../bench/generation-worker.ts', import.meta.url),
);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const qualifier = fileURLToPath(
  new URL('../bench/generation-qualify.ts', import.meta.url),
);

void test('generation evidence requires positive finite duration and peak RSS, without inventing missing counters', () => {
  assert.deepEqual(
    generationMetrics(
      { schemaVersion: 1, generationMs: 250, peakRssKiB: 1234 },
      100,
    ),
    { generationMs: 250, peakRssKiB: 1234, operationsPerSecond: 400 },
  );
  for (const value of [
    {},
    { schemaVersion: 2 },
    { schemaVersion: 1, generationMs: 0, peakRssKiB: 1 },
    { schemaVersion: 1, generationMs: Infinity, peakRssKiB: 1 },
    { schemaVersion: 1, generationMs: 1 },
    { schemaVersion: 1, generationMs: 1, peakRssKiB: '123' },
    { schemaVersion: 1, generationMs: 1, peakRssKiB: 0 },
  ])
    assert.throws(
      () => generationMetrics(value, 100),
      /evidence|generationMs|peakRssKiB/,
    );
  assert.deepEqual(
    generationSettings({}).profiles.map((profile) => profile.operations),
    [100, 1000, 10000],
  );
  assert.deepEqual(generationSettings({ profiles: ['smoke'] }).profiles, [
    generationSmoke,
  ]);
  assert.throws(
    () => generationSettings({ profiles: ['base'] }),
    /settings\.profiles: unknown profile: base/,
  );
});

void test('actual CLI cold/warm workers retain identical qualified output and lifetime peak memory', async (t) => {
  const root = await temporary(t);
  const inputPath = join(root, 'openapi.json');
  await writeFile(
    inputPath,
    JSON.stringify(generationWorkload(generationSmoke).document),
  );
  const outputs = [];
  for (const mode of ['cold', 'warm'] as const) {
    const directory = join(root, mode);
    await generationProject(directory, inputPath, generationSmoke);
    const sample = await collectGeneration(
      worker,
      cli,
      directory,
      mode,
      generationSmoke.operations,
    );
    assert.ok(sample.processWallMs >= sample.generationMs);
    assert.ok(sample.peakRssKiB > 0);
    const stdout = await readFile(join(directory, 'worker.stdout.log'), 'utf8');
    assert.equal(
      stdout.split('\n').filter((line) => line.startsWith('Generated ')).length,
      mode === 'warm' ? 2 : 1,
    );
    await runLogged(
      process.execPath,
      [qualifier, join(directory, 'measured'), join(directory, 'profile.json')],
      directory,
      join(directory, 'qualify'),
      nodeEnvironment(),
      30_000,
    );
    outputs.push(
      await readFile(
        join(directory, 'measured/client.consumer.operations.ts'),
        'utf8',
      ),
    );
    if (mode === 'warm')
      assert.equal(
        await readFile(
          join(directory, 'warmup/client.consumer.operations.ts'),
          'utf8',
        ),
        outputs.at(-1),
      );
  }
  assert.equal(outputs[0], outputs[1]);
});

void test('generation failures and missing worker receipts preserve raw evidence', async (t) => {
  const root = await temporary(t);
  const inputPath = join(root, 'openapi.json');
  await writeFile(inputPath, '{}');
  const invalid = join(root, 'invalid');
  await generationProject(invalid, inputPath, generationSmoke);
  await assert.rejects(collectGeneration(worker, cli, invalid, 'cold', 3));
  assert.match(
    await readFile(join(invalid, 'worker.stderr.log'), 'utf8'),
    /POM:/,
  );
  assert.equal(await readFile(inputPath, 'utf8'), '{}');
  const missing = join(root, 'missing');
  await generationProject(missing, inputPath, generationSmoke);
  const exits = join(root, 'exits.mjs');
  await writeFile(
    exits,
    "process.stdout.write('early exit');process.exit(0);\n",
  );
  await assert.rejects(
    collectGeneration(worker, exits, missing, 'cold', 3),
    /worker-result.json/,
  );
  assert.equal(
    await readFile(join(missing, 'worker.stdout.log'), 'utf8'),
    'early exit',
  );
  const malformed = join(root, 'malformed');
  await generationProject(malformed, inputPath, generationSmoke);
  const fakeWorker = join(root, 'fake-worker.mjs');
  await writeFile(
    fakeWorker,
    `import {writeFileSync} from 'node:fs';writeFileSync(process.argv.at(-1), '{"schemaVersion":1,"mode":"cold","node":'+JSON.stringify(process.version)+',"cli":'+JSON.stringify(process.argv[2])+',"generationMs":1}');`,
  );
  await assert.rejects(
    collectGeneration(fakeWorker, cli, malformed, 'cold', 3),
    /peakRssKiB/,
  );
});

void test('qualification rejects a CLI which silently emits no complete API', async (t) => {
  const root = await temporary(t);
  const inputPath = join(root, 'openapi.json');
  await writeFile(
    inputPath,
    JSON.stringify(generationWorkload(generationSmoke).document),
  );
  const directory = join(root, 'partial');
  await generationProject(directory, inputPath, generationSmoke);
  await collectGeneration(worker, cli, directory, 'cold', 3);
  // Valid modules with an empty operation registry must not qualify as three operations.
  await writeFile(
    join(directory, 'measured/client.consumer.ts'),
    'export const operations = {};\n',
  );
  await assert.rejects(
    runLogged(
      process.execPath,
      [qualifier, join(directory, 'measured'), join(directory, 'profile.json')],
      directory,
      join(directory, 'qualify'),
      nodeEnvironment(),
      30_000,
    ),
  );
  assert.match(
    await readFile(join(directory, 'qualify.stderr.log'), 'utf8'),
    /operation inventory/,
  );
});

void test('a fire-and-forget CLI cannot report early completion as fast generation', async (t) => {
  const root = await temporary(t);
  const input = join(root, 'openapi.json');
  await writeFile(input, '{}');
  const directory = join(root, 'run');
  await generationProject(directory, input, generationSmoke);
  const detached = join(root, 'detached.mjs');
  await writeFile(
    detached,
    `setTimeout(() => process.stdout.write('late generation'), 30);`,
  );
  await assert.rejects(
    collectGeneration(worker, detached, directory, 'cold', 3),
  );
  assert.match(
    await readFile(join(directory, 'worker.stderr.log'), 'utf8'),
    /must await generation completion/,
  );
});

void test('qualification rejects an operation aliased to another route despite complete registry names', async (t) => {
  const root = await temporary(t);
  const inputPath = join(root, 'openapi.json');
  await writeFile(
    inputPath,
    JSON.stringify(generationWorkload(generationSmoke).document),
  );
  const directory = join(root, 'aliased');
  await generationProject(directory, inputPath, generationSmoke);
  await collectGeneration(worker, cli, directory, 'cold', 3);
  await writeFile(
    join(directory, 'measured/client.consumer.ts'),
    `import {operations as original} from './client.consumer.operations.ts';
export const operations = {...original, write00001: original.write00000};
`,
  );
  await assert.rejects(
    runLogged(
      process.execPath,
      [qualifier, join(directory, 'measured'), join(directory, 'profile.json')],
      directory,
      join(directory, 'qualify'),
      nodeEnvironment(),
      30_000,
    ),
  );
  assert.match(
    await readFile(join(directory, 'qualify.stderr.log'), 'utf8'),
    /write00001: request URL/,
  );
});
