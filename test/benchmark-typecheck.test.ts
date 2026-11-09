import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { nodeEnvironment, runLogged } from '../bench/process.ts';
import { compile } from '../dist/index.js';
import {
  collectTypecheck,
  typecheckDiagnostics,
  typecheckSchedule,
  typecheckSettings,
} from '../bench/typecheck.ts';
import {
  scaleCompilerOptions,
  typecheckConsumer,
  typecheckSmoke,
  typecheckWorkload,
  verifyTypecheckInventory,
} from '../bench/cases/typecheck.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import { temporary } from './helpers.ts';

const typescript = fileURLToPath(
  new URL('../node_modules/typescript/bin/tsc', import.meta.url),
);
const diagnostics =
  'Check time: 1.23s\nInstantiations: 456\nMemory used: 78901K\n';

void test('typecheck diagnostic evidence requires supported numeric counters', () => {
  assert.deepEqual(typecheckDiagnostics(diagnostics), {
    checkMs: 1230,
    instantiations: 456,
    compilerMemoryK: 78901,
  });
  for (const stdout of [
    '',
    diagnostics.replace('Check time: 1.23s\n', ''),
    diagnostics.replace('456', 'unknown'),
    diagnostics.replace('456', '1.5'),
    diagnostics.replace('K', 'MB'),
    diagnostics + 'Memory used: 22K\n',
    diagnostics.replace('1.23', '-1'),
    diagnostics.replace('78901', 'NaN'),
  ]) {
    assert.throws(() => typecheckDiagnostics(stdout), /format|malformed/);
  }
  assert.deepEqual(
    typecheckDiagnostics(
      diagnostics.replace('1.23', '0.00').replace('456', '0'),
    ),
    { checkMs: 0, instantiations: 0, compilerMemoryK: 78901 },
  );
});

void test('typecheck scheduling replays a seed and visits every cell once per round', () => {
  const cells = ['a', 'b', 'c', 'd', 'e', 'f'];
  const schedule = typecheckSchedule(cells, 3, 42);
  assert.deepEqual(schedule, typecheckSchedule(cells, 3, 42));
  assert.notDeepEqual(schedule, typecheckSchedule(cells, 3, 43));
  for (let round = 0; round < 3; round++)
    assert.deepEqual(
      schedule
        .filter((sample) => sample.round === round)
        .map((sample) => sample.cell)
        .sort(),
      cells,
    );
  assert.deepEqual(
    typecheckSettings({ profiles: ['smoke'], rounds: 1 }).profiles,
    [typecheckSmoke],
  );
  for (const settings of [
    { profiles: [] },
    { profiles: ['unknown'] },
    { profiles: ['smoke', 'smoke'] },
    { rounds: 0 },
    { seed: -1 },
    { policy: {} },
  ])
    assert.throws(() => typecheckSettings(settings));
});

void test('generated core consumers qualify meaningful inferred types and retain typecheck failures', async (t) => {
  const profile = typecheckSmoke;
  const input = typecheckWorkload(profile);
  const root = await generatedTestWorkspace(
    t,
    await compile(input.document, input.options),
  );
  await writeFile(join(root, 'consumer.ts'), typecheckConsumer(profile));
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: scaleCompilerOptions,
      include: ['./*.ts'],
    }),
  );
  const logs = await temporary(t);
  await collectTypecheck(root, typescript, join(logs, 'qualification'), false);
  const measurement = await collectTypecheck(
    root,
    typescript,
    join(logs, 'measurement'),
    true,
  );
  assert.ok(measurement && measurement.wallMs > 0);
  assert.ok(measurement.compilerMemoryK > 0);
  await writeFile(
    join(root, 'consumer.ts'),
    typecheckConsumer(profile) + '\nconst broken: string = 42;\nvoid broken;\n',
  );
  await assert.rejects(
    collectTypecheck(root, typescript, join(logs, 'broken'), false),
  );
  assert.match(
    await readFile(join(logs, 'broken.stdout.log'), 'utf8'),
    /TS2322/,
  );
  // A candidate which erases the schemas and builders to any must not qualify.
  await writeFile(join(root, 'consumer.ts'), typecheckConsumer(profile));
  await writeFile(
    join(root, 'client.consumer.ts'),
    'export declare const operations: any;\n',
  );
  await writeFile(
    join(root, 'client.consumer.schemas.ts'),
    'export declare const requestSchemas: any;\nexport declare const responseSchemas: any;\n',
  );
  await assert.rejects(
    collectTypecheck(root, typescript, join(logs, 'erased'), false),
  );
  assert.match(
    await readFile(join(logs, 'erased.stdout.log'), 'utf8'),
    /TS2578/,
  );
});

