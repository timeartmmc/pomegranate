import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compile, runProject } from '../dist/index.js';
import type { CompileOptions } from '../dist/index.js';
import { synchronizeOutputs } from '../dist/outputs.js';
import { commandFailure, invalidOptions, json, record } from './assertions.ts';
import { fixture, preparation, temporary, fileSnapshot } from './helpers.ts';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

void test('configuration and programmatic selections produce the same complete output', async (t) => {
  const root = await temporary(t);
  const document = fixture();
  const options: CompileOptions = {
    clients: ['consumer'],
    transportHeaders: ['Idempotency-Key'],
    standalone: {
      widget: { schema: '#/components/schemas/Widget', usage: 'response' },
    },
  };
  await writeFile(join(root, 'openapi.json'), JSON.stringify(document));
  const config = join(root, 'pom.json');
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      ...options,
    }),
  );
  await runProject(config);
  const expected = await compile(document, options);
  for (const [name, source] of Object.entries(expected))
    assert.equal(await readFile(join(root, 'generated', name), 'utf8'), source);
  assert.equal((await runProject(config, { check: true })).clean, true);
  const snapshot = await fileSnapshot(join(root, 'generated'));
  for (const selection of [
    { ...options, transportHeaders: [123] },
    { ...options, targets: { consumer: 'unknown' } },
  ]) {
    await writeFile(
      config,
      JSON.stringify({
        version: 2,
        openapi: './openapi.json',
        output: './generated',
        ...selection,
      }),
    );
    await assert.rejects(runProject(config));
    await assert.rejects(invalidOptions(compile, document, selection));
    assert.deepEqual(await fileSnapshot(join(root, 'generated')), snapshot);
  }
});

async function project(t: TestContext) {
  const root = await temporary(t);
  const config = join(root, 'pom.json');
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      clients: ['consumer', 'staff'],
    }),
  );
  await writeFile(join(root, 'openapi.json'), JSON.stringify(fixture()));
  return { root, config };
}

void test('config-relative paths work from another working directory and CLI checks drift read-only', async (t) => {
  const { root, config } = await project(t);
  const elsewhere = join(root, 'another working directory');
  await mkdir(elsewhere);
  await exec(process.execPath, [cli, 'generate', '--config', config], {
    cwd: elsewhere,
  });
  await exec(process.execPath, [cli, 'check', '--config', config], {
    cwd: elsewhere,
  });
  const output = join(root, 'generated/client.consumer.ts');
  await writeFile(
    output,
    `${await readFile(output, 'utf8')}\n// local change\n`,
  );
  const before = {
    source: await readFile(output, 'utf8'),
    mtime: (await stat(output)).mtimeMs,
  };
  await assert.rejects(
    exec(process.execPath, [cli, 'check', '--config', config], {
      cwd: elsewhere,
    }),
    commandFailure(1, /modified owned output/),
  );
  assert.deepEqual(
    {
      source: await readFile(output, 'utf8'),
      mtime: (await stat(output)).mtimeMs,
    },
    before,
  );
});

void test('unsupported semantics reject before even creating an output directory', async (t) => {
  const { root, config } = await project(t);
  const document = fixture();
  Object.assign(preparation(document).responses, {
    default: {
      description: 'Undeclared semantics',
    },
  });
  await writeFile(join(root, 'openapi.json'), JSON.stringify(document));
  await assert.rejects(runProject(config), /exact numeric/);
  assert.deepEqual((await readdir(root)).sort(), ['openapi.json', 'pom.json']);
});

void test('invalid execution options cannot turn a read-only request into generation', async (t) => {
  const { root, config } = await project(t);
  for (const options of [
    { chek: true },
    { check: true, chek: true },
    { check: 'true' },
    { check: 0 },
    { check: null },
    { check: undefined },
    null,
    [],
  ]) {
    await assert.rejects(
      invalidOptions(runProject, config, options),
      /project options/,
    );
    await assert.rejects(stat(join(root, 'generated')), { code: 'ENOENT' });
  }
  const missing = await runProject(config, { check: true });
  assert.equal(missing.clean, false);
  await assert.rejects(stat(join(root, 'generated')), { code: 'ENOENT' });
  await runProject(config, { check: false });
  const before = await fileSnapshot(join(root, 'generated'));
  await assert.rejects(
    invalidOptions(runProject, config, { chek: true }),
    /unsupported keyword/,
  );
  assert.deepEqual(await fileSnapshot(join(root, 'generated')), before);
  assert.equal((await runProject(config, { check: true })).clean, true);
});

void test('execution mode is captured before asynchronous input reading', async (t) => {
  const { root, config } = await project(t);
  const options = { check: true };
  const checking = runProject(config, options);
  options.check = false;
  assert.equal((await checking).clean, false);
  await assert.rejects(stat(join(root, 'generated')), { code: 'ENOENT' });
  let reads = 0;
  await runProject(config, {
    get check() {
      return reads++ === 0;
    },
  });
  assert.equal(reads, 1);
  await assert.rejects(stat(join(root, 'generated')), { code: 'ENOENT' });
});

