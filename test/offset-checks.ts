import assert from 'node:assert/strict';
import {
  InfiniteQueryObserver,
  QueryClient,
  hydrate,
  isCancelledError,
  skipToken,
} from '@tanstack/query-core';
import type {
  InfiniteData,
  InfiniteQueryObserverOptions,
  QueryKey,
} from '@tanstack/query-core';
import { setImmediate } from 'node:timers/promises';
import { runtimeInput } from './assertions.ts';
import { dehydrateJson } from './query-hydration.ts';

type Module = typeof import('./.generated/offset/client.consumer.queries.ts');
type Observed = import('./.generated/offset/runtime.ts').ObservedResponse;
export const offsetArgs = () => ({
  context: { session: 'one' },
  input: { path: { category: 'a/b' } },
});
export const offsetPage = (
  start: number,
  count: number,
  ids: string[],
  size = 2,
  status = 200,
): Observed => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    start,
    size,
    count,
    next: null,
    entries: ids.map((id) => ({
      id,
      attributes: { ['__proto__']: true, constructor: null },
    })),
    ...(status === 206 ? { segment: 'partial' } : {}),
  }),
});
const client = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: 3, gcTime: Infinity } },
  });
const startOf = (url: string) =>
  Number(new URL(url, 'https://synthetic.invalid').searchParams.get('start'));

