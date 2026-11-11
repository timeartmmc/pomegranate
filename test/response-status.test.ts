import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { QueryClient } from '@tanstack/query-core';
import type {
  FetchInfiniteQueryOptions,
  FetchQueryOptions,
} from '@tanstack/query-core';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import type { OperationCall } from '../src/call-runtime.ts';
import type { Executor } from '../src/execution-runtime.ts';
import { defineOperation, stringValue } from '../src/runtime.ts';
import type { ObservedResponse, Responses } from '../src/runtime.ts';
import { present, record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import {
  responseStatusConsumer,
  responseStatusFixture as fixture,
  responseStatusSelection as selection,
  verifyResponseStatuses,
} from './response-status-fixture.ts';
import type { ResponseStatusClient } from './response-status-fixture.ts';

type Fixture = ReturnType<typeof fixture>;

async function rejectsAt(
  document: Fixture,
  location: string,
  message: RegExp,
  options: Parameters<typeof compile>[1] = selection,
) {
  const before = structuredClone(document);
  await assert.rejects(compile(document, options), (error) => {
    assert.ok(error instanceof ContractError, location);
    assert.equal(error.location, location);
    assert.match(error.message, message, location);
    return true;
  });
  assert.deepEqual(document, before, location);
}

void test('status ranges and default produce the same output across dialects, YAML and declaration order', async () => {
  const files = await compile(fixture(), selection);
  for (const modern of [true, false]) {
    const document = fixture(modern);
    const before = structuredClone(document);
    assert.deepEqual(await compile(document, selection), files);
    assert.deepEqual(document, before);
    assert.deepEqual(
      await compile(parseYaml(stringify(document), 'statuses.yaml'), selection),
      files,
    );
    for (const item of Object.values(document.paths))
      for (const value of Object.values(record(item))) {
        const operation = record(value);
        operation.responses = Object.fromEntries(
          Object.entries(record(operation.responses)).reverse(),
        );
      }
    assert.deepEqual(await compile(document, selection), files);
  }
});

void test('generated range and default responses validate, classify and narrow by status', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  verifyResponseStatuses(
    await importGenerated<ResponseStatusClient>(root, 'client.consumer.ts'),
  );
  await writeFile(join(root, 'consumer.ts'), responseStatusConsumer);
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
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

void test('a status without content rejects a matching declaration with content before reading the body', () => {
  // Any text satisfies this schema, including the empty body these statuses
  // have. Only the status rule can reject them.
  const text = {
    bodyKind: 'content',
    headers: {},
    content: { 'text/plain': { bodyKind: 'text', schema: stringValue } },
  } as const;
  const operation = defineOperation({
    operationId: 'fallbacks',
    method: 'GET',
    path: '/fallbacks',
    bodyKind: 'none',
    security: { transport: 'none' },
    policy: {},
    parameters: [],
    options: () => undefined,
    headers: {},
    responses: {
      202: { bodyKind: 'none', headers: {} },
      '2XX': text,
      '3XX': { bodyKind: 'none', headers: {} },
      default: text,
    },
  });
  const parse = (status: number, body = '') =>
    operation.parseResponse({
      status,
      headers: { 'Content-Type': 'text/plain' },
      body,
    });
  for (const status of [200, 206, 400, 500]) {
    const result = parse(status);
    assert.equal(result.kind, status < 300 ? 'success' : 'error');
    assert.equal(result.data, '');
  }
  for (const status of [204, 205])
    assert.deepEqual(record(parse(status)).issues, [
      {
        part: 'status',
        message: `a ${status} response cannot carry the declared content`,
      },
    ]);
  // Declarations without content keep accepting them.
  assert.equal(parse(202).kind, 'success');
  assert.equal(parse(304).kind, 'error');
  assert.equal(parse(304, 'cached').kind, 'protocol');
});

interface Calls {
  createClient(config: {
    namespace: string;
    execute: Executor;
  }): Record<string, OperationCall<undefined, Responses>>;
}
interface Factory<Options> {
  options(args: { context: Record<string, never> }): Options;
  body(): Factory<Options>;
}
interface Queries {
  createQueries(config: {
    namespace: string;
    execute: Executor;
  }): Record<string, Factory<FetchQueryOptions>>;
  createInfiniteQueries(config: {
    namespace: string;
    execute: Executor;
  }): Record<string, Factory<FetchInfiniteQueryOptions<unknown, Error>>>;
}

void test('calls and queries resolve range and default successes and reject their errors with validated data', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  const calls = await importGenerated<Calls>(root, 'client.consumer.ts');
  const queryModule = await importGenerated<Queries>(
    root,
    'client.consumer.queries.ts',
  );
  const json = (status: number, source: string): ObservedResponse => ({
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  for (const scoped of [false, true]) {
    let observed: ObservedResponse = json(200, 'exact');
    const execute: Executor = async (_request, execution) =>
      scoped ? execution.validateResponse(observed) : observed;
    const config = { namespace: `statuses-${scoped}`, execute };
    const client = calls.createClient(config);
    const queries = queryModule.createQueries(config);
    const fallback = present(client.fallback);
    const cache = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });
    try {
      for (const [response, data] of [
        [json(200, 'exact'), { source: 'exact' }],
        // Default is the declared response for every other 2xx status here.
        [json(201, 'default'), { source: 'default' }],
      ] as const) {
        observed = response;
        const called = await fallback.call({ context: {} });
        assert.equal(called.kind, 'success');
        assert.equal(called.status, response.status);
        assert.deepEqual(called.data, data);
        const envelope = record(
          await cache.fetchQuery(
            present(queries.fallback).options({ context: {} }),
          ),
        );
        assert.equal(envelope.status, response.status);
        assert.deepEqual(envelope.data, data);
        assert.deepEqual(
          await cache.fetchQuery(
            present(queries.fallback).body().options({ context: {} }),
          ),
          data,
        );
      }
      for (const status of [302, 404, 503]) {
        observed = json(status, 'default');
        for (const invoke of [
          () => fallback.call({ context: {} }),
          () =>
            cache.fetchQuery(
              present(queries.fallback).options({ context: {} }),
            ),
        ])
          await assert.rejects(invoke(), (error) => {
            assert.ok(fallback.isError(error));
            assert.equal(error.result.kind, 'error');
            assert.equal(error.result.status, status);
            if (error.result.kind === 'error')
              assert.deepEqual(error.result.data, { source: 'default' });
            return true;
          });
      }
      // A matched declaration still has to validate: an exact status does not
      // fall through to default when its own body is wrong.
      observed = json(200, 'default');
      await assert.rejects(fallback.call({ context: {} }), (error) => {
        assert.ok(fallback.isError(error));
        assert.equal(error.result.kind, 'protocol');
        return true;
      });
      observed = { status: 204, headers: {}, body: '' };
      const empty = await present(client.only).call({ context: {} });
      assert.equal(empty.status, 204);
      assert.equal(empty.data, undefined);
      // A bodyless default or range can be the success, so there is no body
      // to cache for these operations.
      for (const name of ['only', 'probe'])
        assert.throws(
          () => present(queries[name]).body(),
          /bodyless success; use an envelope query/,
        );
      present(queries.mixed).body();
      observed = {
        status: 206,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: ['a', 'b'], next: null }),
      };
      const pages = present(
        queryModule.createInfiniteQueries(config).pages,
      ).body();
      const data = await cache.fetchInfiniteQuery(
        pages.options({ context: {} }),
      );
      assert.deepEqual(data.pages, [{ items: ['a', 'b'], next: null }]);
    } finally {
      cache.clear();
    }
  }
});