void test('invalid config fields and malformed JSON have actionable diagnostics', async (t) => {
  const { root, config } = await project(t);
  await writeFile(config, '{');
  await assert.rejects(runProject(config), /invalid JSON/);
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      openapi: './openapi.json',
      output: './generated',
    }),
  );
  await assert.rejects(runProject(config), /config version 2/);
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      discoverSibling: true,
    }),
  );
  await assert.rejects(
    runProject(config),
    /discoverSibling.*unsupported keyword/,
  );
  await assert.rejects(stat(join(root, 'generated')), { code: 'ENOENT' });
});

void test('CLI has a usable help/usage boundary and propagates compilation failure', async (t) => {
  assert.match(
    (await exec(process.execPath, [cli, '--help'])).stdout,
    /Usage: pom/,
  );
  await assert.rejects(
    exec(process.execPath, [cli, 'generate']),
    commandFailure(2, /Usage: pom/),
  );
  const { root, config } = await project(t);
  await writeFile(join(root, 'openapi.json'), 'not JSON');
  await assert.rejects(
    exec(process.execPath, [cli, 'generate', '--config', config]),
    commandFailure(1, /invalid JSON/),
  );
});

void test('changing selected clients checks stale output read-only and cleans only unchanged owned client files', async (t) => {
  const { root, config } = await project(t);
  await runProject(config);
  const output = join(root, 'generated');
  await writeFile(join(output, 'application-notes.ts'), 'user-owned notes');
  const selection = record(json(await readFile(config, 'utf8')));
  selection.clients = ['consumer'];
  await writeFile(config, JSON.stringify(selection));
  const before = await fileSnapshot(output);
  const drift = await runProject(config, { check: true });
  assert.ok(drift.changes.includes('stale: client.staff.ts'));
  assert.deepEqual(await fileSnapshot(output), before);
  await runProject(config);
  for (const name of [
    'client.staff.ts',
    'client.staff.operations.ts',
    'client.staff.schemas.ts',
  ])
    await assert.rejects(stat(join(output, name)), { code: 'ENOENT' });
  assert.equal(
    await readFile(join(output, 'application-notes.ts'), 'utf8'),
    'user-owned notes',
  );
  assert.equal((await runProject(config, { check: true })).clean, true);
  const inventory = record(
    json(await readFile(join(output, '.pom-manifest.json'), 'utf8')),
  );
  assert.deepEqual(Object.keys(record(inventory.files)).sort(), [
    'client.consumer.operations.ts',
    'client.consumer.schemas.ts',
    'client.consumer.ts',
    'runtime.ts',
  ]);
});

void test('an edited deselected client blocks the complete output change before writes', async (t) => {
  const { root, config } = await project(t);
  await runProject(config);
  const output = join(root, 'generated');
  await writeFile(
    join(output, 'client.staff.ts'),
    'locally edited staff client',
  );
  const selection = record(json(await readFile(config, 'utf8')));
  selection.clients = ['consumer'];
  await writeFile(config, JSON.stringify(selection));
  const document = fixture();
  document.components.schemas.PreparationInput.properties.label.maxLength = 50;
  await writeFile(join(root, 'openapi.json'), JSON.stringify(document));
  const before = await fileSnapshot(output);
  await assert.rejects(
    runProject(config),
    /modified owned output: client.staff.ts/,
  );
  assert.deepEqual(await fileSnapshot(output), before);
});

void test('first-milestone output inventory migrates safely without accepting an edited stale file', async (t) => {
  const { root, config } = await project(t);
  const output = join(root, 'generated');
  const oldFiles = {
    'index.ts': 'old entry',
    'operations.ts': 'old operations',
    'schemas.ts': 'old schemas',
    'runtime.ts': 'old runtime',
  };
  await synchronizeOutputs(output, oldFiles, [], false);
  await writeFile(join(output, 'index.ts'), 'user edit to old entry');
  const before = await fileSnapshot(output);
  await assert.rejects(runProject(config), /modified owned output: index.ts/);
  assert.deepEqual(await fileSnapshot(output), before);
  await writeFile(join(output, 'index.ts'), oldFiles['index.ts']);
  await runProject(config);
  for (const name of ['index.ts', 'operations.ts', 'schemas.ts'])
    await assert.rejects(stat(join(output, name)), { code: 'ENOENT' });
  assert.equal((await runProject(config, { check: true })).clean, true);
});

void test('unknown selections and invalid unselected operations leave existing outputs unchanged', async (t) => {
  const { root, config } = await project(t);
  await runProject(config);
  const output = join(root, 'generated');
  const before = await fileSnapshot(output);
  const selection = record(json(await readFile(config, 'utf8')));
  selection.clients = ['unknown'];
  await writeFile(config, JSON.stringify(selection));
  await assert.rejects(runProject(config), /undeclared surface/);
  assert.deepEqual(await fileSnapshot(output), before);
  selection.clients = ['consumer'];
  await writeFile(config, JSON.stringify(selection));
  const document = fixture();
  Object.assign(document.paths['/api/staff/reports'].get, {
    security: [{ WidgetSession: ['editor'] }],
  });
  await writeFile(join(root, 'openapi.json'), JSON.stringify(document));
  await assert.rejects(runProject(config), /role requirements are unsupported/);
  assert.deepEqual(await fileSnapshot(output), before);
});