export const offsetChecks = {
  'optimistic inserts stop offset paging without breaking writes, observers or invalidation':
    async (module) => {
      for (const scoped of [false, true]) {
        let calls = 0;
        const queries = module.createInfiniteQueries({
          namespace: `optimistic-offset-${scoped}`,
          execute: async (request, execution) => {
            calls++;
            const start = startOf(request.url);
            const observed = offsetPage(start, 10, [
              String(start),
              String(start + 1),
            ]);
            return scoped ? execution.validateResponse(observed) : observed;
          },
        });
        async function check<Data, Key extends QueryKey>(
          prepared: InfiniteQueryObserverOptions<
            Data,
            Error,
            InfiniteData<Data, number>,
            Key,
            number
          >,
          append: (page: Data) => Data,
          count: (page: Data) => number,
        ) {
          const cache = client();
          const options = {
            ...prepared,
            staleTime: Infinity,
            gcTime: Infinity,
          };
          const queryKey: QueryKey = options.queryKey;
          const initial = await cache.fetchInfiniteQuery(options);
          const observer = new InfiniteQueryObserver(cache, options);
          const unsubscribe = observer.subscribe(() => {});
          try {
            const first = initial.pages[0]!;
            const optimistic = { ...initial, pages: [append(first)] };
            assert.doesNotThrow(() => cache.setQueryData(queryKey, optimistic));
            assert.equal(
              count(first),
              2,
              'the optimistic update must be immutable',
            );
            assert.equal(observer.getCurrentResult().hasNextPage, false);
            const before = calls;
            await observer.fetchNextPage({ throwOnError: true });
            assert.equal(
              calls,
              before,
              'inconsistent cached metadata must not dispatch',
            );
            assert.equal(cache.getQueryState(queryKey)?.fetchStatus, 'idle');
            assert.equal(
              count(
                cache.getQueryData<InfiniteData<Data, number>>(queryKey)!
                  .pages[0]!,
              ),
              3,
            );
            await cache.invalidateQueries({ queryKey, exact: true });
            assert.equal(observer.getCurrentResult().hasNextPage, true);
            assert.equal(
              count(
                cache.getQueryData<InfiniteData<Data, number>>(queryKey)!
                  .pages[0]!,
              ),
              2,
            );
            await observer.fetchNextPage({ throwOnError: true });
            assert.deepEqual(
              cache.getQueryData<InfiniteData<Data, number>>(queryKey)!
                .pageParams,
              [0, 2],
            );
            assert.equal(cache.getQueryState(queryKey)?.fetchStatus, 'idle');
          } finally {
            unsubscribe();
            cache.clear();
          }
        }
        await check(
          queries.listRecords.options(offsetArgs()),
          (page) => {
            assert.ok(page.status === 200);
            return {
              ...page,
              data: {
                ...page.data,
                entries: [...page.data.entries, { id: 'local' }],
              },
            };
          },
          (page) => page.data.entries.length,
        );
        await check(
          queries.listRecords.body().options(offsetArgs()),
          (page) => ({ ...page, entries: [...page.entries, { id: 'local' }] }),
          (page) => page.entries.length,
        );
      }
    },

  'offset pages start at zero, advance by actual item count and preserve snapshots and statuses':
    async (module) => {
      const cache = client();
      const seen: string[] = [];
      const queries = module.createInfiniteQueries({
        namespace: 'offset-pages',
        execute: async (request, { context }) => {
          assert.deepEqual({ ...context }, { session: 'one' });
          assert.equal(Object.isFrozen(context), true);
          request.validateHeaders({ 'X-Language': 'en' });
          seen.push(request.url);
          const start = startOf(request.url);
          return start === 0
            ? offsetPage(0, 5, ['same', 'same'])
            : start === 2
              ? offsetPage(2, 5, ['middle'], 2, 206)
              : offsetPage(3, 5, ['last', 'last']);
        },
      });
      const args = {
        ...offsetArgs(),
        input: { path: { category: 'a/b' }, query: { labels: ['original'] } },
      };
      const options = queries.listRecords.options(args);
      args.input.path.category = 'changed';
      args.input.query.labels.push('changed');
      args.context.session = 'changed';
      try {
        const data = await cache.fetchInfiniteQuery({ ...options, pages: 20 });
        assert.equal(options.initialPageParam, 0);
        assert.deepEqual(data.pageParams, [0, 2, 3]);
        assert.deepEqual(
          data.pages.map((page) => page.status),
          [200, 206, 200],
        );
        assert.deepEqual(
          queries.listRecords.items(data).map((item) => item.id),
          ['same', 'same', 'middle', 'last', 'last'],
        );
        for (const url of seen) {
          const parsed = new URL(url, 'https://synthetic.invalid');
          assert.equal(parsed.pathname, '/records/a%2Fb');
          assert.deepEqual(parsed.searchParams.getAll('labels'), ['original']);
          assert.equal(
            parsed.searchParams.has('size'),
            false,
            'default annotations do not populate base input',
          );
        }
        assert.equal(
          Object.hasOwn(
            queries.listRecords.items(data)[0]!.attributes!,
            '__proto__',
          ),
          true,
        );
      } finally {
        cache.clear();
      }
    },

  'offset termination handles empty and shrinking totals without another request':
    async (module) => {
      for (const response of [
        offsetPage(0, 0, []),
        offsetPage(0, 50, []),
        offsetPage(0, 1, ['one']),
        offsetPage(0, 0, ['stale-total']),
      ]) {
        const cache = client();
        let calls = 0;
        const queries = module.createInfiniteQueries({
          namespace: 'termination',
          execute: async () => {
            calls++;
            return response;
          },
        });
        try {
          const data = await cache.fetchInfiniteQuery({
            ...queries.listRecords.options(offsetArgs()),
            pages: 20,
          });
          assert.equal(data.pages.length, 1);
          assert.equal(calls, 1);
        } finally {
          cache.clear();
        }
      }
    },

  'invalid offset metadata is a scoped protocol error and never becomes cached success':
    async (module) => {
      for (const patch of [
        { start: -1 },
        { start: 1 },
        { size: 0 },
        { size: -1 },
        { count: -1 },
        { count: Number.MAX_SAFE_INTEGER + 1 },
        { size: Number.MAX_SAFE_INTEGER + 1 },
        { size: 1 },
        { size: '2' },
        { count: null },
      ]) {
        const cache = client();
        const queries = module.createInfiniteQueries({
          namespace: 'bad-metadata',
          execute: async () => {
            const page = offsetPage(0, 4, ['one', 'two']);
            return {
              ...page,
              body: JSON.stringify({
                ...(JSON.parse(page.body) as object),
                ...patch,
              }),
            };
          },
        });
        const options = queries.listRecords.options(offsetArgs());
        try {
          await assert.rejects(cache.fetchInfiniteQuery(options), (error) => {
            assert.ok(queries.listRecords.isError(error));
            assert.equal(error.result.kind, 'protocol');
            assert.equal(error.result.status, 200);
            assert.equal(Object.hasOwn(error.result, 'data'), false);
            assert.ok(
              error.result.kind === 'protocol' &&
                error.result.issues.some(
                  (issue) => issue.part === 'body' && issue.path?.length,
                ),
            );
            return true;
          });
          assert.equal(cache.getQueryData(options.queryKey), undefined);
        } finally {
          cache.clear();
        }
      }
    },

  'numeric page parameters reject invalid values and still enforce request constraints':
    async (module) => {
      const cache = client();
      let calls = 0;
      const queries = module.createInfiniteQueries({
        namespace: 'bad-offset',
        execute: async (request) => {
          calls++;
          return offsetPage(startOf(request.url), 0, []);
        },
      });
      const options = queries.listRecords.options(offsetArgs());
      const execution = {
        client: cache,
        queryKey: options.queryKey,
        signal: new AbortController().signal,
        meta: undefined,
        direction: 'forward',
      };
      try {
        for (const pageParam of [
          undefined,
          null,
          '',
          '0',
          false,
          -1,
          0.5,
          NaN,
          Infinity,
          Number.MAX_SAFE_INTEGER + 1,
          {},
          Symbol('offset'),
        ])
          await assert.rejects(
            runtimeInput(options.queryFn, { ...execution, pageParam }),
            { name: 'TypeError' },
          );
        assert.equal(calls, 0);
        await assert.rejects(
          runtimeInput(options.queryFn, {
            ...execution,
            pageParam: 0,
            direction: 'backward',
          }),
          /backward pagination/,
        );
        await assert.rejects(
          cache.fetchInfiniteQuery({
            ...options,
            queryKey: queries.listRecords.key({
              ...offsetArgs(),
              context: { session: 'other' },
            }),
          }),
          /does not match/,
        );
        assert.equal(calls, 0);
        await runtimeInput(options.queryFn, { ...execution, pageParam: -0 });
        assert.equal(calls, 1);
        assert.throws(
          () =>
            runtimeInput(queries.listRecords.options, {
              ...offsetArgs(),
              input: { path: { category: 'ok' }, query: { start: 0 } },
            }),
          { name: 'RequestValidationError' },
        );
        assert.throws(
          () =>
            queries.listRecords.options({
              ...offsetArgs(),
              input: { path: { category: 'ok' }, query: { size: 0 } },
            }),
          { name: 'RequestValidationError' },
        );
        assert.equal(calls, 1);
      } finally {
        cache.clear();
      }
    },

  'failed later offset pages retain previous success and recover without extra retries':
    async (module) => {
      const cache = client();
      let response = offsetPage(0, 4, ['first', 'second']);
      let calls = 0;
      const config = {
        namespace: 'offset-failure',
        execute: async () => {
          calls++;
          return response;
        },
      };
      const queries = module.createInfiniteQueries(config);
      const ordinary = module.createQueries(config);
      const options = queries.listRecords.options(offsetArgs());
      const observer = new InfiniteQueryObserver(cache, {
        ...options,
        enabled: false,
      });
      const unsubscribe = observer.subscribe(() => {});
      try {
        const previous = await cache.fetchInfiniteQuery(options);
        for (const failed of [
          offsetPage(0, 4, ['repeated']),
          { ...offsetPage(2, 4, ['bad']), body: '{}' },
          {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
            body: '{"detail":"Missing"}',
          },
          {
            status: 206,
            headers: { 'Content-Type': 'application/json' },
            body: offsetPage(2, 4, ['wrong-status']).body,
          },
        ]) {
          response = failed;
          const result = await observer.fetchNextPage();
          assert.ok(queries.listRecords.isError(result.error));
          assert.ok(ordinary.listRecords.isError(result.error));
          assert.equal(cache.getQueryData(options.queryKey), previous);
        }
        assert.equal(calls, 5);
        response = offsetPage(2, 4, ['third', 'fourth']);
        const recovered = await observer.fetchNextPage();
        assert.deepEqual(recovered.data?.pageParams, [0, 2]);
        assert.equal(recovered.hasNextPage, false);
      } finally {
        unsubscribe();
        cache.clear();
      }
    },

  'offset eviction, full refetch and JSON hydration preserve retained numeric page identity':
    async (module) => {
      const cache = client();
      const restored = client();
      const seen: number[] = [];
      const queries = module.createInfiniteQueries({
        namespace: 'offset-eviction',
        execute: async (request) => {
          const start = startOf(request.url);
          seen.push(start);
          return offsetPage(start, 8, [String(start), String(start + 1)]);
        },
      });
      const options = {
        ...queries.listRecords.options(offsetArgs()),
        maxPages: 2,
      };
      try {
        await cache.fetchInfiniteQuery({ ...options, pages: 3 });
        const data = cache.getQueryData(options.queryKey)!;
        assert.deepEqual(data.pageParams, [2, 4]);
        hydrate(restored, dehydrateJson(cache));
        seen.length = 0;
        await restored.fetchInfiniteQuery({ ...options, staleTime: Infinity });
        assert.deepEqual(seen, []);
        await restored.fetchInfiniteQuery(options);
        assert.deepEqual(seen, [2, 4]);
        const observer = new InfiniteQueryObserver(restored, {
          ...options,
          enabled: false,
        });
        const unsubscribe = observer.subscribe(() => {});
        try {
          const next = await observer.fetchNextPage();
          assert.deepEqual(next.data?.pageParams, [4, 6]);
          assert.equal(next.hasNextPage, false);
        } finally {
          unsubscribe();
        }
        assert.equal(
          restored
            .getQueryCache()
            .findAll(
              queries.listRecords.filter({ context: { session: 'one' } }),
            ).length,
          1,
        );
        assert.equal(
          restored.getQueryCache().findAll(
            queries.listRecords.filter({
              context: { session: 'one', extra: true },
            }),
          ).length,
          0,
        );
      } finally {
        cache.clear();
        restored.clear();
      }
    },

  'skipped offset inputs remain inert and cancellation rejects late page evidence':
    async (module) => {
      const cache = client();
      let release!: (page: Observed) => void;
      const late = new Promise<Observed>((resolve) => {
        release = resolve;
      });
      let signal: AbortSignal | undefined;
      let calls = 0;
      const queries = module.createInfiniteQueries({
        namespace: 'offset-cancel',
        execute: async (_request, execution) => {
          calls++;
          signal = execution.signal;
          return late;
        },
      });
      const skipped = queries.listRecords.options({
        context: {},
        input: skipToken,
      });
      assert.equal(skipped.queryFn, skipToken);
      assert.equal(skipped.initialPageParam, 0);
      assert.throws(
        () =>
          runtimeInput(queries.listRecords.key, {
            context: {},
            input: skipToken,
          }),
        /real input/,
      );
      assert.throws(
        () => runtimeInput(queries.listRecords.options, { input: skipToken }),
        /context/,
      );
      const options = queries.listRecords.options(offsetArgs());
      try {
        const pending = cache
          .fetchInfiniteQuery(options)
          .catch((error: unknown) => error);
        await cache.cancelQueries({ queryKey: options.queryKey, exact: true });
        assert.equal(signal?.aborted, true);
        assert.ok(isCancelledError(await pending));
        release(offsetPage(0, 1, ['late']));
        await late;
        await setImmediate();
        assert.equal(cache.getQueryData(options.queryKey), undefined);
        assert.equal(calls, 1);
      } finally {
        release(offsetPage(0, 0, []));
        cache.clear();
      }
    },

  'offset response arithmetic rejects overflow before caching or issuing another page':
    async (module) => {
      const cache = client();
      const queries = module.createInfiniteQueries({
        namespace: 'offset-overflow',
        execute: async () =>
          offsetPage(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, [
            'overflow',
          ]),
      });
      const options = queries.listRecords.options(offsetArgs());
      try {
        await assert.rejects(
          options.queryFn({
            client: cache,
            queryKey: options.queryKey,
            signal: new AbortController().signal,
            meta: undefined,
            direction: 'forward',
            pageParam: Number.MAX_SAFE_INTEGER,
          }),
          (error) => {
            assert.ok(queries.listRecords.isError(error));
            assert.equal(error.result.kind, 'protocol');
            assert.ok(
              error.result.kind === 'protocol' &&
                error.result.issues.some((issue) =>
                  issue.message.includes('safe integer range'),
                ),
            );
            return true;
          },
        );
      } finally {
        cache.clear();
      }
    },
} satisfies Readonly<Record<string, (module: Module) => Promise<void>>>;

export async function verifyOffsets(module: Module) {
  for (const check of Object.values(offsetChecks)) await check(module);
}
