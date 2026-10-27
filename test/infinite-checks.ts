import assert from 'node:assert/strict';
import {
  QueryClient,
  InfiniteQueryObserver,
  hydrate,
  skipToken,
} from '@tanstack/query-core';
import { setImmediate } from 'node:timers/promises';
import { runtimeInput } from './assertions.ts';
import { dehydrateJson } from './query-hydration.ts';

type Module = Pick<
  typeof import('./.generated/infinite/client.consumer.queries.ts'),
  'createInfiniteQueries' | 'QueryResponseError'
>;
type Observed = import('./.generated/infinite/runtime.ts').ObservedResponse;

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
const queryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: 3, gcTime: Infinity } },
  });

export const infiniteChecks = {
  'pages preserve input snapshots, encoded cursors, exact statuses and ordered items':
    async ({ createInfiniteQueries }) => {
      const client = queryClient();
      const urls: string[] = [];
      const cursors = ['', 'a/b?&🔥', null];
      const queries = createInfiniteQueries({
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
        assert.deepEqual(
          data.pages.map((page) => page.status),
          [200, 206, 200],
        );
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
        const many = Array.from(
          { length: 150_000 },
          () => first.data.results[0]!,
        );
        assert.equal(
          queries.listItems.items({
            pages: [{ ...first, data: { ...first.data, results: many } }],
            pageParams: [null],
          }).length,
          many.length,
        );
        assert.equal(
          Object.hasOwn(
            queries.listItems.items(data)[0]!.attributes!,
            '__proto__',
          ),
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
      } finally {
        client.clear();
      }
    },

  'skipped infinite options retain distinct immutable cache identities':
    async ({ createInfiniteQueries }) => {
      const queries = createInfiniteQueries({
        namespace: 'skip',
        execute: async () => response(null),
      });
      const options = queries.listItems.options({
        context: { session: 'one' },
        input: { path: { collection: 'widgets' } },
      });
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
          input: { path: { collection: 'widgets' } },
        }),
        options.queryKey,
      );
    },

  'fetch, ensure, prefetch and hydrated filters preserve complete page collections':
    async ({ createInfiniteQueries }) => {
      const client = queryClient();
      const restored = queryClient();
      let calls = 0;
      const queries = createInfiniteQueries({
        namespace: 'hydrated-pages',
        execute: async () => {
          calls++;
          return response(calls === 1 ? 'next' : null);
        },
      });
      const options = queries.listItems.options({
        context: { session: 'original', variant: -0 },
        input: { path: { collection: 'widgets' } },
      });
      try {
        const data = await client.fetchInfiniteQuery({ ...options, pages: 2 });
        hydrate(restored, dehydrateJson(client));
        const hydrated = await restored.fetchInfiniteQuery({
          ...options,
          staleTime: Infinity,
        });
        // JSON hydration replaces the parser's null-prototype header dictionaries.
        assert.deepEqual(hydrated, JSON.parse(JSON.stringify(data)) as unknown);
        assert.equal(calls, 2);
        assert.equal(await client.ensureInfiniteQueryData(options), data);
        assert.equal(calls, 2);
        const prefetch = createInfiniteQueries({
          namespace: 'prefetch',
          execute: async () => response(null, 'prefetched'),
        });
        const prefetchOptions = prefetch.listItems.options({
          context: {},
          input: { path: { collection: 'prefetch' } },
        });
        await client.prefetchInfiniteQuery(prefetchOptions);
        assert.equal(
          client.getQueryData(prefetchOptions.queryKey)?.pages[0]?.data
            .results[0]?.id,
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
      } finally {
        client.clear();
        restored.clear();
      }
    },

  'retained cursor cycles stop before requesting a repeated page': async ({
    createInfiniteQueries,
  }) => {
    const client = queryClient();
    const urls: string[] = [];
    const queries = createInfiniteQueries({
      namespace: 'cycle',
      execute: async (request) => {
        urls.push(request.url);
        return response(
          urls.length === 1 ? 'a' : urls.length === 2 ? 'b' : 'a',
        );
      },
    });
    try {
      const data = await client.fetchInfiniteQuery({
        ...queries.listItems.options({
          context: {},
          input: { path: { collection: 'cycle' } },
        }),
        pages: 50,
      });
      assert.deepEqual(data.pageParams, [null, 'a', 'b']);
      assert.equal(urls.length, 3);
    } finally {
      client.clear();
    }
  },

  'failed later pages retain the previous collection and can recover': async ({
    createInfiniteQueries,
    QueryResponseError,
  }) => {
    const client = queryClient();
    let observed = response('next', 'previous');
    let calls = 0;
    const queries = createInfiniteQueries({
      namespace: 'failures',
      execute: async () => {
        calls++;
        return observed;
      },
    });
    const options = queries.listItems.options({
      context: {},
      input: { path: { collection: 'fail' } },
    });
    const observer = new InfiniteQueryObserver(client, {
      ...options,
      enabled: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      const previous = await client.fetchInfiniteQuery(options);
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
        assert.equal(client.getQueryData(options.queryKey), previous);
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
      client.clear();
    }
  },

  'invalid response cursors fail before another transport call': async ({
    createInfiniteQueries,
  }) => {
    const client = queryClient();
    let calls = 0;
    const queries = createInfiniteQueries({
      namespace: 'invalid-cursor',
      execute: async () => {
        calls++;
        return response('x'.repeat(65));
      },
    });
    try {
      await assert.rejects(
        client.fetchInfiniteQuery({
          ...queries.listItems.options({
            context: {},
            input: { path: { collection: 'invalid' } },
          }),
          pages: 2,
        }),
        { name: 'RequestValidationError' },
      );
      assert.equal(calls, 1);
    } finally {
      client.clear();
    }
  },

  'inherited base inputs are read only when capturing their validated snapshot':
    async ({ createInfiniteQueries }) => {
      const client = queryClient();
      let reads = 0;
      const queries = createInfiniteQueries({
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
      try {
        const options = queries.listItems.options({ context: {}, input });
        assert.equal(reads, 1);
        await client.fetchInfiniteQuery(options);
        assert.equal(reads, 1);
      } finally {
        client.clear();
      }
    },

  'invalid page execution evidence and key overrides never reach the executor':
    async ({ createInfiniteQueries }) => {
      const client = queryClient();
      let calls = 0;
      const queries = createInfiniteQueries({
        namespace: 'manual-evidence',
        execute: async () => {
          calls++;
          return response(null);
        },
      });
      const options = queries.listItems.options({
        context: {},
        input: { path: { collection: 'manual' } },
      });
      const execution = {
        client,
        signal: new AbortController().signal,
        meta: undefined,
        queryKey: options.queryKey,
        direction: 'forward',
      };
      try {
        for (const pageParam of [undefined, 0, false, {}, [], Symbol('cursor')])
          await assert.rejects(
            runtimeInput(options.queryFn, { ...execution, pageParam }),
            { name: 'TypeError' },
          );
        for (const pageParam of ['\ud800', 'x'.repeat(65)])
          await assert.rejects(
            runtimeInput(options.queryFn, { ...execution, pageParam }),
            { name: 'RequestValidationError' },
          );
        await assert.rejects(
          runtimeInput(options.queryFn, {
            ...execution,
            direction: 'backward',
            pageParam: null,
          }),
          /backward pagination/,
        );
        await assert.rejects(
          client.fetchInfiniteQuery({
            ...options,
            queryKey: queries.listItems.key({
              context: { session: 'other' },
              input: { path: { collection: 'manual' } },
            }),
          }),
          /does not match/,
        );
        assert.equal(calls, 0);
      } finally {
        client.clear();
      }
    },

  'cancellation while reading page response evidence preserves its reason':
    async ({ createInfiniteQueries }) => {
      const client = queryClient();
      const controller = new AbortController();
      const reason = new Error('Cancelled while reading response evidence');
      const queries = createInfiniteQueries({
        namespace: 'reentrant-cancel',
        execute: async () => ({
          ...response(null),
          get status() {
            controller.abort(reason);
            return 200;
          },
        }),
      });
      const options = queries.listItems.options({
        context: {},
        input: { path: { collection: 'reentrant' } },
      });
      try {
        await assert.rejects(
          options.queryFn({
            client,
            queryKey: options.queryKey,
            signal: controller.signal,
            meta: undefined,
            direction: 'forward',
            pageParam: null,
          }),
          (error) => error === reason,
        );
      } finally {
        client.clear();
      }
    },

  'cancelled pages ignore late executor responses and failures': async ({
    createInfiniteQueries,
  }) => {
    const client = queryClient();
    try {
      for (const completion of ['resolve', 'reject'] as const) {
        let release!: (value: Observed) => void;
        let reject!: (reason: Error) => void;
        const late = new Promise<Observed>((yes, no) => {
          release = yes;
          reject = no;
        });
        let cancelled: AbortSignal | undefined;
        const queries = createInfiniteQueries({
          namespace: 'cancel-' + completion,
          execute: async (_request, { signal }) => {
            cancelled = signal;
            return late;
          },
        });
        const options = queries.listItems.options({
          context: { session: 'old' },
          input: { path: { collection: 'cancel' } },
        });
        const pending = client
          .fetchInfiniteQuery(options)
          .catch((error: unknown) => error);
        await client.cancelQueries({
          queryKey: options.queryKey,
          exact: true,
        });
        assert.equal(cancelled?.aborted, true);
        if (completion === 'resolve') release(response(null));
        else reject(new Error('late failure'));
        await pending;
        await late.catch(() => {});
        await setImmediate();
        assert.equal(client.getQueryData(options.queryKey), undefined);
      }
    } finally {
      client.clear();
    }
  },
} satisfies Readonly<Record<string, (module: Module) => Promise<void>>>;

export async function verifyInfiniteQueries(
  createInfiniteQueries: Module['createInfiniteQueries'],
  QueryResponseError: Module['QueryResponseError'],
) {
  for (const check of Object.values(infiniteChecks))
    await check({ createInfiniteQueries, QueryResponseError });
}
