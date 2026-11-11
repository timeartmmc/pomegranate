import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compile } from '../dist/index.js';
import { entry, record } from './assertions.ts';
import {
  compositionGraphConsumer,
  compositionGraphFixture,
  compositionGraphSelection,
  compositionGraphValue,
} from './composition-graph-fixture.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';

void test('shared allOf graphs retain bounded output and independent runtime values at 22 levels', async (t) => {
  let previous = 0;
  for (const depth of [8, 12, 22]) {
    const files = await compile(
      compositionGraphFixture(depth),
      compositionGraphSelection(depth),
    );
    const bytes = Object.values(files).reduce(
      (sum, source) => sum + Buffer.byteLength(source),
      0,
    );
    assert.ok(bytes < 512 * 1024, `${depth} levels emitted ${bytes} bytes`);
    if (previous > 0) assert.ok(bytes < previous + 128 * 1024);
    previous = bytes;
    const copied: unknown = JSON.parse(
      JSON.stringify(compositionGraphFixture(depth)),
    );
    assert.deepEqual(
      files,
      await compile(copied, compositionGraphSelection(depth)),
    );
    const root = await generatedTestWorkspace(t, files);
    for (const usage of ['request', 'response'] as const) {
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        `standalone.${usage}.ts`,
      );
      const input = compositionGraphValue(depth, usage);
      const output = record(schema.parse(input));
      assert.deepEqual(output, input);
      assert.notEqual(output, input);
      assert.notEqual(output.left, record(input).left);
      assert.notEqual(output.left, output.right);
      assert.equal(
        schema.safeParse(compositionGraphValue(depth, usage, '')).success,
        false,
      );
      assert.equal(schema.safeParse({ left: {} }).success, false);
    }
  }
});

void test('unselected shared graphs do not affect selected output', async () => {
  const document = { ...compositionGraphFixture(22), paths: {} };
  const selection = {
    clients: [],
    standalone: {
      leaf: { schema: '#/components/schemas/Leaf', usage: 'response' },
    },
  } as const;
  const full = await compile(document, selection);
  const minimal = await compile(
    {
      ...document,
      components: { schemas: { Leaf: document.components.schemas.Leaf } },
      paths: {},
    },
    selection,
  );
  assert.deepEqual(full, minimal);
});

void test('shared inline types compose across owners, recursive maps and emitted declarations', async (t) => {
  const files = await compile(
    compositionGraphFixture(22),
    compositionGraphSelection(22, true),
  );
  const root = await generatedTestWorkspace(t, files, 'generated');
  const first = await importGenerated<RuntimeClient>(
    root,
    'generated/client.first.ts',
  );
  const second = await importGenerated<RuntimeClient>(
    root,
    'generated/client.second.ts',
  );
  const request = compositionGraphValue(22, 'request');
  const body = { ...request, stamp: 'composed' };
  for (const client of [first, second]) {
    const operation = entry(client.operations, 'save');
    const built = record(operation.build({ body }).body);
    assert.notEqual(built.left, built.right);
    assert.deepEqual(built, body);
    const observed = {
      ...compositionGraphValue(22, 'response'),
      stamp: 'composed',
    };
    const parsed = operation.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(observed),
    });
    assert.ok(parsed.kind === 'success');
    assert.deepEqual(parsed.data, observed);
  }
  const nodes = entry(first.operations, 'nodes');
  const child = { value: 1, children: { leaf: { value: 2 } } };
  const parsed = record(
    nodes.build({ body: { left: child, right: child } }).body,
  );
  assert.deepEqual(parsed, { left: child, right: child });
  assert.notEqual(parsed.left, parsed.right);
  const schemas = await importGenerated<{
    requestSchemas: Readonly<Record<string, unknown>>;
    responseSchemas: Readonly<Record<string, unknown>>;
  }>(root, 'generated/client.first.schemas.ts');
  for (const inventory of [schemas.requestSchemas, schemas.responseSchemas])
    assert.ok(
      Object.keys(inventory).every((name) => !name.includes('$inline')),
    );

  await writeFile(join(root, 'consumer.ts'), compositionGraphConsumer);
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
        allowImportingTsExtensions: true,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: 'declarations',
      },
      include: ['consumer.ts', 'generated/*.ts'],
    }),
  );
  const typecheck = (config: string) =>
    promisify(execFile)(process.execPath, [
      fileURLToPath(
        new URL('../node_modules/typescript/bin/tsc', import.meta.url),
      ),
      '-p',
      join(root, config),
    ]);
  await typecheck('tsconfig.json');
  await rm(join(root, 'generated'), { recursive: true });
  await rm(join(root, 'consumer.ts'));
  await writeFile(
    join(root, 'published.ts'),
    compositionGraphConsumer
      .replaceAll('./generated/', './declarations/generated/')
      .replaceAll(".ts';", ".js';"),
  );
  await writeFile(
    join(root, 'published.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
      },
      include: ['published.ts'],
    }),
  );
  await typecheck('published.json');
});

void test('private type sharing does not expose an unrelated public component', async () => {
  const value = { type: 'object', properties: { value: { type: 'string' } } };
  const response = (name: string) => ({
    description: 'Synthetic',
    content: { 'application/json': { schema: ref(name) } },
  });
  const files = await compile(
    {
      openapi: '3.1.2',
      info: { title: 'Synthetic private type closure', version: '1' },
      components: {
        schemas: {
          OnlyFirst: value,
          Base: { type: 'object', properties: { nested: value } },
          OnlySecond: {
            type: 'object',
            properties: {
              left: { allOf: [ref('Base'), { type: 'object' }] },
              right: { allOf: [ref('Base'), { type: 'object' }] },
            },
          },
        },
      },
      paths: {
        '/first': {
          get: {
            operationId: 'first',
            responses: { 200: response('OnlyFirst') },
          },
        },
        '/second': {
          get: {
            operationId: 'second',
            responses: { 200: response('OnlySecond') },
          },
        },
      },
    },
    {
      clients: ['first', 'second'],
      surfaces: { first: ['first'], second: ['second'] },
    },
  );
  const pending = ['client.second.ts'];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (visited.has(name)) continue;
    visited.add(name);
    const source = entry(files, name);
    assert.ok(!source.includes('OnlyFirst'), name);
    for (const match of source.matchAll(/['"]\.\/([^'"]+\.ts)['"]/g))
      pending.push(match[1]!);
  }
});
