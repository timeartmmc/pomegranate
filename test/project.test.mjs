import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { runProject } from '../dist/index.js';
import { fixture, preparation, temporary, fileSnapshot } from './helpers.mjs';
import { synchronizeOutputs } from '../dist/outputs.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

async function project(t) {
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

test('config-relative paths work from another working directory and CLI checks drift read-only', async (t) => {
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
    (error) => error.code === 1 && /modified owned output/.test(error.stderr),
  );
  assert.deepEqual(
    {
      source: await readFile(output, 'utf8'),
      mtime: (await stat(output)).mtimeMs,
    },
    before,
  );
});

test('unsupported semantics reject before even creating an output directory', async (t) => {
  const { root, config } = await project(t);
  const document = fixture();
  preparation(document).responses.default = {
    description: 'Undeclared semantics',
  };
  await writeFile(join(root, 'openapi.json'), JSON.stringify(document));
  await assert.rejects(runProject(config), /exact numeric/);
  assert.deepEqual((await readdir(root)).sort(), ['openapi.json', 'pom.json']);
});

test('invalid config fields and malformed JSON have actionable diagnostics', async (t) => {
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

test('CLI has a usable help/usage boundary and propagates compilation failure', async (t) => {
  assert.match(
    (await exec(process.execPath, [cli, '--help'])).stdout,
    /Usage: pom/,
  );
  await assert.rejects(
    exec(process.execPath, [cli, 'generate']),
    (error) => error.code === 2 && /Usage: pom/.test(error.stderr),
  );
  const { root, config } = await project(t);
  await writeFile(join(root, 'openapi.json'), 'not JSON');
  await assert.rejects(
    exec(process.execPath, [cli, 'generate', '--config', config]),
    (error) => error.code === 1 && /invalid JSON/.test(error.stderr),
  );
});

test('changing selected clients checks stale output read-only and cleans only unchanged owned client files', async (t) => {
  const { root, config } = await project(t);
  await runProject(config);
  const output = join(root, 'generated');
  await writeFile(join(output, 'application-notes.ts'), 'user-owned notes');
  const selection = JSON.parse(await readFile(config, 'utf8'));
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
  const inventory = JSON.parse(
    await readFile(join(output, '.pom-manifest.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(inventory.files).sort(), [
    'client.consumer.operations.ts',
    'client.consumer.schemas.ts',
    'client.consumer.ts',
    'runtime.ts',
  ]);
});

test('an edited deselected client blocks the complete output change before writes', async (t) => {
  const { root, config } = await project(t);
  await runProject(config);
  const output = join(root, 'generated');
  await writeFile(
    join(output, 'client.staff.ts'),
    'locally edited staff client',
  );
  const selection = JSON.parse(await readFile(config, 'utf8'));
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

test('first-milestone output inventory migrates safely without accepting an edited stale file', async (t) => {
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

test('unknown selections and invalid unselected operations leave existing outputs unchanged', async (t) => {
  const { root, config } = await project(t);
  await runProject(config);
  const output = join(root, 'generated');
  const before = await fileSnapshot(output);
  const selection = JSON.parse(await readFile(config, 'utf8'));
  selection.clients = ['unknown'];
  await writeFile(config, JSON.stringify(selection));
  await assert.rejects(runProject(config), /undeclared surface/);
  assert.deepEqual(await fileSnapshot(output), before);
  selection.clients = ['consumer'];
  await writeFile(config, JSON.stringify(selection));
  const document = fixture();
  document.paths['/api/staff/reports'].get.security = [
    { WidgetSession: ['editor'] },
  ];
  await writeFile(join(root, 'openapi.json'), JSON.stringify(document));
  await assert.rejects(runProject(config), /role requirements are unsupported/);
  assert.deepEqual(await fileSnapshot(output), before);
});
