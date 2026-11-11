import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { compile } from '../dist/index.js';
import type {
  ObservedResponse,
  PreparedRequest,
  RequestValidationError,
} from '../src/runtime.ts';
import { entry, record } from './assertions.ts';
import { generatedWorkspace } from './generated-workspace.ts';

type ClientModule = {
  operations: Record<string, { build(input: unknown): PreparedRequest }>;
  RequestValidationError: typeof RequestValidationError;
};
type Options = {
  queryKey: readonly unknown[];
  queryFn(context: {
    queryKey: readonly unknown[];
    signal: AbortSignal;
    pageParam: string | number | null;
    direction: 'forward';
  }): Promise<unknown>;
};
type Family = {
  options(args: { context: Record<string, string>; input: unknown }): Options;
  body(): Family;
};
type QueriesModule = {
  createInfiniteQueries(config: {
    namespace: string;
    execute(request: PreparedRequest): Promise<ObservedResponse>;
  }): Record<string, Family>;
};

function operation(operationId: string, pagination: string) {
  return {
    operationId,
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      {
        name: 'limit',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 5 },
      },
      {
        name: 'X-Mode',
        in: 'header',
        schema: { type: 'string', enum: ['safe'] },
      },
      {
        name: pagination,
        in: 'query',
        schema:
          pagination === 'cursor'
            ? { type: 'string' }
            : { type: 'integer', minimum: 0 },
      },
    ],
    responses: {
      200: {
        description: 'Synthetic page',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                items: { type: 'array', items: { type: 'string' } },
                next: { type: ['string', 'null'] },
                start: { type: 'integer' },
                size: { type: 'integer' },
                count: { type: 'integer' },
              },
              required: ['items', 'next', 'start', 'size', 'count'],
            },
          },
        },
      },
    },
  };
}

let root: string;
let client: ClientModule;
let queries: QueriesModule;
before(async () => {
  const document = {
    openapi: '3.1.0',
    info: { title: 'Synthetic prototype parameter boundaries', version: '1' },
    paths: {
      '/cursor/{id}': { get: operation('cursorPages', 'cursor') },
      '/offset/{id}': { get: operation('offsetPages', 'start') },
      '/upload': {
        post: {
          operationId: 'upload',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    file: { type: 'string', format: 'binary' },
                    note: { type: 'string' },
                  },
                  required: ['file'],
                },
              },
            },
          },
          responses: { 204: { description: 'Accepted' } },
        },
      },
    },
  };
  root = await generatedWorkspace(
    await compile(document, {
      clients: ['consumer'],
      surfaces: { consumer: ['cursorPages', 'offsetPages', 'upload'] },
      targets: { consumer: 'native' },
      infiniteQueries: {
        consumer: {
          cursorPages: { cursor: 'cursor', nextCursor: 'next', items: 'items' },
          offsetPages: {
            offset: 'start',
            responseOffset: 'start',
            responseLimit: 'size',
            total: 'count',
            items: 'items',
          },
        },
      },
    }),
  );
  client = (await import(
    pathToFileURL(join(root, 'client.consumer.ts')).href
  )) as ClientModule;
  queries = (await import(
    pathToFileURL(join(root, 'client.consumer.queries.ts')).href
  )) as QueriesModule;
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function withPrototype(
  values: Record<string, unknown>,
  run: () => void | Promise<void>,
): Promise<void> {
  const saved = Object.entries(values).map(([name, value]) => {
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, name);
    Object.defineProperty(Object.prototype, name, {
      value,
      configurable: true,
      writable: true,
      enumerable: true,
    });
    return { name, descriptor };
  });
  try {
    await run();
  } finally {
    for (const { name, descriptor } of saved) {
      if (descriptor) Object.defineProperty(Object.prototype, name, descriptor);
      else Reflect.deleteProperty(Object.prototype, name);
    }
  }
}

void test('serialization cannot recover omitted query or header groups from prototype data', async () => {
  await withPrototype(
    { query: { limit: 999 }, headers: { 'X-Mode': 'unsafe' } },
    () => {
      const request = entry(client.operations, 'cursorPages').build({
        path: { id: 'item' },
      });
      assert.equal(request.url, '/cursor/item');
      assert.equal(Object.keys(request.headers).length, 0);
    },
  );
});