void test('measurement rejects malformed evidence and preserves stdout/stderr on failed compiler processes', async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, 'tsconfig.json'), '{}');
  const entry = join(root, 'fake.cjs');
  await writeFile(
    entry,
    `process.stdout.write('Check time: unsupported\\n');process.stderr.write('diagnostic');`,
  );
  await assert.rejects(
    collectTypecheck(root, entry, join(root, 'missing'), true),
    /diagnostic format/,
  );
  assert.equal(
    await readFile(join(root, 'missing.stdout.log'), 'utf8'),
    'Check time: unsupported\n',
  );
  assert.equal(
    await readFile(join(root, 'missing.stderr.log'), 'utf8'),
    'diagnostic',
  );
  await writeFile(
    entry,
    `process.stdout.write('error TS1234: synthetic failure');process.stderr.write('failed process');process.exit(2);`,
  );
  await assert.rejects(
    collectTypecheck(root, entry, join(root, 'failed'), true),
  );
  assert.match(
    await readFile(join(root, 'failed.stdout.log'), 'utf8'),
    /synthetic failure/,
  );
  assert.equal(
    await readFile(join(root, 'failed.stderr.log'), 'utf8'),
    'failed process',
  );
});

void test('generation failures preserve synthetic inputs and compiler diagnostics', async (t) => {
  const root = await temporary(t);
  const compiler = join(root, 'compiler.mjs');
  await writeFile(
    compiler,
    `export function compile() {throw new Error('synthetic compiler rejection');}`,
  );
  const profile = join(root, 'profile.json');
  await writeFile(profile, JSON.stringify(typecheckSmoke));
  const generated = join(root, 'generated');
  await assert.rejects(
    runLogged(
      process.execPath,
      [
        fileURLToPath(
          new URL('../bench/typecheck-generate.ts', import.meta.url),
        ),
        compiler,
        generated,
        profile,
      ],
      root,
      join(root, 'generation'),
      nodeEnvironment(),
      30_000,
    ),
  );
  assert.match(
    await readFile(join(root, 'generation.stderr.log'), 'utf8'),
    /synthetic compiler rejection/,
  );
  assert.match(
    await readFile(join(generated, 'input.json'), 'utf8'),
    /Synthetic distinct parser graphs/,
  );
});

void test('qualification rejects omitted unprobed operations and schemas', async (t) => {
  const profile = typecheckSettings({ profiles: ['base'] }).profiles[0]!;
  const input = typecheckWorkload(profile);
  const generated = await compile(input.document, input.options);
  const root = await generatedTestWorkspace(t, generated);
  const client = await importGenerated(root, 'client.consumer.ts');
  const schemas = await importGenerated(root, 'client.consumer.schemas.ts');
  verifyTypecheckInventory(profile, client, schemas);
  delete input.document.paths['/items/1'];
  input.options.surfaces.consumer = input.options.surfaces.consumer.filter(
    (id) => id !== 'write00001',
  );
  const omittedRoot = await generatedTestWorkspace(
    t,
    await compile(input.document, input.options),
  );
  const omittedClient = await importGenerated(
    omittedRoot,
    'client.consumer.ts',
  );
  const omittedSchemas = await importGenerated(
    omittedRoot,
    'client.consumer.schemas.ts',
  );
  assert.throws(
    () => verifyTypecheckInventory(profile, omittedClient, omittedSchemas),
    /operation inventory/,
  );
  assert.throws(
    () => verifyTypecheckInventory(profile, client, omittedSchemas),
    /requestSchemas inventory/,
  );
});

void test('type probes reject partial numeric and array element erasure', async (t) => {
  const input = typecheckWorkload(typecheckSmoke);
  const files = await compile(input.document, input.options);
  for (const [id, pattern, replacement] of [
    ['score', /score: number/g, 'score: any'],
    ['tags', /tags: Array<string>/g, 'tags: Array<any>'],
  ] as const) {
    const mutated = Object.fromEntries(
      Object.entries(files).map(([name, source]) => [
        name,
        source.replace(pattern, replacement),
      ]),
    );
    assert.notDeepEqual(
      mutated,
      files,
      `${id}: negative control must erase a field type`,
    );
    const root = await generatedTestWorkspace(t, mutated);
    await writeFile(
      join(root, 'consumer.ts'),
      typecheckConsumer(typecheckSmoke),
    );
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: scaleCompilerOptions,
        include: ['./*.ts'],
      }),
    );
    await assert.rejects(
      collectTypecheck(root, typescript, join(root, 'erased'), false),
    );
    assert.match(
      await readFile(join(root, 'erased.stdout.log'), 'utf8'),
      /TS2578/,
    );
  }
});
