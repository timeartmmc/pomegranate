import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient } from '@tanstack/query-core';
import { defineCall } from '../src/call-runtime.ts';
import { executionConfig } from '../src/execution-runtime.ts';
import type { CancellationMapper } from '../src/execution-runtime.ts';
import {
  defineInfiniteQuery,
  defineOffsetQuery,
  defineQuery,
  queryConfig,
} from '../src/query-runtime.ts';
import { defineOperation, nullValue } from '../src/runtime.ts';
import { runtimeInput } from './assertions.ts';
import {
  limitInput,
  noOptions,
  offsetPage,
  pageOptions,
} from './native-schemas.ts';

const policy = { auth: 'public' } as const;
const operation = defineOperation({
  operationId: 'read',
  method: 'GET',
  path: '/read',
  bodyKind: 'none',
  security: { transport: 'none' },
  policy,
  parameters: [],
  options: noOptions,
  headers: {},
  responses: {
    200: {
      headers: {},
      bodyKind: 'content',
      content: {
        'application/json': { bodyKind: 'json', schema: nullValue },
      },
    },
  },
});
const config = {
  namespace: 'own-config',
  execute: async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: 'null',
  }),
};
const identity = { client: 'consumer', operationId: 'read', operation };
type Page = Exclude<ReturnType<typeof offsetPage>, symbol>;

async function inherited(
  values: Readonly<Record<string, unknown>>,
  check: () => Promise<void>,
): Promise<void> {
  const before = Object.keys(values).map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(Object.prototype, name)] as const,
  );
  try {
    for (const [name, value] of Object.entries(values))
      Object.defineProperty(Object.prototype, name, {
        value,
        writable: true,
        configurable: true,
      });
    await check();
  } finally {
    for (const [name, descriptor] of before)
      if (descriptor) Object.defineProperty(Object.prototype, name, descriptor);
      else Reflect.deleteProperty(Object.prototype, name);
  }
}

for (const cold of [true, false]) {
  void test(`absent execution configuration ignores inherited callbacks ${cold ? 'before' : 'after'} normalization`, async () => {
    const normalizedCall = cold ? undefined : executionConfig(config, 'client');
    const normalizedQuery = cold ? undefined : queryConfig(config);
    await inherited({ mapCancellation: 'not a callback' }, async () => {
      const callConfig = normalizedCall ?? executionConfig(config, 'client');
      const queryRuntime = normalizedQuery ?? queryConfig(config);
      assert.ok(Object.hasOwn(callConfig, 'mapCancellation'));
      assert.ok(Object.hasOwn(queryRuntime, 'mapCancellation'));
      assert.equal(callConfig.mapCancellation, undefined);
      assert.equal(queryRuntime.mapCancellation, undefined);
      const call = defineCall({ ...callConfig, ...identity });
      assert.equal((await call.call({ context: {} })).data, null);
      const cache = new QueryClient();
      try {
        const query = defineQuery({ ...queryRuntime, ...identity });
        assert.equal(
          (await cache.fetchQuery(query.options({ context: {} }))).data,
          null,
        );
      } finally {
        cache.clear();
      }
    });
  });

  void test(`direct factories ignore inherited optional configuration ${cold ? 'before' : 'after'} construction`, async () => {
    const makeCall = () => defineCall({ ...config, ...identity });
    const makeQuery = () => defineQuery({ ...config, ...identity });
    const call = cold ? undefined : makeCall();
    const query = cold ? undefined : makeQuery();
    const reason = new Error('caller cancellation');
    const controller = new AbortController();
    controller.abort(reason);
    let inheritedCalls = 0;
    await inherited(
      {
        mapCancellation: () => {
          inheritedCalls++;
          return { error: new Error('inherited cancellation') };
        },
        responseIssues: 'not a callback',
        bodyCache: true,
      },
      async () => {
        const currentCall = call ?? makeCall();
        const currentQuery = query ?? makeQuery();
        await assert.rejects(
          currentCall.call({ context: {}, signal: controller.signal }),
          (error) => error === reason,
        );
        assert.throws(() => currentQuery.body(), /bodyless success/);
        const options = currentQuery.options({ context: {} });
        const cache = new QueryClient();
        try {
          await assert.rejects(
            options.queryFn({
              client: cache,
              queryKey: options.queryKey,
              signal: controller.signal,
              meta: undefined,
            }),
            (error) => error === reason,
          );
          assert.equal((await cache.fetchQuery(options)).data, null);
          assert.equal(inheritedCalls, 0);
        } finally {
          cache.clear();
        }
      },
    );
  });
}

