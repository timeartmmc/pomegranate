import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { QueryClient } from '@tanstack/query-core';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import {
  mediaFixture,
  mediaSelection,
  mediaConsumer,
  verifyMedia,
} from './media-fixture.ts';
import type { MediaClient } from './media-fixture.ts';
import { record } from './assertions.ts';
import { defineOperation, report } from '../src/runtime.ts';
import type { JsonValue, ObservedResponse, Parse } from '../src/runtime.ts';
import type { Executor, Success } from '../src/execution-runtime.ts';
import type { QueryFactory } from '../src/query-runtime.ts';
import type { OperationCall } from '../src/call-runtime.ts';

void test('request selection and complete response media maps are deterministic across dialects and ordering', async () => {
  const files = await compile(mediaFixture(), mediaSelection);
  for (const modern of [true, false]) {
    const document = mediaFixture(modern);
    const before = structuredClone(document);
    assert.deepEqual(await compile(document, mediaSelection), files);
    assert.deepEqual(document, before);
    assert.deepEqual(
      await compile(
        parseYaml(stringify(document), 'media.yaml'),
        mediaSelection,
      ),
      files,
    );
    for (const item of Object.values(document.paths))
      for (const operation of Object.values(item)) {
        if ('requestBody' in operation) {
          const body = record(operation.requestBody);
          body.content = Object.fromEntries(
            Object.entries(record(body.content)).reverse(),
          );
        }
        for (const response of Object.values(operation.responses)) {
          const value = record(response);
          if (Object.hasOwn(value, 'content'))
            value.content = Object.fromEntries(
              Object.entries(record(value.content)).reverse(),
            );
        }
      }
    assert.deepEqual(await compile(document, mediaSelection), files);
    const requestBodies: Record<string, unknown> = {};
    for (const [path, name] of [
      ['/optional', 'Text'],
      ['/preferred', 'Json'],
    ] as const) {
      const operation = document.paths[path].post;
      const body = record(operation.requestBody);
      delete body.required;
      requestBodies[name] = body;
      requestBodies[`${name}Alias`] = {
        $ref: `#/components/requestBodies/${name}`,
      };
      Object.assign(operation, {
        requestBody: { $ref: `#/components/requestBodies/${name}Alias` },
      });
    }
    Object.assign(document.components, { requestBodies });
    assert.deepEqual(await compile(document, mediaSelection), files);
    assert.deepEqual(
      await compile(
        parseYaml(stringify(document), 'body-aliases.yaml'),
        mediaSelection,
      ),
      files,
    );
  }
});

void test('response media dispatch calls only the declared parser and fails before decoding unknown or malformed MIME', () => {
  const calls = { json: 0, vendor: 0, text: 0 };
  const counted =
    (name: keyof typeof calls, expected: string): Parse<string> =>
    (input, issues) => {
      calls[name]++;
      return input === expected
        ? input
        : report(issues, `expected ${expected}`, true);
    };
  const operation = defineOperation({
    operationId: 'dispatch',
    method: 'GET',
    path: '/dispatch',
    bodyKind: 'none',
    security: { transport: 'none' },
    policy: {},
    parameters: [],
    options: () => undefined,
    headers: {},
    responses: {
      200: {
        bodyKind: 'content',
        headers: {},
        content: {
          'application/json': {
            bodyKind: 'json',
            schema: counted('json', 'json'),
          },
          'application/vendor+json': {
            bodyKind: 'json',
            schema: counted('vendor', 'vendor'),
          },
          'text/plain': {
            bodyKind: 'text',
            schema: counted('text', '{"json":true}'),
          },
        },
      },
    },
  });
  for (const [contentType, body, expected] of [
    ['application/json', '"json"', 'json'],
    ['application/vendor+json', '"vendor"', 'vendor'],
    ['text/plain', '{"json":true}', '{"json":true}'],
  ] as const) {
    const result = operation.parseResponse({
      status: 200,
      headers: { 'Content-Type': contentType },
      body,
    });
    assert.equal(result.kind, 'success');
    if (result.kind === 'success') {
      assert.equal(result.contentType, contentType);
      assert.equal(result.data, expected);
    }
  }
  assert.deepEqual(calls, { json: 1, vendor: 1, text: 1 });
  for (const headers of [
    {},
    { 'Content-Type': 'application/unknown+json' },
    { 'Content-Type': 'application/json; charset' },
    { 'Content-Type': 'application/json, text/plain' },
    { 'Content-Type': 'application/json', 'content-type': 'application/json' },
    {
      'Content-Type': 'application/json; note="first',
      'content-type': 'last"',
    },
    { 'Content-Type': 'application/json\r' },
  ]) {
    for (const body of ['{', '"json"']) {
      const result = operation.parseResponse({ status: 200, headers, body });
      assert.equal(result.kind, 'protocol');
      if (result.kind === 'protocol')
        assert.equal(
          result.issues.some((issue) => issue.part === 'body'),
          false,
        );
      assert.equal(Object.hasOwn(result, 'data'), false);
      assert.equal(Object.hasOwn(result, 'contentType'), false);
    }
  }
  assert.deepEqual(calls, { json: 1, vendor: 1, text: 1 });
  assert.equal(
    operation.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/vendor+json' },
      body: '"json"',
    }).kind,
    'protocol',
  );
  assert.deepEqual(calls, { json: 1, vendor: 2, text: 1 });
});

