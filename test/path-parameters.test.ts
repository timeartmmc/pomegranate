import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import { buildDescriptor } from '../dist/descriptor.js';
import { parseYaml } from '../dist/yaml.js';
import { present } from './assertions.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import type { Parameter } from './helpers.ts';
import type { RuntimeClient } from './runtime-types.ts';

const exec = promisify(execFile);
const selection = {
  clients: ['consumer', 'staff'],
  surfaces: {
    consumer: ['readItem'],
    staff: ['writeItem'],
    internal: ['internalReport'],
  },
};
const pathLocation = 'paths./items/{itemId}';
function fixture() {
  const inherited: Parameter[] = [
    {
      name: 'itemId',
      in: 'path',
      required: true,
      schema: { $ref: '#/components/schemas/ItemId' },
    },
    { name: 'mode', in: 'query', schema: { type: 'string', enum: ['base'] } },
    {
      name: 'X-Scope',
      in: 'header',
      required: true,
      schema: { type: 'string', minLength: 1 },
    },
    {
      name: 'tags',
      in: 'query',
      schema: { type: 'array', items: { type: 'string' } },
    },
  ];
  const reads: Parameter[] = [
    {
      name: 'mode',
      in: 'query',
      required: true,
      schema: { type: 'string', enum: ['read'] },
    },
    { name: 'itemId', in: 'query', schema: { type: 'integer' } },
  ];
  const writes: Parameter[] = [
    {
      name: 'X-Scope',
      in: 'header',
      required: true,
      schema: { type: 'string', enum: ['staff'] },
    },
  ];
  const hidden: Parameter[] = [
    {
      name: 'key',
      in: 'path',
      required: true,
      schema: { $ref: '#/components/schemas/SecretKey' },
    },
  ];
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic inherited parameters', version: '1' },
    paths: {
      '/items/{itemId}': {
        parameters: inherited,
        get: {
          operationId: 'readItem',
          parameters: reads,
          responses: { 204: { description: 'Read' } },
        },
        post: {
          operationId: 'writeItem',
          parameters: writes,
          responses: { 204: { description: 'Written' } },
        },
      },
      '/internal/{key}': {
        parameters: hidden,
        get: {
          operationId: 'internalReport',
          responses: { 204: { description: 'Internal' } },
        },
      },
    },
    components: {
      schemas: {
        ItemId: { $ref: '#/components/schemas/Key' },
        Key: { type: 'string', minLength: 1 },
        SecretKey: { type: 'string' },
        Unreachable: { type: 'boolean' },
      },
    },
  };
}
function expandedFixture() {
  const document = fixture();
  const item = document.paths['/items/{itemId}'];
  const [id, mode, scope, tags] = item.parameters;
  item.get.parameters = [
    present(id),
    present(item.get.parameters[0]),
    present(scope),
    present(tags),
    present(item.get.parameters[1]),
  ];
  item.post.parameters = [
    present(id),
    present(mode),
    present(item.post.parameters[0]),
    present(tags),
  ];
  Reflect.deleteProperty(item, 'parameters');
  Object.assign(document.paths['/internal/{key}'].get, {
    parameters: document.paths['/internal/{key}'].parameters,
  });
  Reflect.deleteProperty(document.paths['/internal/{key}'], 'parameters');
  return document;
}
async function load(
  files: Readonly<Record<string, string>>,
  root: string,
  client = 'consumer',
) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries(files))
    await writeFile(join(root, name), source);
  return (await import(
    pathToFileURL(join(root, `client.${client}.ts`)).href
  )) as RuntimeClient;
}

void test('inherited parameters produce the same bytes as explicit expansion, preserving inputs and projection', async () => {
  const document = fixture();
  const before = structuredClone(document);
  const files = await compile(document, selection);
  assert.deepEqual(files, await compile(expandedFixture(), selection));
  assert.deepEqual(document, before);
  assert.match(files['client.consumer.schemas.ts'] ?? '', /ItemId/);
  assert.match(files['client.consumer.schemas.ts'] ?? '', /Key/);
  assert.doesNotMatch(
    Object.values(files).join('\n'),
    /SecretKey|Unreachable|internalReport/,
  );
  assert.deepEqual(
    await compile(parseYaml(stringify(document), 'inherited.yaml'), selection),
    files,
  );
});

