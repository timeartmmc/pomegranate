import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import type { OperationCall } from '../src/call-runtime.ts';
import type { Executor } from '../src/execution-runtime.ts';
import type { PreparedRequest, Responses, Server } from '../src/runtime.ts';
import { json, present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';

function fixture(modern = true) {
  const done = { 204: { description: 'Done' } };
  const id = {
    name: 'id',
    in: 'path',
    required: true,
    schema: { type: 'string' },
  };
  return {
    openapi: modern ? '3.1.2' : '3.0.4',
    info: { title: 'Synthetic server overrides', version: '1' },
    // Document servers stay application configuration.
    servers: [{ url: 'https://document.invalid/{stage}' }],
    paths: {
      '/plain': { get: { operationId: 'plain', responses: done } },
      '/files/{id}': {
        parameters: [id],
        servers: [
          {
            url: 'https://{region}.files.invalid/{version}',
            description: 'Regional file hosts',
            variables: {
              region: { default: 'eu', description: 'Deployment region' },
              version: { default: 'v1', enum: ['v1', 'v2'] },
              // A variable name is data, including this one.
              ['__proto__']: { default: 'kept' },
            },
          },
          { url: '/relative' },
        ],
        get: { operationId: 'inherit', responses: done },
        put: { operationId: 'emptyOwn', servers: [], responses: done },
        post: {
          operationId: 'own',
          servers: [{ url: 'https://upload.invalid' }],
          responses: done,
        },
      },
      '/cleared/{id}': {
        parameters: [id],
        servers: [],
        get: { operationId: 'clearedInherit', responses: done },
        post: {
          operationId: 'clearedOwn',
          servers: [{ url: 'https://own.invalid' }],
          responses: done,
        },
      },
    },
  };
}

const selection = {
  clients: ['client'],
  executionClients: ['client'],
  surfaces: {
    client: [
      'plain',
      'inherit',
      'emptyOwn',
      'own',
      'clearedInherit',
      'clearedOwn',
    ],
  },
};
const pathServers = json(
  '[{"url":"https://{region}.files.invalid/{version}","variables":{"region":{"default":"eu"},"version":{"default":"v1","enum":["v1","v2"]},"__proto__":{"default":"kept"}}},{"url":"/relative","variables":{}}]',
);

interface Client {
  operations: Record<string, { build(input?: unknown): PreparedRequest }>;
  createClient(config: {
    namespace: string;
    execute: Executor;
  }): Record<string, OperationCall<unknown, Responses>>;
}

void test('server overrides produce the same output across dialects and YAML, and none without an override', async () => {
  const files = await compile(fixture(), selection);
  assert.deepEqual(await compile(fixture(false), selection), files);
  assert.deepEqual(
    await compile(parseYaml(stringify(fixture()), 'servers.yaml'), selection),
    files,
  );
  // Variables are a map, so their order is not part of the contract.
  const reordered = fixture();
  const [regional] = reordered.paths['/files/{id}'].servers;
  Object.assign(present(regional), {
    variables: Object.fromEntries(
      Object.entries(present(regional?.variables)).reverse(),
    ),
  });
  assert.deepEqual(await compile(reordered, selection), files);
  // Without Path Item or Operation servers, the document's own never reach
  // generated output.
  const plain = fixture();
  for (const item of Object.values(plain.paths)) {
    Reflect.deleteProperty(item, 'servers');
    for (const operation of Object.values(item))
      if (operation !== null && typeof operation === 'object')
        Reflect.deleteProperty(operation, 'servers');
  }
  const other = structuredClone(plain);
  Object.assign(other, { servers: [{ url: 'https://elsewhere.invalid' }] });
  const output = await compile(plain, selection);
  assert.deepEqual(await compile(other, selection), output);
  assert.equal(JSON.stringify(output).includes('document.invalid'), false);
});

void test('requests carry the nearest declared server list, empty or not, as detached frozen metadata', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  const client = await importGenerated<Client>(root, 'client.client.ts');
  const build = (name: string) =>
    present(client.operations[name]).build(
      name === 'plain' ? undefined : { path: { id: 'a b' } },
    );
  const plain = build('plain');
  // An own undefined field: nothing inherited can stand in for an override.
  assert.equal(plain.servers, undefined);
  assert.ok(Object.hasOwn(plain, 'servers'));
  const inherited = present(build('inherit').servers);
  assert.deepEqual(json(JSON.stringify(inherited)), pathServers);
  assert.deepEqual(json(JSON.stringify(build('own').servers)), [
    { url: 'https://upload.invalid', variables: {} },
  ]);
  // An explicit empty list is still the nearest declaration. It replaces its
  // parents' servers with none, and never falls back to the host it overrides.
  for (const name of ['emptyOwn', 'clearedInherit']) {
    const emptied = build(name).servers;
    assert.deepEqual(emptied, [], name);
    assert.ok(Object.isFrozen(emptied), name);
  }
  assert.deepEqual(json(JSON.stringify(build('clearedOwn').servers)), [
    { url: 'https://own.invalid', variables: {} },
  ]);
  // POM passes the declaration through: no expansion, and a relative URL.
  assert.equal(build('inherit').url, '/files/a%20b');
  assert.equal(build('own').url, '/files/a%20b');
  const [regional] = inherited;
  const variables = present(regional).variables;
  assert.equal(Object.getPrototypeOf(variables), null);
  assert.deepEqual(Object.keys(variables), ['__proto__', 'region', 'version']);
  assert.equal(Object.getPrototypeOf(variables.region), null);
  // Both variable slots are own fields; an absent enum is an own undefined.
  assert.ok(Object.hasOwn(present(variables.region), 'enum'));
  assert.equal(present(variables.region).enum, undefined);
  for (const value of [
    inherited,
    regional,
    variables,
    variables.version,
    variables.version?.enum,
  ])
    assert.ok(Object.isFrozen(value));
  assert.equal(build('inherit').servers, inherited);
  const prototype = Object.prototype as { servers?: readonly Server[] };
  prototype.servers = [{ url: 'https://polluted.invalid', variables: {} }];
  try {
    assert.equal(build('plain').servers, undefined);
  } finally {
    Reflect.deleteProperty(prototype, 'servers');
  }
  const seen: unknown[] = [];
  const execute: Executor = async (request) => {
    seen.push(request.servers);
    return { status: 204, headers: {}, body: '' };
  };
  const calls = client.createClient({ namespace: 'servers', execute });
  await present(calls.plain).call({ context: {} });
  await present(calls.own).call({
    context: {},
    input: { path: { id: 'a' } },
  });
  assert.equal(seen[0], undefined);
  assert.deepEqual(json(JSON.stringify(seen[1])), [
    { url: 'https://upload.invalid', variables: {} },
  ]);
  await writeFile(
    join(root, 'consumer.ts'),
    `
    import { operations } from './client.client.ts';
    import type { Executor, Server } from './client.client.ts';
    const request = operations.own.build({ path: { id: 'a' } });
    const servers: readonly Server[] | undefined = request.servers;
    const url: string | undefined = request.servers?.[0]?.url;
    const versions: readonly string[] | undefined =
      request.servers?.[0]?.variables['version']?.enum;
    // @ts-expect-error Overrides are read-only metadata.
    request.servers = [];
    // @ts-expect-error A server is its URL template and variables.
    void request.servers?.[0]?.description;
    export const execute: Executor = async (prepared) => {
      // An override replaces the document's servers even when it is empty, so
      // only its absence selects them.
      if (prepared.servers !== undefined)
        throw new Error('This executor implements no server overrides');
      return { status: 204, headers: {}, body: '' };
    };
    void [servers, url, versions];
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
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
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

void test('extensions inside override servers need the explicit ignore list', async () => {
  const expected = await compile(fixture(), selection);
  for (const target of [
    (document: ReturnType<typeof fixture>) =>
      document.paths['/files/{id}'].servers[1],
    (document: ReturnType<typeof fixture>) =>
      document.paths['/files/{id}'].post.servers[0],
  ]) {
    const document = fixture();
    Object.assign(present(target(document)), { 'x-internal': true });
    await assert.rejects(
      compile(document, selection),
      /servers\[\d\]\.x-internal: unsupported keyword; list documentation-only extensions in ignoreExtensions/,
    );
    assert.deepEqual(
      await compile(document, {
        ...selection,
        ignoreExtensions: ['x-internal'],
      }),
      expected,
    );
  }
});
