import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { compile } from '../dist/index.js';
import { shareQueryData } from '../dist/query-sharing.js';
import type { ClientConfig } from '../src/execution-runtime.ts';
import { entry, json, record } from './assertions.ts';
import {
  anyJsonConsumer,
  anyJsonFixture,
  anyJsonSamples,
  anyJsonSelection,
  verifyAnyJson,
} from './any-json-fixture.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

void test('empty schemas accept every JSON type through aliases, containers and protocol boundaries', async (t) => {
  const samples = anyJsonSamples;
  const reference = new Ajv2020().compile({});
  for (const version of ['3.0.4', '3.1.2']) {
    const document = anyJsonFixture();
    document.openapi = version;
    if (version.startsWith('3.0.'))
      Object.assign(document.components.schemas, {
        Nullable: { nullable: true },
      });
    const before = structuredClone(document);
    const root = await generatedTestWorkspace(
      t,
      await compile(document, anyJsonSelection),
    );
    assert.deepEqual(document, before);
    const [input, output, nullable] = await Promise.all([
      importGenerated<StandaloneModule>(root, 'standalone.input.ts'),
      importGenerated<StandaloneModule>(root, 'standalone.output.ts'),
      importGenerated<StandaloneModule>(root, 'standalone.nullable.ts'),
    ]);
    const client = await importGenerated<RuntimeClient>(root, 'client.json.ts');
    verifyAnyJson(client, input, output);
    for (const sample of samples) {
      assert.equal(reference(sample), true);
      assert.deepEqual(nullable.schema.parse(sample), sample);
    }
    const list = await importGenerated<StandaloneModule>(
      root,
      'standalone.list.ts',
    );
    const bag = await importGenerated<StandaloneModule>(
      root,
      'standalone.bag.ts',
    );
    assert.deepEqual(list.schema.parse(samples), samples);
    assert.deepEqual(bag.schema.parse({ values: samples, scalar: true }), {
      values: samples,
      scalar: true,
    });
  }
});

void test('arbitrary JSON values are detached, preserve payload keys, and retain directional projection', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(anyJsonFixture(), anyJsonSelection),
  );
  const module = await importGenerated<StandaloneModule>(
    root,
    'standalone.input.ts',
  );
  const source = { nested: { list: [1, { value: true }] } };
  const parsed = record(module.schema.parse(source));
  assert.notEqual(parsed, source);
  assert.notEqual(parsed['nested'], source.nested);
  source.nested.list.push(2);
  assert.deepEqual(parsed, { nested: { list: [1, { value: true }] } });
  const shared = { list: [1] };
  const aliases = record(module.schema.parse({ left: shared, right: shared }));
  assert.notEqual(aliases['left'], shared);
  assert.notEqual(aliases['left'], aliases['right']);
  const dangerous = json(
    '{"__proto__":{"safe":true},"constructor":{"prototype":[1]},"prototype":null}',
  );
  const copied = record(module.schema.parse(dangerous));
  assert.deepEqual(copied, dangerous);
  assert.equal(Object.getPrototypeOf(copied), Object.prototype);
  assert.equal(Object.hasOwn(copied, '__proto__'), true);
  const request = await importGenerated<StandaloneModule>(
    root,
    'standalone.request.ts',
  );
  const response = await importGenerated<StandaloneModule>(
    root,
    'standalone.response.ts',
  );
  assert.deepEqual(request.schema.parse({ value: null, secret: [true] }), {
    value: null,
    secret: [true],
  });
  assert.equal(
    request.schema.safeParse({ value: 1, secret: null, server: true }).success,
    false,
  );
  assert.deepEqual(
    response.schema.parse({
      value: false,
      server: { id: 1 },
      secret: 'excluded',
    }),
    { value: false, server: { id: 1 } },
  );
  const next = module.schema.parse(dangerous);
  assert.equal(shareQueryData(copied, next), copied);
});

void test('empty schemas reject non-JSON values and missing required values without synthesizing defaults', async (t) => {
  const document = anyJsonFixture({
    title: 'Any JSON',
    description: 'Annotation only',
    default: { defaulted: true },
  });
  const root = await generatedTestWorkspace(
    t,
    await compile(document, anyJsonSelection),
  );
  const module = await importGenerated<StandaloneModule>(
    root,
    'standalone.input.ts',
  );
  const client = await importGenerated<RuntimeClient>(root, 'client.json.ts');
  const cycle: Record<string, unknown> = {};
  cycle['self'] = cycle;
  const polluted = Object.create({ inherited: true }) as unknown;
  const inheritedHole: unknown = Object.setPrototypeOf(
    Array(1),
    Object.assign(Object.create(Array.prototype) as object, { 0: 'inherited' }),
  );
  const invalid: unknown[] = [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol('value'),
    () => 1,
    new Date(),
    new Map(),
    new Uint8Array([1]),
    polluted,
    cycle,
    [undefined],
    Array(1),
    inheritedHole,
    { value: undefined },
    { value: cycle },
  ];
  for (const value of invalid) {
    assert.equal(module.schema.safeParse(value).success, false, String(value));
    assert.throws(
      () => entry(client.operations, 'putValue').build({ body: value }),
      client.RequestValidationError,
    );
  }
  assert.throws(
    () => entry(client.operations, 'putValue').build(),
    client.RequestValidationError,
  );
  assert.deepEqual(module.schema.parse({}), {});
  const directional = await importGenerated<StandaloneModule>(
    root,
    'standalone.request.ts',
  );
  assert.equal(directional.schema.safeParse({ secret: true }).success, false);
  assert.equal(
    directional.schema.safeParse({ value: undefined, secret: true }).success,
    false,
  );
});

