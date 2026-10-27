import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { QueryClient, hydrate, skipToken } from '@tanstack/query-core';
import { compile } from '../dist/index.js';
import { runtimeInput } from './assertions.ts';
import { queryFixture, querySelection } from './query-fixture.ts';
import { generatedWorkspace } from './generated-workspace.ts';
import { dehydrateJson } from './query-hydration.ts';
import type {
  CacheContext,
  QueryExecutor,
} from './.generated/queries/client.consumer.queries.ts';

type Module = typeof import('./.generated/queries/client.consumer.queries.ts');
type Staff = typeof import('./.generated/queries/client.staff.queries.ts');
let root: string;
let module: Module;
let staff: Staff;

before(async () => {
  root = await generatedWorkspace(
    await compile(queryFixture(), querySelection),
  );
  module = (await import(
    pathToFileURL(join(root, 'client.consumer.queries.ts')).href
  )) as Module;
  staff = (await import(
    pathToFileURL(join(root, 'client.staff.queries.ts')).href
  )) as Staff;
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const input = { path: { id: 'item' } };
function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
}

void test('skipToken bypasses only request building, retaining validated immutable context and distinct identities', () => {
  let calls = 0;
  const queries = module.createQueries({
    namespace: 'skip',
    execute: async () => {
      calls += 1;
      throw new Error('Skipped executor must not run');
    },
  });
  const context = { session: 'one', variant: -0 };
  const skipped = queries.readItem.options({ context, input: skipToken });
  assert.equal(skipped.queryFn, skipToken);
  assert.equal(skipped.retry, false);
  assert.ok(Object.isFrozen(skipped));
  assert.ok(Object.isFrozen(skipped.queryKey));
  const snapshot = JSON.stringify(skipped.queryKey);
  context.session = 'two';
  assert.equal(JSON.stringify(skipped.queryKey), snapshot);
  assert.deepEqual(
    skipped.queryKey,
    queries.readItem.options({
      context: { variant: 0, session: 'one' },
      input: skipToken,
    }).queryKey,
  );
  assert.notDeepEqual(
    skipped.queryKey,
    queries.readItem.key({ context: { session: 'one', variant: 0 }, input }),
  );
  assert.notDeepEqual(
    skipped.queryKey,
    queries.health.options({
      context: { session: 'one', variant: 0 },
      input: skipToken,
    }).queryKey,
  );
  assert.notDeepEqual(
    skipped.queryKey,
    queries.readItem.options({ context: {}, input: skipToken }).queryKey,
  );
  assert.throws(
    () => runtimeInput(queries.readItem.key, { context: {}, input: skipToken }),
    /real input/,
  );
  for (const value of [
    undefined,
    null,
    Symbol('skip'),
    {},
    { path: { id: '' } },
  ])
    assert.throws(
      () =>
        runtimeInput(queries.readItem.options, { context: {}, input: value }),
      { name: 'RequestValidationError' },
    );
  for (const value of [
    undefined,
    null,
    { nested: {} },
    { invalid: undefined },
    { invalid: Infinity },
  ])
    assert.throws(
      () =>
        runtimeInput(queries.readItem.options, {
          context: value,
          input: skipToken,
        }),
      TypeError,
    );
  assert.equal(calls, 0);
});

void test('operation filters isolate complete canonical contexts and every other identity boundary before and after JSON hydration', async () => {
  const client = queryClient();
  const restored = queryClient();
  const contexts: readonly CacheContext[] = [
    {},
    { tenant: 'one' },
    { tenant: 'one', zone: 'extra' },
    { tenant: 1 },
    { tenant: '1' },
    { tenant: true },
    { tenant: null },
    { tenant: 0 },
    { ['__proto__']: 'special' },
    { constructor: null },
    { constructor: null, extra: false },
    { prototype: 'special' },
    { '': false },
    { '0': false },
    { alpha: false, zeta: null },
  ];
  const execute: QueryExecutor = async (request) =>
    request.operationId === 'health'
      ? { status: 204, headers: {}, body: '' }
      : {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: '{"id":"item","label":"Synthetic"}',
        };
  const queries = module.createQueries({ namespace: 'filter', execute });
  const otherNamespace = module.createQueries({
    namespace: 'elsewhere',
    execute,
  });
  const otherClient = staff.createQueries({ namespace: 'filter', execute });
  const targets: { key: readonly unknown[]; context: number }[] = [];
  try {
    for (const [index, context] of contexts.entries()) {
      // All request variants: different paths, query parameters and headers.
      for (const request of [
        input,
        {
          path: { id: 'other' },
          query: { page: 2 },
          headers: { 'X-View': 'detail' },
        },
      ]) {
        const options = queries.readItem.options({ context, input: request });
        await client.fetchQuery(options);
        targets.push({ key: options.queryKey, context: index });
      }
      await client.fetchQuery(queries.health.options({ context }));
      await client.fetchQuery(
        otherNamespace.readItem.options({ context, input }),
      );
      await client.fetchQuery(otherClient.readItem.options({ context, input }));
    }
    client.setQueryData(['application-owned'], 'unrelated');
    hydrate(restored, dehydrateJson(client));
    for (const cache of [client, restored]) {
      for (const [index, context] of contexts.entries()) {
        // Filter field order and caller mutations cannot change its snapshot.
        const reordered = Object.fromEntries(Object.entries(context).reverse());
        const filter = queries.readItem.filter({ context: reordered });
        reordered['afterConstruction'] = true;
        assert.ok(Object.isFrozen(filter));
        assert.ok(Object.isFrozen(filter.queryKey));
        const expected = targets
          .filter((target) => target.context === index)
          .map((target) => JSON.stringify(target.key))
          .sort();
        assert.deepEqual(
          cache
            .getQueryCache()
            .findAll(filter)
            .map((query) => JSON.stringify(query.queryKey))
            .sort(),
          expected,
        );
      }
      assert.deepEqual(
        cache
          .getQueryCache()
          .findAll(queries.readItem.filter({ context: { tenant: -0 } }))
          .map((query) => query.queryKey),
        cache
          .getQueryCache()
          .findAll(queries.readItem.filter({ context: { tenant: 0 } }))
          .map((query) => query.queryKey),
      );
      assert.equal(
        cache
          .getQueryCache()
          .findAll(queries.readItem.filter({ context: { missing: true } }))
          .length,
        0,
      );
      const all = queries.readItem.filter({ allContexts: true });
      assert.equal(cache.getQueryCache().findAll(all).length, targets.length);
      await cache.invalidateQueries({
        ...queries.readItem.filter({ context: { tenant: 'one' } }),
        refetchType: 'none',
      });
      const expectedInvalidated = targets
        .filter((target) => target.context === 1)
        .map((target) => JSON.stringify(target.key))
        .sort();
      assert.deepEqual(
        cache
          .getQueryCache()
          .getAll()
          .filter((query) => query.state.isInvalidated)
          .map((query) => JSON.stringify(query.queryKey))
          .sort(),
        expectedInvalidated,
      );
      await cache.invalidateQueries({ ...all, refetchType: 'none' });
      assert.deepEqual(
        cache
          .getQueryCache()
          .getAll()
          .filter((query) => query.state.isInvalidated)
          .map((query) => JSON.stringify(query.queryKey))
          .sort(),
        targets.map((target) => JSON.stringify(target.key)).sort(),
      );
    }
  } finally {
    client.clear();
    restored.clear();
  }
});

void test('operation filter scopes reject ambiguous JavaScript input without evaluating accessors', () => {
  const { readItem } = module.createQueries({
    namespace: 'filter-validation',
    execute: async () => {
      throw new Error('No transport');
    },
  });
  let reads = 0;
  for (const value of [
    undefined,
    null,
    {},
    { allContexts: false },
    { allContexts: true, context: {} },
    { context: {}, extra: true },
    { context: { invalid: undefined } },
    { context: { invalid: NaN } },
    { context: [] },
    Object.defineProperty({}, 'context', {
      enumerable: true,
      get() {
        reads += 1;
        return {};
      },
    }),
    Object.defineProperty({}, 'allContexts', { value: true }),
    { allContexts: true, [Symbol('scope')]: true },
  ])
    assert.throws(() => runtimeInput(readItem.filter, value), TypeError);
  assert.equal(reads, 0);
});