void test('serialization cannot recover omitted members of parsed parameter groups', async () => {
  await withPrototype({ limit: 999, 'X-Mode': 'unsafe' }, () => {
    for (const [query, headers, expected, expectedHeader] of [
      [{}, {}, '/cursor/item', undefined],
      [
        { limit: undefined },
        { 'X-Mode': undefined },
        '/cursor/item',
        undefined,
      ],
      [{ limit: 2 }, { 'X-Mode': 'safe' }, '/cursor/item?limit=2', 'safe'],
    ] as const) {
      const request = entry(client.operations, 'cursorPages').build({
        path: { id: 'item' },
        query,
        headers,
      });
      assert.equal(request.url, expected);
      assert.equal(request.headers['X-Mode'], expectedHeader);
    }
    for (const input of [
      { path: { id: 'item' }, query: { limit: 999 } },
      { path: { id: 'item' }, headers: { 'X-Mode': 'unsafe' } },
    ])
      assert.throws(
        () => entry(client.operations, 'cursorPages').build(input),
        client.RequestValidationError,
      );
  });
});

void test('valid structural inherited parameters still become parsed own values', async () => {
  await withPrototype(
    { query: { limit: 999 }, headers: { 'X-Mode': 'unsafe' }, limit: 999 },
    () => {
      const input: unknown = Object.create({
        path: Object.create({ id: 'inherited' }) as object,
        query: Object.create({ limit: 2 }) as object,
        headers: Object.create({ 'X-Mode': 'safe' }) as object,
      });
      const request = entry(client.operations, 'cursorPages').build(input);
      assert.equal(request.url, '/cursor/inherited?limit=2');
      assert.equal(request.headers['X-Mode'], 'safe');
    },
  );
});

for (const profile of ['cursor', 'offset'] as const) {
  for (const representation of ['envelope', 'body'] as const) {
    void test(`${profile} ${representation} pagination keeps omitted parameters absent across pages`, async () => {
      await withPrototype(
        {
          query: { limit: 1 },
          headers: { 'X-Mode': 'unsafe' },
          limit: 5,
          'X-Mode': 'unsafe',
        },
        async () => {
          const urls: string[] = [];
          const factories = queries.createInfiniteQueries({
            namespace: 'prototype-snapshot',
            execute: async (request) => {
              urls.push(request.url);
              assert.equal(Object.keys(request.headers).length, 0);
              const start = Number(
                new URL(
                  request.url,
                  'https://example.invalid',
                ).searchParams.get('start') ?? 0,
              );
              return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  items: ['item'],
                  next: 'next',
                  start,
                  size: 1,
                  count: 4,
                }),
              };
            },
          });
          const selected = entry(factories, `${profile}Pages`);
          const family = representation === 'body' ? selected.body() : selected;
          const options = family.options({
            context: {},
            input: { path: { id: 'item' } },
          });
          const context = {
            queryKey: options.queryKey,
            signal: new AbortController().signal,
            direction: 'forward' as const,
          };
          const initial =
            profile === 'cursor' ? '/cursor/item' : '/offset/item?start=0';
          assert.equal(options.queryKey[5], initial);
          await options.queryFn({
            ...context,
            pageParam: profile === 'cursor' ? null : 0,
          });
          Object.defineProperty(Object.prototype, 'query', {
            value: { limit: 2 },
            configurable: true,
            writable: true,
            enumerable: true,
          });
          await options.queryFn({
            ...context,
            pageParam: profile === 'cursor' ? 'next' : 1,
          });
          assert.deepEqual(urls, [
            initial,
            profile === 'cursor'
              ? '/cursor/item?cursor=next'
              : '/offset/item?start=1',
          ]);
        },
      );
    });
  }
}

void test('omitted multipart text is not revalidated from prototype data', async () => {
  await withPrototype({ note: '\ud800' }, () => {
    const request = entry(client.operations, 'upload').build({
      body: { file: { uri: 'file:///synthetic' } },
    });
    assert.ok(request.bodyKind === 'multipart');
    assert.equal(Object.hasOwn(record(request.body), 'note'), false);
    assert.throws(
      () =>
        entry(client.operations, 'upload').build({
          body: { file: { uri: 'file:///synthetic' }, note: '\ud800' },
        }),
      client.RequestValidationError,
    );
  });
});