void test('scoped execution freezes detached arbitrary JSON while returning mutable response data', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(anyJsonFixture(), anyJsonSelection),
  );
  const module = await importGenerated<{
    createClient: (config: ClientConfig) => {
      getValue: {
        call: (args: { context: object }) => Promise<{ data: unknown }>;
      };
    };
  }>(root, 'client.json.ts');
  let inspected: unknown;
  const client = module.createClient({
    namespace: 'json-inspection',
    execute: async (_request, execution) => {
      const response = execution.validateResponse({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: '{"__proto__":{"items":[1]},"value":{"nested":true}}',
      });
      assert.equal(response.kind, 'success');
      if (response.kind === 'success') {
        inspected = response.data;
        const body = record(response.data);
        const child = record(body['__proto__']);
        assert.equal(Object.isFrozen(body), true);
        assert.equal(Object.isFrozen(child), true);
        assert.equal(Object.isFrozen(child['items']), true);
        assert.equal(Reflect.set(child, 'extra', true), false);
      }
      return response;
    },
  });
  const result = await client.getValue.call({ context: {} });
  assert.notEqual(result.data, inspected);
  const body = record(result.data);
  assert.equal(Object.isFrozen(body), false);
  const child = record(body['__proto__']);
  assert.equal(Reflect.set(child, 'extra', true), true);
  assert.equal(
    Object.hasOwn(record(record(inspected)['__proto__']), 'extra'),
    false,
  );
});

void test('empty schema support does not infer types or discard reference constraints', async () => {
  for (const schema of [
    { properties: { value: {} } },
    { minimum: 1 },
    { enum: [1, null] },
    { items: {} },
    { additionalProperties: {} },
  ] satisfies Schema[])
    await assert.rejects(
      compile(anyJsonFixture(schema), anyJsonSelection),
      /implicit types are unsupported/,
    );
  for (const constraint of [
    { minimum: 1 },
    { minLength: 1 },
    { minItems: 1 },
    { minProperties: 1 },
  ]) {
    const document = anyJsonFixture();
    Object.assign(document.components.schemas.Alias, constraint);
    await assert.rejects(
      compile(document, anyJsonSelection),
      /constraint is unsupported on referenced json/,
    );
  }
  const parameter = anyJsonFixture();
  Object.assign(parameter.paths['/value'].get, {
    parameters: [{ name: 'q', in: 'query', schema: {} }],
  });
  await assert.rejects(
    compile(parameter, anyJsonSelection),
    /parameters require primitive schemas/,
  );
  const header = anyJsonFixture();
  Object.assign(header.paths['/value'].get.responses[200], {
    headers: { 'X-Value': { schema: {} } },
  });
  await assert.rejects(
    compile(header, anyJsonSelection),
    /response headers require string schemas/,
  );
  const multipart = anyJsonFixture();
  Object.assign(multipart.paths['/value'].post.requestBody, {
    content: {
      'multipart/form-data': {
        schema: {
          type: 'object',
          properties: { value: {} },
          required: ['value'],
        },
      },
    },
  });
  await assert.rejects(
    compile(multipart, { ...anyJsonSelection, targets: { json: 'browser' } }),
    /multipart fields require strings, files or arrays of files/,
  );
});

void test('arbitrary JSON generated contracts retain exact JSON types and readonly scoped inspections', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(anyJsonFixture(), anyJsonSelection),
  );
  await writeFile(join(root, 'consumer.ts'), anyJsonConsumer);
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        skipLibCheck: false,
        noEmit: true,
        allowImportingTsExtensions: true,
        types: [],
      },
      include: ['*.ts'],
    }),
  );
  try {
    await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL('../node_modules/typescript/bin/tsc', import.meta.url),
        ),
        '-p',
        root,
      ],
      { timeout: 30_000 },
    );
  } catch (error) {
    if (error instanceof Error && 'stdout' in error)
      error.message += String(error.stdout);
    throw error;
  }
});
