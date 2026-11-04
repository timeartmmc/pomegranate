import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { open, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import { identifier } from '../dist/code.js';
import { schemaRenderer } from '../dist/emit-schema.js';
import { parseYaml } from '../dist/yaml.js';
import { fileSnapshot, fixture, temporary } from './helpers.ts';
import { queryFixture } from './query-fixture.ts';
import { record } from './assertions.ts';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

void test('declaration budgets count UTF-8 bytes across drained schema chunks', () => {
  const renderer = schemaRenderer(
    { request: {}, response: {} },
    () => identifier('unused'),
    () => 'unknown',
  );
  const chunk = `//${'é'.repeat(512 * 1024 - 1)}`;
  assert.equal(Buffer.byteLength(chunk), 1024 * 1024);
  for (let index = 0; index < 32; index++) {
    renderer.push(chunk);
    renderer.takeDeclarations();
  }
  // renderComponents drains declarations after every schema. Draining must not
  // reset the budget while the caller retains those module fragments.
  assert.throws(
    () => renderer.push('x'),
    (error) =>
      error instanceof ContractError &&
      /generated source exceeds the 32 MiB limit/.test(error.message),
  );
});

void test('shared policy metadata is budgeted before joining operation declarations', async () => {
  const metadata = { note: 'x'.repeat(768 * 1024) };
  const ids = Array.from({ length: 48 }, (_, index) => `large${index}`);
  const document = {
    openapi: '3.1.1',
    info: { title: 'Synthetic shared policy', version: '1' },
    'x-pom-policy': { version: 3, fields: { note: { type: 'string' } } },
    paths: Object.fromEntries(
      ids.map((id) => [
        `/${id}`,
        {
          get: {
            operationId: id,
            'x-pom': metadata,
            responses: { 204: { description: 'Empty' } },
          },
        },
      ]),
    ),
  };
  const yaml = stringify(document);
  assert.ok(Buffer.byteLength(yaml) < 1024 * 1024);
  await assert.rejects(
    compile(parseYaml(yaml, 'policy.yaml'), {
      clients: ['consumer'],
      surfaces: { consumer: ids },
    }),
    (error) => {
      assert.ok(error instanceof ContractError);
      assert.match(error.message, /generated source exceeds the 32 MiB limit/);
      assert.match(error.location, /^paths\.\/large\d+\.get$/);
      return true;
    },
  );
});

for (const existing of [false, true]) {
  void test(`input file failures preserve ${existing ? 'existing' : 'missing'} outputs`, async (t) => {
    const root = await temporary(t);
    const input = join(root, 'openapi.json');
    const config = join(root, 'pom.json');
    const output = join(root, 'generated');
    const settings = {
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      clients: ['consumer'],
    };
    await writeFile(input, JSON.stringify(fixture()));
    await writeFile(config, JSON.stringify(settings));
    if (existing) await runProject(config);
    const snapshot = () => (existing ? fileSnapshot(output) : readdir(root));
    const file = await open(input, 'w');
    await file.truncate(32 * 1024 * 1024 + 1);
    await file.close();
    const before = await snapshot();
    for (const check of [true, false]) {
      await assert.rejects(runProject(config, { check }), /32 MiB file limit/);
      assert.deepEqual(await snapshot(), before);
    }
    await writeFile(config, JSON.stringify({ ...settings, openapi: '.' }));
    for (const check of [true, false]) {
      await assert.rejects(
        runProject(config, { check }),
        /regular file|EISDIR/,
      );
      assert.deepEqual(await snapshot(), before);
    }
  });
}

void test(
  'CLI rejects named pipes and devices promptly',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await temporary(t);
    const pipe = join(root, 'pipe');
    await exec('mkfifo', [pipe]);
    const config = join(root, 'pom.json');
    for (const path of [pipe, '/dev/zero']) {
      for (const kind of ['config', 'openapi']) {
        await writeFile(
          config,
          JSON.stringify({
            version: 2,
            openapi: path,
            output: './generated',
            clients: ['consumer'],
          }),
        );
        await assert.rejects(
          exec(
            process.execPath,
            [cli, 'check', '--config', kind === 'config' ? path : config],
            { timeout: 3000 },
          ),
          (error: unknown) =>
            error instanceof Error &&
            error.message.includes('input must be a regular file'),
        );
        assert.deepEqual((await readdir(root)).sort(), ['pipe', 'pom.json']);
      }
    }
  },
);