void test('each method inherits path, query and header rules and applies whole-parameter overrides', async (t) => {
  const files = await compile(fixture(), selection);
  const root = await temporary(t);
  const consumer = await load(files, root);
  const staff = (await import(
    pathToFileURL(join(root, 'client.staff.ts')).href
  )) as RuntimeClient;
  const read = present(consumer.operations.readItem);
  const write = present(staff.operations.writeItem);
  const built = read.build({
    path: { itemId: 'a/b' },
    query: { mode: 'read', tags: ['one', 'two'], itemId: 3 },
    headers: { 'X-Scope': 'tenant' },
  });
  assert.equal(built.url, '/items/a%2Fb?mode=read&tags=one&tags=two&itemId=3');
  assert.equal(built.headers['X-Scope'], 'tenant');
  for (const input of [
    { query: { mode: 'read' }, headers: { 'X-Scope': 'tenant' } },
    {
      path: { itemId: '' },
      query: { mode: 'read' },
      headers: { 'X-Scope': 'tenant' },
    },
    { path: { itemId: 'id' }, headers: { 'X-Scope': 'tenant' } },
    {
      path: { itemId: 'id' },
      query: { mode: 'base' },
      headers: { 'X-Scope': 'tenant' },
    },
    { path: { itemId: 'id' }, query: { mode: 'read' } },
  ])
    assert.throws(() => read.build(input), consumer.RequestValidationError);
  assert.throws(
    () =>
      write.build({ path: { itemId: 'id' }, headers: { 'X-Scope': 'tenant' } }),
    staff.RequestValidationError,
  );
  assert.equal(
    write.build({
      path: { itemId: 'id' },
      query: { mode: 'base' },
      headers: { 'X-Scope': 'staff' },
    }).url,
    '/items/id?mode=base',
  );
});

void test('empty and absent operation parameter lists keep inherited requirements', async (t) => {
  const document = fixture();
  document.paths['/items/{itemId}'].get.parameters = [];
  Reflect.deleteProperty(document.paths['/items/{itemId}'].post, 'parameters');
  const root = await temporary(t);
  const consumer = await load(await compile(document, selection), root);
  assert.throws(
    () => present(consumer.operations.readItem).build(),
    consumer.RequestValidationError,
  );
  assert.equal(
    present(consumer.operations.readItem).build({
      path: { itemId: 'id' },
      headers: { 'X-Scope': 'tenant' },
    }).url,
    '/items/id',
  );
  const descriptor = buildDescriptor(document, {
    surfaces: selection.surfaces,
  });
  assert.deepEqual(
    present(
      descriptor.operations.find((operation) => operation.id === 'readItem'),
    ).parameters,
    present(
      descriptor.operations.find((operation) => operation.id === 'writeItem'),
    ).parameters,
  );
});

void test('inherited request headers can be delegated to the transport', async (t) => {
  const root = await temporary(t);
  const client = await load(
    await compile(fixture(), { ...selection, transportHeaders: ['X-Scope'] }),
    root,
  );
  const request = present(client.operations.readItem).build({
    path: { itemId: 'id' },
    query: { mode: 'read' },
  });
  assert.equal(
    request.validateHeaders({ 'X-Scope': 'tenant' })['x-scope'],
    'tenant',
  );
  assert.throws(
    () => request.validateHeaders({}),
    client.RequestValidationError,
  );
});

const invalid: [
  string,
  (document: ReturnType<typeof fixture>) => void,
  string,
  RegExp,
][] = [
  [
    'invalid overridden inherited serialization',
    (document) => {
      Object.assign(document.paths['/items/{itemId}'].parameters[1]!, {
        style: 'spaceDelimited',
      });
    },
    `${pathLocation}.parameters[1].style`,
    /serialization/,
  ],
  [
    'invalid operation override',
    (document) => {
      Object.assign(document.paths['/items/{itemId}'].get.parameters[0]!, {
        style: 'spaceDelimited',
      });
    },
    `${pathLocation}.get.parameters[0].style`,
    /serialization/,
  ],
  [
    'duplicate inherited parameter even when overridden',
    (document) => {
      document.paths['/items/{itemId}'].parameters.push(
        structuredClone(
          present(document.paths['/items/{itemId}'].parameters[1]),
        ),
      );
    },
    `${pathLocation}.parameters`,
    /duplicate parameter/,
  ],
  [
    'duplicate operation override',
    (document) => {
      document.paths['/items/{itemId}'].get.parameters.push(
        structuredClone(
          present(document.paths['/items/{itemId}'].get.parameters[0]),
        ),
      );
    },
    `${pathLocation}.get.parameters`,
    /duplicate parameter/,
  ],
  [
    'inherited case-insensitive header duplicate',
    (document) => {
      document.paths['/items/{itemId}'].parameters.push({
        name: 'x-scope',
        in: 'header',
        schema: { type: 'string' },
      });
    },
    `${pathLocation}.parameters`,
    /duplicate parameter/,
  ],
  [
    'differently cased cross-level header collision',
    (document) => {
      document.paths['/items/{itemId}'].get.parameters.push({
        name: 'x-scope',
        in: 'header',
        schema: { type: 'string' },
      });
    },
    `${pathLocation}.get.parameters`,
    /duplicate parameter/,
  ],
  [
    'unsupported unselected inherited schema',
    (document) => {
      Object.assign(present(document.paths['/internal/{key}'].parameters[0]), {
        schema: { type: 'object' },
      });
    },
    'paths./internal/{key}.parameters[0].schema',
    /primitive/,
  ],
  [
    'inherited reserved header',
    (document) => {
      document.paths['/items/{itemId}'].parameters.push({
        name: 'Host',
        in: 'header',
        schema: { type: 'string' },
      });
    },
    `${pathLocation}.parameters[4].name`,
    /reserved/,
  ],
  [
    'inherited optional path parameter',
    (document) => {
      Object.assign(present(document.paths['/items/{itemId}'].parameters[0]), {
        required: false,
      });
    },
    `${pathLocation}.parameters[0].required`,
    /must be required/,
  ],
  [
    'effective missing path placeholder',
    (document) => {
      document.paths['/items/{itemId}'].parameters.shift();
    },
    `${pathLocation}.get.parameters`,
    /match exactly/,
  ],
  [
    'effective extra path declaration',
    (document) => {
      document.paths['/items/{itemId}'].parameters.push({
        name: 'extra',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      });
    },
    `${pathLocation}.get.parameters`,
    /match exactly/,
  ],
];
for (const [name, change, location, message] of invalid)
  void test(`path parameter inheritance rejects ${name} at the owning source`, async () => {
    const document = fixture();
    change(document);
    const before = structuredClone(document);
    await assert.rejects(compile(document, selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, location);
      assert.match(error.message, message);
      return true;
    });
    assert.deepEqual(document, before);
  });

