import assert from 'node:assert/strict';
import {
  QueryClient,
  InfiniteQueryObserver,
  dehydrate,
  hydrate,
  skipToken,
} from '@tanstack/query-core';
import { setImmediate } from 'node:timers/promises';
import { runtimeInput } from './assertions.ts';

type Module = typeof import('./.generated/infinite/client.consumer.queries.ts');
type Observed = import('./.generated/infinite/runtime.ts').ObservedResponse;

export async function verifyInfiniteQueries(
  create: Module['createInfiniteQueries'],
  QueryResponseError: Module['QueryResponseError'],
) {
  const response = (
    cursor: string | null,
    id = 'item',
    status = 200,
  ): Observed => ({
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      results: [
        {
          id,
          label: id,
          attributes: { ['__proto__']: null, constructor: null },
        },
      ],
      continuation: cursor,
    }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 3, gcTime: Infinity } },
  });
  const restored = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  });
  const urls: string[] = [];
  const cursors = ['', 'a/b?&🔥', null];
  const queries = create({
    namespace: 'infinite',
    execute: async (request, { context, signal }) => {
      urls.push(request.url);
      assert.deepEqual(context, { session: 'original', variant: 0 });
      assert.ok(Object.isFrozen(context));
      assert.equal(signal.aborted, false);
      return response(
        cursors[urls.length - 1]!,
        'duplicate',
        urls.length === 2 ? 206 : 200,
      );
    },
  });
  const args = {
    context: { session: 'original', variant: -0 },
    input: {
      path: { collection: 'a/b' },
      query: { limit: 2, tags: ['original'] },
      headers: { 'X-View': 'small' },
    },
  };
  const options = queries.listItems.options(args);
  args.context.session = 'changed';
  args.input.path.collection = 'changed';
  args.input.query.tags.push('changed');
  args.input.headers['X-View'] = 'changed';
  try {
    const data = await client.fetchInfiniteQuery({ ...options, pages: 10 });
    assert.equal(data.pages.length, 3);
    assert.deepEqual(data.pageParams, [null, '', 'a/b?&🔥']);
    assert.deepEqual(
      urls.map((url) =>
        new URL(url, 'https://synthetic.invalid').searchParams.get('after'),
      ),
      [null, '', 'a/b?&🔥'],
    );
    for (const url of urls) {
      const wire = new URL(url, 'https://synthetic.invalid');
      assert.equal(wire.pathname, '/collections/a%2Fb/items');
      assert.deepEqual(wire.searchParams.getAll('tags'), ['original']);
      assert.equal(wire.searchParams.get('limit'), '2');
    }
    assert.deepEqual(
      queries.listItems.items(data).map((item) => item.id),
      ['duplicate', 'duplicate', 'duplicate'],
    );
    assert.deepEqual(queries.listItems.items(undefined), []);
    const first = data.pages[0]!;
    const many = Array.from({ length: 150_000 }, () => first.data.results[0]!);
    assert.equal(
      queries.listItems.items({
        pages: [{ ...first, data: { ...first.data, results: many } }],
        pageParams: [null],
      }).length,
      many.length,
    );
    assert.equal(
      Object.hasOwn(queries.listItems.items(data)[0]!.attributes!, '__proto__'),
      true,
    );
    assert.equal(
      options.getNextPageParam(
        data.pages[2]!,
        data.pages,
        data.pageParams[2]!,
        data.pageParams,
      ),
      undefined,
    );
    assert.equal(Object.isFrozen(options), false);
    assert.ok(Object.isFrozen(options.queryKey));
    const skipped = queries.listItems.options({
      context: {},
      input: skipToken,
    });
    assert.equal(skipped.queryFn, skipToken);
    assert.notDeepEqual(skipped.queryKey, options.queryKey);
    assert.notDeepEqual(
      queries.listItems.key({
        context: {},
        input: { path: { collection: 'a/b' } },
      }),
      options.queryKey,
    );

    hydrate(restored, JSON.parse(JSON.stringify(dehydrate(client))) as unknown);
    const hydrated = await restored.fetchInfiniteQuery({
      ...options,
      staleTime: Infinity,
    });
    // JSON hydration preserves the envelope's values, while plain records
    // replace the runtime parser's null-prototype header dictionaries.
    assert.deepEqual(hydrated, JSON.parse(JSON.stringify(data)) as unknown);
    assert.equal(urls.length, 3);
    assert.equal(await client.ensureInfiniteQueryData(options), data);
    const prefetch = create({
      namespace: 'prefetch',
      execute: async () => response(null, 'prefetched'),
    });
    const prefetchOptions = prefetch.listItems.options({
      context: {},
      input: { path: { collection: 'prefetch' } },
    });
    await client.prefetchInfiniteQuery(prefetchOptions);
    assert.equal(
      client.getQueryData(prefetchOptions.queryKey)?.pages[0]?.data.results[0]
        ?.id,
      'prefetched',
    );
    for (const cache of [client, restored]) {
      assert.equal(
        cache.getQueryCache().findAll(
          queries.listItems.filter({
            context: { variant: 0, session: 'original' },
          }),
        ).length,
        1,
      );
      assert.equal(
        cache
          .getQueryCache()
          .findAll(
            queries.listItems.filter({ context: { session: 'original' } }),
          ).length,
        0,
      );
    }

    // A cursor cycle stops at the last distinct retained page parameter.
    const cycleUrls: string[] = [];
    const cycling = create({
      namespace: 'cycle',
      execute: async (request) => {
        cycleUrls.push(request.url);
        return response(
          cycleUrls.length === 1 ? 'a' : cycleUrls.length === 2 ? 'b' : 'a',
        );
      },
    });
    const cycleData = await client.fetchInfiniteQuery({
      ...cycling.listItems.options({
        context: {},
        input: { path: { collection: 'cycle' } },
      }),
      pages: 50,
    });
    assert.deepEqual(cycleData.pageParams, [null, 'a', 'b']);
    assert.equal(cycleUrls.length, 3);

    // Later-page failures must not replace a previously validated collection.
    let observed = response('next', 'previous');
    let calls = 0;
    const failing = create({
      namespace: 'failures',
      execute: async () => {
        calls++;
        return observed;
      },
    });
    const failureOptions = failing.listItems.options({
      context: {},
      input: { path: { collection: 'fail' } },
    });
    const previous = await client.fetchInfiniteQuery(failureOptions);
    const observer = new InfiniteQueryObserver(client, {
      ...failureOptions,
      enabled: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      for (const [bad, kind] of [
        [
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
            body: '{"detail":"Missing"}',
          },
          'error',
        ],
        [
          { ...response(null), body: '{"results":[],"continuation":false}' },
          'protocol',
        ],
        [{ ...response(null), body: '{"results":[]}' }, 'protocol'],
        [{ ...response(null), status: 299 }, 'protocol'],
      ] as const) {
        observed = bad;
        const result = await observer.fetchNextPage();
        assert.ok(result.error instanceof QueryResponseError);
        assert.ok(Object.isFrozen(result.error.result));
        assert.equal(result.error.result.kind, kind);
        assert.equal(client.getQueryData(failureOptions.queryKey), previous);
      }
      assert.equal(calls, 5);
      observed = response(null, 'recovered');
      const recovered = await observer.fetchNextPage();
      assert.deepEqual(
        recovered.data?.pages.map((page) => page.data.results[0]?.id),
        ['previous', 'recovered'],
      );
    } finally {
      unsubscribe();
    }

    // A server cursor that violates request constraints fails before transport.
    let invalidCalls = 0;
    const invalid = create({
      namespace: 'invalid-cursor',
      execute: async () => {
        invalidCalls++;
        return response('x'.repeat(65));
      },
    });
    await assert.rejects(
      client.fetchInfiniteQuery({
        ...invalid.listItems.options({
          context: {},
          input: { path: { collection: 'invalid' } },
        }),
        pages: 2,
      }),
      { name: 'RequestValidationError' },
    );
    assert.equal(invalidCalls, 1);

    // Reading caller fields occurs only while taking the validated base snapshot.
    let reads = 0;
    const structural = create({
      namespace: 'structural',
      execute: async () => response(null),
    });
    const input = Object.create({
      path: {
        get collection() {
          reads++;
          return 'inherited';
        },
      },
    }) as { path: { collection: string } };
    const inherited = structural.listItems.options({ context: {}, input });
    assert.equal(reads, 1);

    let manualCalls = 0;
    const manual = create({
      namespace: 'manual-evidence',
      execute: async () => {
        manualCalls++;
        return response(null);
      },
    });
    const manualOptions = manual.listItems.options({
      context: {},
      input: { path: { collection: 'manual' } },
    });
    const execution = {
      client,
      signal: new AbortController().signal,
      meta: undefined,
      queryKey: manualOptions.queryKey,
      direction: 'forward',
    };
    for (const pageParam of [undefined, 0, false, {}, [], Symbol('cursor')])
      await assert.rejects(
        runtimeInput(manualOptions.queryFn, { ...execution, pageParam }),
        { name: 'TypeError' },
      );
    for (const pageParam of ['\ud800', 'x'.repeat(65)])
      await assert.rejects(
        runtimeInput(manualOptions.queryFn, { ...execution, pageParam }),
        { name: 'RequestValidationError' },
      );
    await assert.rejects(
      runtimeInput(manualOptions.queryFn, {
        ...execution,
        direction: 'backward',
        pageParam: null,
      }),
      /backward pagination/,
    );
    await assert.rejects(
      client.fetchInfiniteQuery({
        ...manualOptions,
        queryKey: manual.listItems.key({
          context: { session: 'other' },
          input: { path: { collection: 'manual' } },
        }),
      }),
      /does not match/,
    );
    assert.equal(manualCalls, 0);

    const parsing = new AbortController();
    const parsingReason = new Error(
      'Cancelled while reading response evidence',
    );
    const reentrant = create({
      namespace: 'reentrant-cancel',
      execute: async () => ({
        ...response(null),
        get status() {
          parsing.abort(parsingReason);
          return 200;
        },
      }),
    });
    const reentrantOptions = reentrant.listItems.options({
      context: {},
      input: { path: { collection: 'reentrant' } },
    });
    await assert.rejects(
      reentrantOptions.queryFn({
        client,
        queryKey: reentrantOptions.queryKey,
        signal: parsing.signal,
        meta: undefined,
        direction: 'forward',
        pageParam: null,
      }),
      (error) => error === parsingReason,
    );
    await client.fetchInfiniteQuery(inherited);
    assert.equal(reads, 1);

    // Cancellation must dominate late successful or rejected page executions.
    for (const completion of ['resolve', 'reject'] as const) {
      let release!: (value: Observed) => void;
      let reject!: (reason: Error) => void;
      const late = new Promise<Observed>((yes, no) => {
        release = yes;
        reject = no;
      });
      let cancelled: AbortSignal | undefined;
      const delayed = create({
        namespace: `cancel-${completion}`,
        execute: async (_request, { signal }) => {
          cancelled = signal;
          return late;
        },
      });
      const delayedOptions = delayed.listItems.options({
        context: { session: 'old' },
        input: { path: { collection: 'cancel' } },
      });
      const pending = client
        .fetchInfiniteQuery(delayedOptions)
        .catch((error: unknown) => error);
      await client.cancelQueries({
        queryKey: delayedOptions.queryKey,
        exact: true,
      });
      assert.equal(cancelled?.aborted, true);
      if (completion === 'resolve') release(response(null));
      else reject(new Error('late failure'));
      await pending;
      await late.catch(() => {});
      await setImmediate();
      assert.equal(client.getQueryData(delayedOptions.queryKey), undefined);
    }
  } finally {
    client.clear();
    restored.clear();
  }
}
