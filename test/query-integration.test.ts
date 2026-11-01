import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient, hydrate, skipToken } from '@tanstack/query-core';
import { z } from 'zod';
import { defineOperation, jsonValue, recordSchema } from '../src/runtime.ts';
import { defineQuery, defineOffsetQuery } from '../src/query-runtime.ts';
import { shareQueryData } from '../src/query-sharing.ts';
import { dehydrateJson } from './query-hydration.ts';

const policy = {
  auth: { label: 'public', transport: 'none' },
  retry: 'never',
  timeout: 'interactive',
} as const;
const options = z.object({}).strict().optional();
const item = defineOperation({
  operationId: 'read',
  method: 'GET',
  path: '/items',
  bodyKind: 'none',
  policy,
  parameters: [],
  options,
  headers: {},
  responses: {
    200: {
      headers: {},
      bodyKind: 'json',
      schema: z.object({
        label: z.string(),
        attributes: recordSchema(jsonValue),
      }),
    },
  },
});
const args = { context: { revision: 'one', count: 0 } };
const response = (label = 'first') => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: `{"label":${JSON.stringify(label)},"attributes":{"__proto__":{"kept":true},"constructor":null}}`,
});
function createFactory() {
  return defineQuery({
    operation: item,
    namespace: 'integration',
    client: 'consumer',
    operationId: 'read',
    bodyCache: true,
    execute: async () => response(),
  });
}
function cache() {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, structuralSharing: shareQueryData },
    },
  });
}

void test('body selection is idempotent, typed for warmers, and preserves cold map data', async () => {
  const envelope = createFactory();
  const body = envelope.body();
  assert.equal(envelope.body(), body);
  assert.equal(body.body(), body);
  assert.equal(body.key(args)[0], 'pom-query-body-v1');
  assert.notDeepEqual(envelope.key(args), body.key(args));
  assert.deepEqual(
    body.key(args),
    body.key({ context: { count: -0, revision: 'one' } }),
  );
  assert.equal(body.options({ ...args, input: skipToken }).queryFn, skipToken);
  const client = cache();
  try {
    const key = body.key(args);
    const seeded = {
      label: 'first',
      attributes: Object.fromEntries([
        ['__proto__', { kept: true }],
        ['constructor', null],
      ]),
    };
    client.setQueryData(key, seeded);
    client.setQueryData(key, {
      label: seeded.label,
      attributes: Object.fromEntries([
        ['__proto__', { kept: true }],
        ['constructor', null],
      ]),
    });
    const before = client.getQueryData(key);
    assert.equal(before, seeded);
    assert.equal(Object.hasOwn(before.attributes, '__proto__'), true);
    assert.equal(before.attributes['constructor'], null);
    const restored = cache();
    try {
      hydrate(restored, dehydrateJson(client));
      const hydrated = restored.getQueryData(key);
      const live = await restored.fetchQuery(body.options(args));
      assert.equal(restored.getQueryData(key), hydrated);
      assert.deepEqual(live, hydrated);
      assert.equal(live.label, 'first');
    } finally {
      restored.clear();
    }
  } finally {
    client.clear();
  }
});

void test('body and envelope caches are independent and never synchronize direct writes', async () => {
  let sends = 0;
  const envelope = defineQuery({
    operation: item,
    namespace: 'integration',
    client: 'consumer',
    operationId: 'read',
    bodyCache: true,
    execute: async () => {
      sends++;
      return response();
    },
  });
  const body = envelope.body();
  const client = cache();
  try {
    await Promise.all([
      client.fetchQuery({ ...envelope.options(args), staleTime: Infinity }),
      client.fetchQuery({ ...body.options(args), staleTime: Infinity }),
    ]);
    assert.equal(sends, 2);
    client.setQueryData(body.key(args), (previous) => ({
      ...previous!,
      label: 'edited',
    }));
    assert.equal(client.getQueryData(body.key(args))!.label, 'edited');
    assert.equal(client.getQueryData(envelope.key(args))!.data.label, 'first');
    await client.invalidateQueries(
      envelope.invalidationFilter({ context: args.context }),
    );
    assert.equal(client.getQueryState(body.key(args))!.isInvalidated, true);
    assert.equal(client.getQueryState(envelope.key(args))!.isInvalidated, true);
  } finally {
    client.clear();
  }
});