void test('ordinary envelope and body queries never inherit response checkers', async () => {
  const query = defineQuery({ ...config, ...identity, bodyCache: true });
  const context = { responseIssues: 'application context' };
  const envelopeOptions = query.options({ context });
  const bodyOptions = query.body().options({ context });
  await inherited({ responseIssues: 'not a callback' }, async () => {
    const cache = new QueryClient();
    try {
      assert.equal((await cache.fetchQuery(envelopeOptions)).data, null);
      assert.equal(await cache.fetchQuery(bodyOptions), null);
      assert.deepEqual(envelopeOptions.queryKey[4], [
        ['responseIssues', 'application context'],
      ]);
    } finally {
      cache.clear();
    }
  });
});

void test('required execution settings must also belong to the caller', async () => {
  await inherited(
    { namespace: 'inherited', execute: config.execute },
    async () => {
      assert.throws(
        () => runtimeInput(queryConfig, { execute: config.execute }),
        /namespace must be a nonempty string/,
      );
      assert.throws(
        () => runtimeInput(executionConfig, { namespace: 'own' }),
        /executor must be a function/,
      );
      assert.throws(
        () =>
          runtimeInput(defineCall, { ...identity, execute: config.execute }),
        /namespace must be a nonempty string/,
      );
    },
  );
});

void test('lazy body factories consume one fixed configuration snapshot', async () => {
  const mapped = new Error('captured cancellation');
  const replacement = new Error('later configuration');
  let reads = 0;
  let mapper: CancellationMapper = () => ({ error: mapped });
  const supplied = {
    ...config,
    ...identity,
    bodyCache: true,
    get mapCancellation(): CancellationMapper {
      reads++;
      return mapper;
    },
  };
  const query = defineQuery(supplied);
  assert.equal(reads, 1);
  supplied.bodyCache = false;
  mapper = () => ({ error: replacement });
  const body = query.body();
  assert.equal(body.body(), body);
  assert.equal(reads, 1);
  const options = body.options({ context: {} });
  const controller = new AbortController();
  controller.abort(new Error('caller cancellation'));
  const cache = new QueryClient();
  try {
    await assert.rejects(
      options.queryFn({
        client: cache,
        queryKey: options.queryKey,
        signal: controller.signal,
        meta: undefined,
      }),
      (error) => error === mapped,
    );
    assert.equal(await cache.fetchQuery(options), null);
    assert.equal(reads, 1);
  } finally {
    cache.clear();
  }
});

void test('own cancellation mappers and explicit body capabilities survive inherited alternatives', async () => {
  const mapped = new Error('own cancellation');
  const reason = new Error('caller cancellation');
  const controller = new AbortController();
  controller.abort(reason);
  let ownCalls = 0;
  const mapCancellation: CancellationMapper = (event) => {
    ownCalls++;
    assert.equal(event.reason, reason);
    assert.equal(event.context['mapCancellation'], 'application context');
    return { error: mapped };
  };
  const own = { ...config, mapCancellation };
  await inherited({ mapCancellation: false, bodyCache: false }, async () => {
    assert.throws(
      () =>
        runtimeInput(queryConfig, { ...config, mapCancellation: 'invalid' }),
      /cancellation mapper must be a function/,
    );
    const call = defineCall({ ...executionConfig(own), ...identity });
    const query = defineQuery({
      ...queryConfig(own),
      ...identity,
      bodyCache: true,
    });
    const context = { mapCancellation: 'application context' };
    await assert.rejects(
      call.call({ context, signal: controller.signal }),
      (error) => error === mapped,
    );
    const cache = new QueryClient();
    try {
      const options = query.body().options({ context });
      await assert.rejects(
        options.queryFn({
          client: cache,
          queryKey: options.queryKey,
          signal: controller.signal,
          meta: undefined,
        }),
        (error) => error === mapped,
      );
      assert.equal(ownCalls, 2);
      assert.equal(await cache.fetchQuery(options), null);
    } finally {
      cache.clear();
    }
  });
});