void test('pagination requires the page shape from every declaration that can produce a success', async () => {
  const path = 'infiniteQueries.consumer.pages.responses';
  const hint =
    /default also matches every 2xx status without its own declaration, so declare a 2XX response to keep default for errors$/;
  const fallbackSuccess = fixture();
  Reflect.deleteProperty(fallbackSuccess.paths['/pages'].get.responses, '2XX');
  await rejectsAt(
    fallbackSuccess,
    `${path}.default.content.application/json`,
    hint,
  );
  const bodylessDefault = fixture();
  Object.assign(bodylessDefault.paths['/pages'].get, {
    responses: {
      200: bodylessDefault.paths['/pages'].get.responses[200],
      default: { description: 'No content' },
    },
  });
  await rejectsAt(bodylessDefault, `${path}.default`, hint);
  const bodylessRange = fixture();
  Object.assign(bodylessRange.paths['/pages'].get.responses, {
    '2XX': { description: 'No content' },
  });
  await assert.rejects(compile(bodylessRange, selection), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, `${path}.2XX`);
    assert.match(error.message, /must have a JSON object body$/);
    return true;
  });
  // A default that is the only success is the page itself: no other
  // declaration to keep it away from.
  const onlyDefault = fixture();
  Object.assign(onlyDefault.paths['/pages'].get, {
    responses: { default: { $ref: '#/components/responses/Fallback' } },
  });
  await assert.rejects(compile(onlyDefault, selection), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, `${path}.default.content.application/json`);
    assert.match(
      error.message,
      /must name an existing top-level response property$/,
    );
    return true;
  });
  // The same documents remain valid ordinary queries.
  const { infiniteQueries: _, ...ordinary } = selection;
  for (const document of [
    fallbackSuccess,
    bodylessDefault,
    bodylessRange,
    onlyDefault,
  ])
    await compile(document, ordinary);
});

void test('response keys reject malformed ranges, interim statuses and operations that cannot succeed', async () => {
  for (const key of [
    '1XX',
    '6XX',
    '2xx',
    '2Xx',
    '20X',
    '2X',
    'XXX',
    '2XXX',
    'Default',
    'DEFAULT',
    '101',
    '199',
    '600',
    '0200',
    '200.0',
  ]) {
    const document = fixture();
    Object.assign(document.paths['/only'].get.responses, {
      [key]: { description: 'Not a response key' },
    });
    await rejectsAt(
      document,
      `paths./only.get.responses.${key}`,
      /^[^:]+: expected a final HTTP status 200–599, a range 2XX–5XX or default$/,
    );
  }
  for (const responses of [
    { 404: { description: 'Missing' } },
    { '3XX': { description: 'Elsewhere' } },
    {
      '4XX': { description: 'Client' },
      '5XX': { description: 'Server' },
      301: { description: 'Moved' },
    },
  ]) {
    const document = fixture();
    Object.assign(document.paths['/only'].get, { responses });
    await rejectsAt(
      document,
      'paths./only.get.responses',
      /at least one 2xx, 2XX or default response is required$/,
    );
  }
});

void test('HEAD keeps rejecting content declared through a range or default', async () => {
  const content = {
    'application/json': { schema: { $ref: '#/components/schemas/Problem' } },
  };
  for (const key of ['2XX', 'default'] as const) {
    const inline = fixture();
    Object.assign(inline.paths['/mixed'].head.responses[key], { content });
    await rejectsAt(
      inline,
      `paths./mixed.head.responses.${key}.content`,
      /this HTTP method\/status cannot carry a body$/,
    );
    const referenced = fixture();
    Object.assign(referenced.paths['/mixed'].head.responses, {
      [key]: { $ref: '#/components/responses/Fallback' },
    });
    await rejectsAt(
      referenced,
      `paths./mixed.head.responses.${key}.$ref`,
      /cannot carry a body \(response reference "#\/components\/responses\/Fallback"\)$/,
    );
  }
});