void test('operation invalidation recognizes exactly six canonical families after hydration', async () => {
  const factory = createFactory();
  const base = factory.key(args);
  const families = [
    'pom-query-v1',
    'pom-query-body-v1',
    'pom-infinite-v1',
    'pom-infinite-body-v1',
    'pom-offset-v1',
    'pom-offset-body-v1',
  ];
  const client = cache();
  const restored = cache();
  try {
    for (const family of families)
      client.setQueryData([family, ...base.slice(1)], { synthetic: true });
    for (const key of [
      ['pom-query-v2', ...base.slice(1)],
      [base[0], 'other', ...base.slice(2)],
      [...base.slice(0, 2), 'staff', ...base.slice(3)],
      [...base.slice(0, 3), 'different', ...base.slice(4)],
      [
        ...base.slice(0, 4),
        [
          ['count', '0'],
          ['revision', 'one'],
        ],
        ...base.slice(5),
      ],
      [
        ...base.slice(0, 4),
        [
          ['count', 0],
          ['extra', true],
          ['revision', 'one'],
        ],
        ...base.slice(5),
      ],
      [...base, 'future-layout'],
      [...base.slice(0, 4), {}, ...base.slice(5)],
      [
        ...base.slice(0, 4),
        [
          ['revision', 'one'],
          ['count', 0],
        ],
        ...base.slice(5),
      ],
      [...base.slice(0, 6), [['header', 7]]],
    ])
      client.setQueryData(key, { unrelated: true });
    hydrate(restored, dehydrateJson(client));
    const filter = factory.invalidationFilter({ context: args.context });
    assert.equal(Object.isFrozen(filter), true);
    assert.equal(Object.hasOwn(filter, 'queryKey'), false);
    assert.equal(restored.getQueryCache().findAll(filter).length, 6);
    assert.equal(
      restored
        .getQueryCache()
        .findAll(factory.filter({ context: args.context })).length,
      3,
    );
    assert.equal(
      restored
        .getQueryCache()
        .findAll(factory.invalidationFilter({ allContexts: true })).length,
      8,
    );
    const scope = { count: 0, revision: 'one' };
    const captured = factory.invalidationFilter({ context: scope });
    scope.revision = 'changed';
    assert.equal(restored.getQueryCache().findAll(captured).length, 6);
    await restored.invalidateQueries(filter);
    assert.equal(
      restored
        .getQueryCache()
        .getAll()
        .filter((entry) => entry.state.isInvalidated).length,
      6,
    );
  } finally {
    client.clear();
    restored.clear();
  }
});

void test('JSON null is cacheable while any bodyless success rejects body selection', async () => {
  const operation = defineOperation({
    operationId: 'null',
    method: 'GET',
    path: '/null',
    policy,
    bodyKind: 'none',
    options,
    parameters: [],
    headers: {},
    responses: { 200: { bodyKind: 'json', headers: {}, schema: z.null() } },
  });
  const factory = defineQuery({
    operation,
    namespace: 'integration',
    client: 'consumer',
    operationId: 'null',
    bodyCache: true,
    execute: async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: 'null',
    }),
  });
  const client = cache();
  try {
    assert.equal(await client.fetchQuery(factory.body().options(args)), null);
  } finally {
    client.clear();
  }
  let sends = 0;
  const mixed = defineOperation({
    operationId: 'mixed',
    method: 'GET',
    path: '/mixed',
    policy,
    bodyKind: 'none',
    options,
    parameters: [],
    headers: {},
    responses: {
      200: { bodyKind: 'json', headers: {}, schema: z.null() },
      204: { bodyKind: 'none', headers: {} },
    },
  });
  const mixedFactory = defineQuery({
    operation: mixed,
    namespace: 'integration',
    client: 'consumer',
    operationId: 'mixed',
    bodyCache: false,
    execute: async () => {
      sends++;
      return { status: 204, headers: {}, body: '' };
    },
  });
  assert.throws(
    () => (mixedFactory as unknown as { body: () => unknown }).body(),
    /bodyless success/,
  );
  assert.equal(sends, 0);
});

void test('offset body queries validate pagination before storing projected pages', async () => {
  const page = z.object({
    offset: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    items: z.array(z.string()),
  });
  const input = z
    .object({ query: z.object({ limit: z.number().int().min(1) }).strict() })
    .strict();
  const operation = defineOperation({
    operationId: 'page',
    method: 'GET',
    path: '/page',
    policy,
    bodyKind: 'none',
    options: z
      .object({
        query: z
          .object({
            offset: z.number().int().nonnegative(),
            limit: z.number().int().min(1),
          })
          .strict(),
      })
      .strict(),
    parameters: [
      { name: 'offset', in: 'query', required: true },
      { name: 'limit', in: 'query', required: true },
    ],
    headers: {},
    responses: { 200: { bodyKind: 'json', headers: {}, schema: page } },
  });
  let wrongOffset = true;
  const envelope = defineOffsetQuery({
    operation,
    input,
    namespace: 'integration',
    client: 'consumer',
    operationId: 'page',
    bodyCache: true,
    offset: 'offset',
    fields: {
      offset: 'offset',
      limit: 'limit',
      total: 'total',
      items: 'items',
    },
    page: (data) => data,
    execute: async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        offset: wrongOffset ? 1 : 0,
        limit: 1,
        total: 1,
        items: ['first'],
      }),
    }),
  });
  const body = envelope.body();
  assert.equal(body.body(), body);
  assert.equal(envelope.body(), body);
  const arguments_ = { ...args, input: { query: { limit: 1 } } };
  const client = cache();
  try {
    await assert.rejects(
      client.fetchInfiniteQuery(body.options(arguments_)),
      (error) => body.isError(error) && error.result.kind === 'protocol',
    );
    assert.equal(client.getQueryData(body.key(arguments_)), undefined);
    wrongOffset = false;
    const data = await client.fetchInfiniteQuery(body.options(arguments_));
    assert.deepEqual(data.pageParams, [0]);
    assert.deepEqual(body.items(data), ['first']);
    assert.equal(data.pages[0]!.offset, 0);
    assert.equal(Object.hasOwn(data.pages[0]!, 'data'), false);
  } finally {
    client.clear();
  }
});
