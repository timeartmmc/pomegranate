import assert from 'node:assert/strict';
import { QueryClient, skipToken, hydrate } from '@tanstack/query-core';
import { dehydrateJson } from './query-hydration.ts';

type QueryModule =
  typeof import('./.generated/queries/client.consumer.queries.ts');

// Shared runtime acceptance check, also run from the packed install after the
// compiler is removed. Expected wire data is independent of emitted source.
export async function verifyQueries(
  createQueries: QueryModule['createQueries'],
  QueryResponseError: QueryModule['QueryResponseError'],
) {
  let calls = 0;
  const queries = createQueries({
    namespace: 'synthetic-api-v1',
    execute: async (request, { signal, context }) => {
      calls += 1;
      assert.equal(signal.aborted, false);
      assert.ok(Object.isFrozen(context));
      if (request.operationId === 'readItem')
        assert.deepEqual(context, {
          locale: 'en',
          session: 'synthetic-session-1',
        });
      request.validateHeaders({ ...request.headers, 'X-Language': 'en' });
      if (request.operationId === 'health')
        return { status: 204, headers: {}, body: '' };
      assert.equal(request.url, '/items/a%2Fb?active=false&count=0');
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'a/b', label: 'Synthetic', additive: true }),
      };
    },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 3, gcTime: Infinity } },
  });
  try {
    const args = {
      context: { session: 'synthetic-session-1', locale: 'en' },
      input: { path: { id: 'a/b' }, query: { active: false, count: 0 } },
    };
    const options = queries.readItem.options(args);
    const result = await client.fetchQuery(options);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { id: 'a/b', label: 'Synthetic' });
    assert.deepEqual(client.getQueryData(queries.readItem.key(args)), result);
    assert.equal(calls, 1);
    const same = queries.readItem.key({
      ...args,
      context: { locale: 'en', session: 'synthetic-session-1' },
      input: {
        ...args.input,
        query: { ...args.input.query, filter: null, tags: [] },
      },
    });
    assert.deepEqual(options.queryKey, same);
    const other = queries.readItem.key({
      ...args,
      context: { ...args.context, session: 'synthetic-session-2' },
    });
    assert.equal(client.getQueryData(other), undefined);
    const bodyless = await client.fetchQuery(
      queries.health.options({ context: {} }),
    );
    assert.equal(bodyless.status, 204);
    assert.equal(bodyless.data, undefined);
    assert.equal(bodyless.kind, 'success');

    // Run these against source AND emitted JavaScript from the packed install.
    const skipped = queries.readItem.options({
      context: args.context,
      input: skipToken,
    });
    assert.equal(skipped.queryFn, skipToken);
    assert.notDeepEqual(skipped.queryKey, options.queryKey);
    assert.throws(
      () =>
        queries.readItem.options({ context: {}, input: { path: { id: '' } } }),
      { name: 'RequestValidationError' },
    );
    const restored = new QueryClient();
    try {
      hydrate(restored, dehydrateJson(client));
      for (const cache of [client, restored]) {
        const exact = queries.readItem.filter({ context: { ...args.context } });
        assert.equal(cache.getQueryCache().findAll(exact).length, 1);
        assert.equal(
          cache.getQueryCache().findAll(
            queries.readItem.filter({
              context: { session: 'synthetic-session-1' },
            }),
          ).length,
          0,
        );
        assert.equal(
          cache
            .getQueryCache()
            .findAll(queries.readItem.filter({ allContexts: true })).length,
          1,
        );
        await cache.invalidateQueries({ ...exact, refetchType: 'none' });
        assert.equal(
          cache.getQueryState(options.queryKey)?.isInvalidated,
          true,
        );
        assert.equal(
          cache.getQueryState(queries.health.key({ context: {} }))
            ?.isInvalidated,
          false,
        );
      }
    } finally {
      restored.clear();
    }

    let zeroCalls = 0;
    const zeros = createQueries({
      namespace: 'signed-zero',
      execute: async (_request, { context }) => {
        zeroCalls += 1;
        assert.equal(context['variant'], 0);
        return { status: 204, headers: {}, body: '' };
      },
    });
    for (const variant of [-0, 0])
      await client.fetchQuery({
        ...zeros.health.options({ context: { variant } }),
        staleTime: Infinity,
      });
    assert.equal(zeroCalls, 1);

    let failures = 0;
    const broken = createQueries({
      namespace: 'broken',
      execute: async () => {
        failures += 1;
        return {
          status: 202,
          headers: {
            'Content-Type': 'application/json',
            'X-Request-ID': 'synthetic',
          },
          body: '{"state":"ready","value":7}',
        };
      },
    });
    const invalid = broken.readOutcome.options({ context: {} });
    await assert.rejects(client.fetchQuery(invalid), (error: unknown) => {
      assert.ok(error instanceof QueryResponseError);
      assert.equal(error.result.kind, 'protocol');
      assert.equal(error.result.status, 202);
      assert.equal(Object.hasOwn(error.result, 'data'), false);
      return true;
    });
    assert.equal(failures, 1);
    assert.equal(client.getQueryData(invalid.queryKey), undefined);

    const malformedExecutor = async () => ({
      status: '200',
      headers: { 'Content-Type': 'application/json' },
      body: '{"id":"item","label":"Malformed evidence"}',
    });
    const malformed = createQueries({
      namespace: 'malformed-evidence',
      // Exercise a JavaScript adapter that violates the TypeScript interface.
      execute: malformedExecutor as unknown as Parameters<
        typeof createQueries
      >[0]['execute'],
    });
    const malformedOptions = malformed.readItem.options(args);
    await assert.rejects(client.fetchQuery(malformedOptions), {
      name: 'TypeError',
      message: /response status must be a number/,
    });
    assert.equal(client.getQueryData(malformedOptions.queryKey), undefined);

    let release!: (value: {
      status: number;
      headers: Record<string, string>;
      body: string;
    }) => void;
    const delayed = new Promise<{
      status: number;
      headers: Record<string, string>;
      body: string;
    }>((resolve) => {
      release = resolve;
    });
    let forwarded: AbortSignal | undefined;
    const cancellable = createQueries({
      namespace: 'cancelled',
      execute: async (_request, { signal }) => {
        forwarded = signal;
        return delayed;
      },
    });
    const cancelled = cancellable.readItem.options(args);
    const pending = client
      .fetchQuery(cancelled)
      .catch((error: unknown) => error);
    await client.cancelQueries({ queryKey: cancelled.queryKey, exact: true });
    assert.equal(forwarded?.aborted, true);
    release({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '{"id":"late","label":"Late"}',
    });
    await pending;
    await delayed;
    await Promise.resolve();
    assert.equal(client.getQueryData(cancelled.queryKey), undefined);
    let mapVersion = 0;
    const maps = createQueries({
      namespace: 'map-cache',
      execute: async () => ({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: `{"__proto__":"retained","constructor":null,"version":${++mapVersion}}`,
      }),
    });
    const mapOptions = maps.readMap.options({ context: {} });
    for (const version of [1, 2]) {
      await client.fetchQuery(mapOptions);
      const expected: unknown = JSON.parse(
        `{"__proto__":"retained","constructor":null,"version":${version}}`,
      );
      assert.deepEqual(
        client.getQueryData(mapOptions.queryKey)?.data,
        expected,
      );
    }
  } finally {
    client.clear();
  }
}