void test('inherited requiredness and overridden enums survive generated declaration publication', async (t) => {
  const root = await temporary(t);
  await load(await compile(fixture(), selection), root);
  await writeFile(
    join(root, 'consumer.ts'),
    `
    import {operations} from './client.consumer.ts';
    import {operations as staff} from './client.staff.ts';
    export const read: typeof operations.readItem.build = operations.readItem.build;
    export type ReadInput = Parameters<typeof read>[0];
    read({path:{itemId:'id'},query:{mode:'read',tags:['a'],itemId:1},headers:{'X-Scope':'tenant'}});
    // @ts-expect-error Inherited path remains required.
    read({query:{mode:'read'},headers:{'X-Scope':'tenant'}});
    // @ts-expect-error Inherited header remains required.
    read({path:{itemId:'id'},query:{mode:'read'}});
    // @ts-expect-error Operation enum replaces the inherited enum.
    read({path:{itemId:'id'},query:{mode:'base'},headers:{'X-Scope':'tenant'}});
    // @ts-expect-error A same-name query parameter retains its own numeric type.
    read({path:{itemId:'id'},query:{mode:'read',itemId:'text'},headers:{'X-Scope':'tenant'}});
    staff.writeItem.build({path:{itemId:'id'},headers:{'X-Scope':'staff'}});
    // @ts-expect-error Header override is a literal enum.
    staff.writeItem.build({path:{itemId:'id'},headers:{'X-Scope':'tenant'}});
  `,
  );
  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      allowImportingTsExtensions: true,
      types: [],
      declaration: true,
      emitDeclarationOnly: true,
      isolatedDeclarations: true,
      outDir: './declarations',
    },
    include: ['./*.ts'],
  };
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify(config));
  const tsc = fileURLToPath(
    new URL('../node_modules/typescript/bin/tsc', import.meta.url),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')]);
  await writeFile(
    join(root, 'published.ts'),
    `
    import {read} from './declarations/consumer.js';
    read({path:{itemId:'id'},query:{mode:'read'},headers:{'X-Scope':'tenant'}});
    // @ts-expect-error Published inherited input still needs its header.
    read({path:{itemId:'id'},query:{mode:'read'}});
  `,
  );
  await writeFile(
    join(root, 'published.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        types: [],
        noEmit: true,
      },
      include: ['./published.ts', './declarations/*.d.ts'],
    }),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'published.json')]);
});

void test('invalid inherited declarations preserve generated output and read-only checks', async (t) => {
  const root = await temporary(t);
  const input = join(root, 'openapi.json');
  const config = join(root, 'pom.json');
  const output = join(root, 'generated');
  const document = fixture();
  await writeFile(input, JSON.stringify(document));
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      ...selection,
    }),
  );
  await runProject(config);
  const snapshot = await fileSnapshot(output);
  assert.equal((await runProject(config, { check: true })).clean, true);
  assert.deepEqual(await fileSnapshot(output), snapshot);
  Object.assign(present(document.paths['/items/{itemId}'].parameters[1]), {
    style: 'spaceDelimited',
  });
  const invalidSource = JSON.stringify(document);
  await writeFile(input, invalidSource);
  await assert.rejects(runProject(config), /parameters\[1\].style/);
  await assert.rejects(
    runProject(config, { check: true }),
    /parameters\[1\].style/,
  );
  assert.deepEqual(await fileSnapshot(output), snapshot);
  assert.equal(await readFile(input, 'utf8'), invalidSource);
});