void test('paged factories retain fixed callbacks and field metadata while preparing their own checkers', async () => {
  const pageOperation = defineOperation({
    operationId: 'page',
    method: 'GET',
    path: '/page',
    bodyKind: 'none',
    security: { transport: 'none' },
    policy,
    options: pageOptions,
    parameters: [
      { name: 'offset', in: 'query', required: true },
      { name: 'limit', in: 'query', required: true },
    ],
    headers: {},
    responses: {
      200: {
        bodyKind: 'content',
        headers: {},
        content: {
          'application/json': { bodyKind: 'json', schema: offsetPage },
        },
      },
    },
  });
  let offset = 0;
  const runtime = {
    namespace: 'own-page-config',
    client: 'consumer',
    operationId: 'page',
    operation: pageOperation,
    execute: async () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offset, limit: 1, total: 1, items: ['first'] }),
    }),
  };
  await inherited({ responseIssues: 'not a callback' }, async () => {
    const cursorConfig = {
      ...runtime,
      input: pageOptions,
      cursor: 'after',
      nextCursor: (): string | null => null,
      items: (page: Page) => page.items,
      bodyCache: true,
    };
    const cursor = defineInfiniteQuery(cursorConfig);
    const offsetConfig = {
      ...runtime,
      input: limitInput,
      offset: 'offset',
      fields: {
        offset: 'offset',
        limit: 'limit',
        total: 'total',
        items: 'items',
      },
      page: (page: Page) => page,
      bodyCache: true,
    };
    const offsets = defineOffsetQuery(offsetConfig);
    cursorConfig.nextCursor = () => 'later configuration';
    cursorConfig.bodyCache = false;
    offsetConfig.page = () => ({ offset: 9, limit: 1, total: 1, items: [] });
    offsetConfig.fields.offset = 'later configuration';
    offsetConfig.bodyCache = false;
    const cursorBody = cursor.body();
    const offsetBody = offsets.body();
    assert.equal(cursorBody.body(), cursorBody);
    assert.equal(offsetBody.body(), offsetBody);
    const cache = new QueryClient();
    try {
      const cursorOptions = cursor.options({
        context: {},
        input: { query: { offset: 0, limit: 1 } },
      });
      const cursorResult = await cache.fetchInfiniteQuery(cursorOptions);
      assert.deepEqual(cursor.items(cursorResult), ['first']);
      const first = cursorResult.pages[0];
      assert.ok(first);
      assert.equal(
        cursorOptions.getNextPageParam(
          first,
          cursorResult.pages,
          null,
          cursorResult.pageParams,
        ),
        undefined,
      );
      const options = offsets.options({
        context: {},
        input: { query: { limit: 1 } },
      });
      const result = await cache.fetchInfiniteQuery(options);
      assert.deepEqual(offsets.items(result), ['first']);
      offset = 1;
      await assert.rejects(
        cache.fetchInfiniteQuery(options),
        (error) =>
          offsets.isError(error) &&
          error.result.kind === 'protocol' &&
          error.result.issues.some(
            (issue) =>
              issue.path?.[0] === 'offset' && /offset/.test(issue.message),
          ),
      );
    } finally {
      cache.clear();
    }
  });
});
