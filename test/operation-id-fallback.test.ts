import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { buildDescriptor } from '../dist/descriptor.js';
import { parseYaml } from '../dist/yaml.js';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient } from './runtime-types.ts';

const ids = [
  'GET /items',
  'POST /items',
  'GET /items/{itemId}',
  'GET /items-get',
  'GET /items_get',
  'GET /items/get',
  'GET /items~get',
  'café',
  'cafe\u0301',
];
const selection = {
  clients: ['consumer'],
  executionClients: ['consumer'],
  surfaces: { consumer: ids },
  queries: { consumer: ids.filter((id) => id !== 'POST /items') },
} as const;

function operation(id?: string): Record<string, unknown> {
  return {
    ...(id === undefined ? {} : { operationId: id }),
    'x-pom': { priority: 'foreground' },
    responses: {
      200: {
        description: 'Synthetic response',
        content: {
          'application/json': { schema: { type: 'string', enum: ['reply'] } },
        },
      },
    },
  };
}

function fixture() {
  const paths: Record<string, Record<string, Record<string, unknown>>> = {
    '/items': {
      get: operation(),
      post: {
        ...operation(),
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'integer' } } },
        },
      },
    },
    '/items/{itemId}': {
      get: {
        ...operation(),
        parameters: [
          {
            name: 'itemId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
      },
    },
    '/items-get': { get: operation() },
    '/items_get': { get: operation() },
    '/items/get': { get: operation() },
    '/items~get': { get: operation() },
    '/unicode': { get: operation('café') },
    '/decomposed': { get: operation('cafe\u0301') },
  };
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic missing operation identifiers', version: '1' },
    'x-pom-policy': {
      version: 3,
      fields: { priority: { type: 'string', enum: ['foreground'] } },
      required: ['priority'],
    },
    paths,
  };
}

void test('missing operation IDs use the exact method and path across JSON, YAML and operation ordering', async () => {
  const document = fixture();
  const before = structuredClone(document);
  const files = await compile(document, selection);
  assert.deepEqual(document, before);
  assert.deepEqual(
    await compile(JSON.parse(JSON.stringify(document)) as unknown, selection),
    files,
  );
  assert.deepEqual(
    await compile(parseYaml(stringify(document), 'fallback.yaml'), selection),
    files,
  );
  document.paths = Object.fromEntries(
    Object.entries(document.paths)
      .reverse()
      .map(([path, item]) => [
        path,
        Object.fromEntries(Object.entries(item).reverse()),
      ]),
  );
  assert.deepEqual(await compile(document, selection), files);
  const explicit = fixture();
  for (const [path, item] of Object.entries(explicit.paths))
    for (const [method, value] of Object.entries(item))
      if (!Object.hasOwn(value, 'operationId'))
        value.operationId = `${method.toUpperCase()} ${path}`;
  assert.deepEqual(await compile(explicit, selection), files);
});

void test('adding unrelated routes preserves existing generated operation identities', async () => {
  const document = fixture();
  const baseline = await compile(document, selection);
  document.paths['/unrelated'] = { get: operation() };
  const surfaces = { ...selection.surfaces, internal: ['GET /unrelated'] };
  const descriptor = buildDescriptor(document, { surfaces });
  assert.deepEqual(
    descriptor.operations
      .filter((value) => value.path !== '/unrelated')
      .map((value) => value.id),
    [...ids].sort(),
  );
  assert.deepEqual(
    await compile(document, { ...selection, surfaces }),
    baseline,
  );
});

void test('derived operation IDs select policies, generated types, request builders and query identities', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  assert.deepEqual(Object.keys(client.operations).sort(), [...ids].sort());
  for (const id of ids) {
    const input =
      id === 'POST /items'
        ? { body: 1 }
        : id === 'GET /items/{itemId}'
          ? { path: { itemId: 'a/b' } }
          : undefined;
    const request = present(client.operations[id]).build(input);
    assert.equal(request.operationId, id);
    assert.deepEqual(request.policy, { priority: 'foreground' });
    if (id === 'GET /items/{itemId}') assert.equal(request.url, '/items/a%2Fb');
    const result = request.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '"reply"',
    });
    assert.equal(result.kind, 'success');
    assert.equal(result.data, 'reply');
  }
  interface Queries {
    createQueries(config: {
      namespace: string;
      execute(): Promise<never>;
    }): Record<
      string,
      { key(args: { context: object; input?: unknown }): readonly unknown[] }
    >;
  }
  const module = await importGenerated<Queries>(
    root,
    'client.consumer.queries.ts',
  );
  const queries = module.createQueries({
    namespace: 'fallback',
    execute: () => Promise.reject(new Error('No transport expected')),
  });
  for (const id of selection.queries.consumer) {
    const key = present(queries[id]).key({
      context: {},
      ...(id === 'GET /items/{itemId}'
        ? { input: { path: { itemId: 'one' } } }
        : {}),
    });
    assert.equal(key[3], id);
  }
  await writeFile(
    join(root, 'consumer.ts'),
    `
    import { operations } from './client.consumer.ts';
    import { createQueries } from './client.consumer.queries.ts';
    import type { Executor } from './client.consumer.ts';
    operations['GET /items'].build();
    operations['POST /items'].build({body:1});
    operations['GET /items/{itemId}'].build({path:{itemId:'one'}});
    operations['café'].build();
    // @ts-expect-error Method-derived identities retain request body types.
    operations['POST /items'].build({body:'wrong'});
    // @ts-expect-error Generated path parameters remain required.
    operations['GET /items/{itemId}'].build();
    // @ts-expect-error Distinct punctuation does not produce a slug alias.
    operations.getItems.build();
    export function key(execute: Executor) {
      return createQueries({namespace:'fallback',execute})['GET /items'].key({context:{}});
    }
    const response = operations['GET /items'].parseResponse({status:200,headers:{},body:''});
    if (response.kind === 'success') { const reply:'reply'=response.data; void reply; }
  `,
  );
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ['./*.ts'],
    }),
  );
  await promisify(execFile)(process.execPath, [
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
});

void test('explicit malformed operation IDs and explicit-derived collisions fail without renaming', async () => {
  for (const invalid of [undefined, null, '', false, 0, []]) {
    const document = fixture();
    present(present(document.paths['/items']).get).operationId = invalid;
    await assert.rejects(compile(document, selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, 'paths./items.get.operationId');
      assert.match(error.message, /expected a nonempty string/);
      return true;
    });
  }
  const document = fixture();
  document.paths['/collision'] = { get: operation('GET /items') };
  const before = structuredClone(document);
  await assert.rejects(compile(document, selection), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, 'paths./items.get.operationId');
    assert.match(error.message, /duplicate operation identifier "GET \/items"/);
    return true;
  });
  assert.deepEqual(document, before);
  const unicode = fixture();
  unicode.paths['/café'] = { get: operation() };
  await assert.rejects(
    compile(unicode, selection),
    /non-ASCII path literals are unsupported/,
  );
});