void test('mixed-case request and response media declarations produce the same generated behavior', async (t) => {
  const document = mediaFixture();
  for (const item of Object.values(document.paths))
    for (const operation of Object.values(item)) {
      if ('requestBody' in operation) {
        const body = record(operation.requestBody);
        body.content = Object.fromEntries(
          Object.entries(record(body.content)).map(([name, value]) => [
            name.toUpperCase(),
            value,
          ]),
        );
      }
      for (const response of Object.values(operation.responses)) {
        const value = record(response);
        if (Object.hasOwn(value, 'content'))
          value.content = Object.fromEntries(
            Object.entries(record(value.content)).map(([name, media]) => [
              name.toUpperCase(),
              media,
            ]),
          );
      }
    }
  const files = await compile(document, mediaSelection);
  assert.deepEqual(files, await compile(mediaFixture(), mediaSelection));
  const root = await generatedTestWorkspace(t, files);
  verifyMedia(await importGenerated<MediaClient>(root, 'client.consumer.ts'));
});

void test('generated media validators preserve exact representations, text data and consumer types', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(mediaFixture(), mediaSelection),
  );
  verifyMedia(await importGenerated<MediaClient>(root, 'client.consumer.ts'));
  await writeFile(join(root, 'consumer.ts'), mediaConsumer);
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
  await writeFile(
    join(root, 'declarations.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        declaration: true,
        emitDeclarationOnly: true,
        rewriteRelativeImportExtensions: true,
        outDir: './declarations',
      },
      include: ['./*.ts'],
    }),
  );
  const compiler = fileURLToPath(
    new URL('../node_modules/typescript/bin/tsc', import.meta.url),
  );
  await promisify(execFile)(process.execPath, [
    compiler,
    '-p',
    join(root, 'declarations.json'),
  ]);
  await writeFile(
    join(root, 'published.ts'),
    `
    import { parsePreferred } from './declarations/consumer.js';
    const result=parsePreferred({status:200,headers:{},body:''});
    if(result.kind!=='protocol' && result.status===200) {
      if(result.contentType==='application/a+json') {
        const flag:true=result.data;
        // @ts-expect-error Published MIME narrowing excludes other JSON representations.
        void result.data.code;
        void flag;
      } else if(result.contentType==='application/json') {
        const code:'ok'=result.data.code; void code;
      }
    }
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
        noEmit: true,
      },
      include: ['./published.ts', './declarations/*.d.ts'],
    }),
  );
  await promisify(execFile)(process.execPath, [
    compiler,
    '-p',
    join(root, 'published.json'),
  ]);
});

void test('raw and scoped execution preserve response representations in envelope and body query caches', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(mediaFixture(), mediaSelection),
  );
  type ContentResponses = Readonly<
    Record<
      number,
      {
        bodyKind: 'content';
        headers: {};
        content: Readonly<
          Record<
            string,
            { bodyKind: 'json' | 'text'; schema: Parse<JsonValue> }
          >
        >;
      }
    >
  >;
  interface Calls {
    createClient(config: {
      namespace: string;
      execute: Executor;
    }): Record<string, OperationCall<undefined, ContentResponses>>;
  }
  interface Queries {
    createQueries(config: {
      namespace: string;
      execute: Executor;
    }): Record<string, QueryFactory<undefined, ContentResponses>>;
  }
  const callsModule = await importGenerated<Calls>(root, 'client.consumer.ts');
  const queryModule = await importGenerated<Queries>(
    root,
    'client.consumer.queries.ts',
  );
  const cases = [
    ['application/json', '{"code":"ok"}', { code: 'ok' }],
    ['application/a+json', 'true', true],
    ['application/vnd.zeta+json', '2', 2],
    ['text/plain', '{"ok":true}', '{"ok":true}'],
    ['text/plain', '', ''],
  ] as const;
  for (const scoped of [false, true]) {
    let observed: ObservedResponse = { status: 200, headers: {}, body: '' };
    const execute: Executor = async (_request, execution) => {
      if (!scoped) return observed;
      const inspected = execution.validateResponse(observed);
      if (inspected.kind === 'success')
        assert.equal(Object.isFrozen(inspected), true);
      return inspected;
    };
    const config = { namespace: `media-${scoped}`, execute };
    const operation = callsModule.createClient(config)['readRepresentations'];
    const query = queryModule.createQueries(config)['readRepresentations'];
    assert.ok(operation && query);
    const cache = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });
    try {
      for (const [contentType, wire, data] of cases) {
        observed = {
          status: 200,
          headers: { 'Content-Type': `${contentType}; charset=utf-8` },
          body: wire,
        };
        const called = await operation.call({ context: {} });
        assert.equal(called.contentType, contentType);
        assert.deepEqual(called.data, data);
        const envelope: Success<ContentResponses> = await cache.fetchQuery(
          query.options({ context: {} }),
        );
        assert.equal(envelope.contentType, contentType);
        assert.deepEqual(envelope.data, data);
        const body: JsonValue = await cache.fetchQuery(
          query.body().options({ context: {} }),
        );
        assert.deepEqual(body, data);
        assert.deepEqual(
          cache.getQueryData(query.body().key({ context: {} })),
          data,
        );
      }
      for (const [contentType, wire, data] of [
        [
          'application/problem+json',
          '{"detail":"failure"}',
          { detail: 'failure' },
        ],
        ['text/plain', 'hello', 'hello'],
      ] as const) {
        observed = {
          status: 400,
          headers: { 'Content-Type': contentType },
          body: wire,
        };
        for (const invoke of [
          () => operation.call({ context: {} }),
          () => cache.fetchQuery(query.options({ context: {} })),
          () => cache.fetchQuery(query.body().options({ context: {} })),
        ])
          await assert.rejects(invoke(), (error) => {
            assert.ok(operation.isError(error) || query.isError(error));
            assert.equal(error.result.kind, 'error');
            if (error.result.kind === 'error') {
              assert.equal(error.result.contentType, contentType);
              assert.deepEqual(error.result.data, data);
            }
            return true;
          });
      }
      assert.equal(cache.getQueryData(query.body().key({ context: {} })), '');
      assert.equal(
        cache.getQueryData(query.key({ context: {} }))?.contentType,
        'text/plain',
      );
      observed = {
        status: 200,
        headers: { 'Content-Type': 'application/unknown+json' },
        body: '{"code":"ok"}',
      };
      await assert.rejects(operation.call({ context: {} }), (error) => {
        assert.ok(operation.isError(error));
        assert.equal(error.result.kind, 'protocol');
        assert.equal(Object.hasOwn(error.result, 'contentType'), false);
        return true;
      });
    } finally {
      cache.clear();
    }
  }
});

void test('nonpreferred representations and unsupported media still validate before generation', async () => {
  for (const [media, schema] of [
    ['text/plain', { type: 'integer' }],
    ['application/vnd.zeta+json', { type: 'string', minLength: -1 }],
    [
      'multipart/form-data',
      { type: 'object', properties: { file: { type: 'integer' } } },
    ],
    ['multipart/form-data', { $ref: '#/components/schemas/Missing' }],
    ['application/xml', { type: 'string' }],
    ['x-example/other', { type: 'string' }],
    ['application/K+json', { type: 'string' }],
    ['application/*+json', { type: 'string' }],
    ['application/+json', { type: 'string' }],
    ['text/+json', { type: 'string' }],
    ['application/json; charset=utf-8', { type: 'string' }],
  ] as const) {
    const input = mediaFixture();
    Object.assign(input.paths['/preferred'].post.requestBody.content, {
      [media]: { schema },
    });
    const before = structuredClone(input);
    await assert.rejects(compile(input, mediaSelection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.match(
        error.location,
        /paths\.\/preferred\.post\.requestBody\.content/,
      );
      return true;
    });
    assert.deepEqual(input, before);
  }
  const response = mediaFixture();
  Object.assign(response.paths['/preferred'].post.responses[200].content, {
    'text/plain': { schema: { type: 'integer' } },
  });
  await assert.rejects(compile(response, mediaSelection), ContractError);
  const duplicate = mediaFixture();
  Object.assign(duplicate.paths['/preferred'].post.requestBody.content, {
    'Application/JSON': { schema: { type: 'string' } },
  });
  await assert.rejects(compile(duplicate, mediaSelection), ContractError);
});