void test('selection d has executable module filenames and preserves its identity', async (t) => {
  const root = await temporary(t);
  const document = queryFixture();
  document['x-pom-policy'].surfaces = ['d', 'd_'];
  for (const path of Object.values(document.paths))
    for (const operation of Object.values(record(path)))
      record(record(operation)['x-pom'])['surfaces'] = ['d', 'd_'];
  const files = await compile(document, {
    clients: ['d', 'd_'],
    executionClients: ['d'],
    queries: { d: ['readItem'] },
    transportHeaders: ['X-Language'],
    standalone: {
      d: { schema: '#/components/schemas/Item', usage: 'response' },
      d_: { schema: '#/components/schemas/Item', usage: 'request' },
    },
  });
  for (const name of [
    'client._d.ts',
    'client.d_.ts',
    'standalone._d.ts',
    'standalone.d_.ts',
  ])
    assert.ok(Object.hasOwn(files, name));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries(files))
    await writeFile(join(root, name), source);
  const entry = (await import(
    pathToFileURL(join(root, 'standalone._d.ts')).href
  )) as { schema: { parse: (input: unknown) => unknown } };
  assert.deepEqual(entry.schema.parse({ id: 'one', label: 'Two' }), {
    id: 'one',
    label: 'Two',
  });
  const client = await readFile(join(root, 'client._d.queries.ts'), 'utf8');
  assert.match(client, /client: 'd'/);
  assert.match(client, /\.\/client\._d\.operations\.ts/);
  await writeFile(
    join(root, 'consume.ts'),
    "import {operations} from './client._d.ts'; import {schema} from './standalone._d.ts'; operations.readItem.build({path:{id:'one'}}); schema.parse({id:'one',label:'Two'});",
  );
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        allowImportingTsExtensions: true,
        strict: true,
        noEmit: true,
        types: [],
      },
      files: ['consume.ts'],
    }),
  );
  await exec(process.execPath, [
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
});

void test('generation diagnoses excessive source before formatting or writing', async (t) => {
  const root = await temporary(t);
  const base = fixture();
  const content = {
    'application/json': {
      schema: { type: 'string', const: 'x'.repeat(16_000) },
    },
  };
  const document = {
    ...base,
    paths: Object.fromEntries(
      Array.from({ length: 512 }, (_, index) => [
        `/large${index}`,
        {
          post: {
            ...base.paths['/api/widgets/{widgetId}/preparations'].post,
            operationId: `large${index}`,
            parameters: [],
            requestBody: { required: true, content },
            responses: { 200: { description: 'Large', content } },
          },
        },
      ]),
    ),
  };
  const yaml = stringify(document);
  assert.ok(Buffer.byteLength(yaml) < 256 * 1024, 'shared YAML stays small');
  await writeFile(join(root, 'openapi.yaml'), yaml);
  const config = join(root, 'pom.json');
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.yaml',
      output: './generated',
      clients: ['consumer'],
    }),
  );
  const output = join(root, 'generated');
  for (const existing of [false, true]) {
    if (existing) {
      await writeFile(join(root, 'openapi.yaml'), stringify(base));
      await runProject(config);
      await writeFile(join(root, 'openapi.yaml'), yaml);
    }
    const snapshot = () => (existing ? fileSnapshot(output) : readdir(root));
    const before = await snapshot();
    for (const check of [true, false]) {
      await assert.rejects(runProject(config, { check }), (error) => {
        assert.ok(error instanceof ContractError);
        assert.match(
          error.message,
          /generated source exceeds the 32 MiB limit/,
        );
        assert.notEqual(error.location, 'generated output');
        return true;
      });
      assert.deepEqual(await snapshot(), before);
    }
  }
});
