import assert from 'node:assert/strict';
import {
  InfiniteQueryObserver,
  QueryClient,
  dehydrate,
  hydrate,
} from '@tanstack/query-core';
import { runtimeInput } from './assertions.ts';

type Module = Pick<
  typeof import('./.generated/infinite/client.consumer.queries.ts'),
  'createQueries' | 'createInfiniteQueries' | 'QueryResponseError'
>;

const args = {
  context: { tenant: 'one' },
  input: { path: { collection: 'widgets' } },
};
const page = (continuation: string | null, ids: string[]) => ({
  status: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    results: ids.map((id) => ({ id, label: id })),
    continuation,
  }),
});
const cursorOf = (url: string) =>
  new URL(url, 'https://synthetic.invalid').searchParams.get('after');
const queryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: 3 } },
  });

export const infiniteLifecycleChecks = {
  'ordinary and infinite factories reject invalid execution bindings': async ({
    createQueries,
    createInfiniteQueries,
  }) => {
    for (const create of [createQueries, createInfiniteQueries]) {
      for (const namespace of ['', null, 7])
        assert.throws(
          () =>
            runtimeInput(create, {
              namespace,
              execute: async () => page(null, []),
            }),
          { name: 'TypeError', message: /namespace/ },
        );
      for (const execute of [undefined, null, 'executor'])
        assert.throws(
          () => runtimeInput(create, { namespace: 'valid', execute }),
          { name: 'TypeError', message: /executor/ },
        );
    }
  },

  'cancellation during key inspection prevents ordinary and infinite execution':
    async ({ createQueries, createInfiniteQueries }) => {
      const client = queryClient();
      let calls = 0;
      const config = {
        namespace: 'cancel-during-key',
        execute: async () => {
          calls++;
          return page(null, ['item']);
        },
      };
      const options = [
        createQueries(config).listItems.options(args),
        createInfiniteQueries(config).listItems.options(args),
      ];
      try {
        for (const option of options) {
          const controller = new AbortController();
          const reason = new Error('Cancelled while inspecting the query key');
          const key = [...option.queryKey];
          Object.defineProperty(key, 1, {
            enumerable: true,
            get() {
              controller.abort(reason);
              return config.namespace;
            },
          });
          await assert.rejects(
            runtimeInput(option.queryFn, {
              client,
              queryKey: key,
              signal: controller.signal,
              meta: undefined,
              direction: 'forward',
              pageParam: null,
            }),
            (error) => error === reason,
          );
          assert.equal(calls, 0);
        }
      } finally {
        client.clear();
      }
    },

  'transport headers stay executor-owned across initial and later pages':
    async ({ createInfiniteQueries }) => {
      const client = queryClient();
      const seen: {
        cursor: string | null;
        headers: Record<string, string>;
      }[] = [];
      const queries = createInfiniteQueries({
        namespace: 'transport-headers',
        execute: async (request, { context }) => {
          assert.equal(Object.hasOwn(request.headers, 'X-Language'), false);
          assert.throws(() => request.validateHeaders(request.headers), {
            name: 'RequestValidationError',
          });
          assert.throws(
            () =>
              request.validateHeaders({
                ...request.headers,
                'X-Language': 'de',
              }),
            { name: 'RequestValidationError' },
          );
          const headers = request.validateHeaders({
            ...request.headers,
            'x-LaNgUaGe': String(context['locale']),
          });
          const cursor = cursorOf(request.url);
          seen.push({ cursor, headers: { ...headers } });
          return page(cursor === null ? 'next' : null, ['item']);
        },
      });
      const input = {
        context: { locale: 'en' },
        input: {
          path: { collection: 'widgets' },
          headers: { 'X-View': 'compact' },
        },
      };
      try {
        const options = queries.listItems.options(input);
        assert.notDeepEqual(
          options.queryKey,
          queries.listItems.key({ ...input, context: { locale: 'fr' } }),
        );
        for (const name of ['X-Language', 'x-language'])
          assert.throws(
            () =>
              runtimeInput(queries.listItems.options, {
                ...input,
                input: {
                  ...input.input,
                  headers: { ...input.input.headers, [name]: 'en' },
                },
              }),
            { name: 'RequestValidationError' },
          );
        input.context.locale = 'fr';
        input.input.headers['X-View'] = 'wide';
        const data = await client.fetchInfiniteQuery({ ...options, pages: 2 });
        assert.deepEqual(data.pageParams, [null, 'next']);
        assert.deepEqual(seen, [
          {
            cursor: null,
            headers: { 'x-view': 'compact', 'x-language': 'en' },
          },
          {
            cursor: 'next',
            headers: { 'x-view': 'compact', 'x-language': 'en' },
          },
        ]);
      } finally {
        client.clear();
      }
    },

  'empty pages and literal cursors continue until an explicit terminal cursor':
    async ({ createInfiniteQueries }) => {
      const client = queryClient();
      const seen: (string | null)[] = [];
      const queries = createInfiniteQueries({
        namespace: 'empty-pages',
        execute: async (request) => {
          const cursor = cursorOf(request.url);
          seen.push(cursor);
          if (cursor === null) return page('', []);
          if (cursor === '') return page('null', []);
          if (cursor === 'null') return page('undefined', ['middle']);
          return page(null, []);
        },
      });
      try {
        const data = await client.fetchInfiniteQuery({
          ...queries.listItems.options(args),
          pages: 10,
        });
        assert.deepEqual(seen, [null, '', 'null', 'undefined']);
        assert.deepEqual(data.pageParams, seen);
        assert.deepEqual(
          data.pages.map((result) => result.data.results.length),
          [0, 0, 1, 0],
        );
        assert.deepEqual(
          queries.listItems.items(data).map((item) => item.id),
          ['middle'],
        );
      } finally {
        client.clear();
      }
    },

  'whole-list refetches follow fresh cursors and publish only complete validated collections':
    async ({ createInfiniteQueries, QueryResponseError }) => {
      const client = queryClient();
      const seen: (string | null)[] = [];
      let phase: 'initial' | 'changed' | 'failed' | 'shortened' = 'initial';
      const queries = createInfiniteQueries({
        namespace: 'whole-refetch',
        execute: async (request) => {
          const cursor = cursorOf(request.url);
          seen.push(cursor);
          if (phase === 'shortened') return page(null, ['shortened']);
          if (cursor === null)
            return page(phase === 'initial' ? 'old' : 'new', [
              `${phase}-first`,
            ]);
          if (phase === 'failed')
            return {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
              body: '{"detail":"Failed second page"}',
            };
          return page(null, [`${phase}-last`]);
        },
      });
      const options = queries.listItems.options(args);
      try {
        await client.fetchInfiniteQuery({ ...options, pages: 2 });
        assert.deepEqual(seen, [null, 'old']);
        seen.length = 0;
        phase = 'changed';
        const changed = await client.fetchInfiniteQuery(options);
        assert.deepEqual(seen, [null, 'new']);
        assert.deepEqual(changed.pageParams, [null, 'new']);
        assert.deepEqual(
          queries.listItems.items(changed).map((item) => item.id),
          ['changed-first', 'changed-last'],
        );
        seen.length = 0;
        phase = 'failed';
        await assert.rejects(
          client.fetchInfiniteQuery(options),
          (error: unknown) => {
            assert.ok(error instanceof QueryResponseError);
            assert.equal(error.result.kind, 'error');
            assert.equal(error.result.status, 404);
            return true;
          },
        );
        assert.deepEqual(seen, [null, 'new']);
        assert.equal(client.getQueryData(options.queryKey), changed);
        assert.deepEqual(
          queries.listItems.items(changed).map((item) => item.id),
          ['changed-first', 'changed-last'],
        );
        phase = 'shortened';
        seen.length = 0;
        const shortened = await client.fetchInfiniteQuery(options);
        assert.deepEqual(seen, [null]);
        assert.deepEqual(shortened.pageParams, [null]);
        assert.deepEqual(
          queries.listItems.items(shortened).map((item) => item.id),
          ['shortened'],
        );
      } finally {
        client.clear();
      }
    },

  'page eviction and JSON hydration preserve the retained cursor chain':
    async ({ createInfiniteQueries }) => {
      const client = queryClient();
      const restored = queryClient();
      const seen: (string | null)[] = [];
      const queries = createInfiniteQueries({
        namespace: 'evicted-pages',
        execute: async (request) => {
          const cursor = cursorOf(request.url);
          seen.push(cursor);
          const next =
            cursor === null
              ? 'a'
              : cursor === 'a'
                ? 'b'
                : cursor === 'b'
                  ? 'c'
                  : null;
          return page(next, [cursor ?? 'initial']);
        },
      });
      const options = { ...queries.listItems.options(args), maxPages: 2 };
      try {
        const original = await client.fetchInfiniteQuery({
          ...options,
          pages: 10,
        });
        assert.deepEqual(original.pageParams, ['b', 'c']);
        assert.deepEqual(
          queries.listItems.items(original).map((item) => item.id),
          ['b', 'c'],
        );
        hydrate(
          restored,
          JSON.parse(JSON.stringify(dehydrate(client))) as unknown,
        );
        seen.length = 0;
        const fresh = await restored.fetchInfiniteQuery({
          ...options,
          staleTime: Infinity,
        });
        assert.deepEqual(seen, []);
        assert.deepEqual(fresh.pageParams, ['b', 'c']);
        const refetched = await restored.fetchInfiniteQuery(options);
        assert.deepEqual(seen, ['b', 'c']);
        assert.deepEqual(refetched.pageParams, ['b', 'c']);
        assert.deepEqual(
          queries.listItems.items(refetched).map((item) => item.id),
          ['b', 'c'],
        );
      } finally {
        client.clear();
        restored.clear();
      }
    },

  'concurrent next-page calls can share one pending execution': async ({
    createInfiniteQueries,
  }) => {
    const client = queryClient();
    let release!: (value: ReturnType<typeof page>) => void;
    const delayed = new Promise<ReturnType<typeof page>>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let signal: AbortSignal | undefined;
    const queries = createInfiniteQueries({
      namespace: 'concurrent-pages',
      execute: async (_request, execution) => {
        calls++;
        if (calls === 1) return page('next', ['first']);
        signal = execution.signal;
        return delayed;
      },
    });
    const options = queries.listItems.options(args);
    const observer = new InfiniteQueryObserver(client, {
      ...options,
      enabled: false,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await client.fetchInfiniteQuery(options);
      const first = observer.fetchNextPage({ cancelRefetch: false });
      const second = observer.fetchNextPage({ cancelRefetch: false });
      assert.equal(calls, 2);
      assert.equal(signal?.aborted, false);
      release(page(null, ['second']));
      const results = await Promise.all([first, second]);
      for (const result of results) {
        assert.equal(result.status, 'success');
        assert.deepEqual(result.data?.pageParams, [null, 'next']);
      }
      assert.equal(calls, 2);
      assert.deepEqual(
        queries.listItems
          .items(client.getQueryData(options.queryKey))
          .map((item) => item.id),
        ['first', 'second'],
      );
    } finally {
      release(page(null, []));
      unsubscribe();
      client.clear();
    }
  },

  'infinite invalidation isolates ordinary caches and complete canonical contexts':
    async ({ createQueries, createInfiniteQueries }) => {
      const client = queryClient();
      const restored = queryClient();
      const execute = async () => page(null, ['item']);
      const infinite = createInfiniteQueries({
        namespace: 'filter-family',
        execute,
      });
      const ordinary = createQueries({ namespace: 'filter-family', execute });
      const elsewhere = createInfiniteQueries({
        namespace: 'other-api',
        execute,
      });
      const variant = { ...args, input: { path: { collection: 'other' } } };
      const extraContext = {
        ...args,
        context: { ...args.context, zone: 'extra' },
      };
      const keys = [
        infinite.listItems.key(args),
        infinite.listItems.key(variant),
        infinite.listItems.key(extraContext),
      ];
      const ordinaryKey = ordinary.listItems.key(args);
      const elsewhereKey = elsewhere.listItems.key(args);
      try {
        for (const input of [args, variant, extraContext])
          await client.fetchInfiniteQuery(infinite.listItems.options(input));
        await client.fetchQuery(ordinary.listItems.options(args));
        await client.fetchInfiniteQuery(elsewhere.listItems.options(args));
        hydrate(
          restored,
          JSON.parse(JSON.stringify(dehydrate(client))) as unknown,
        );
        for (const cache of [client, restored]) {
          const filter = infinite.listItems.filter({
            context: { ...args.context },
          });
          assert.equal(cache.getQueryCache().findAll(filter).length, 2);
          await cache.invalidateQueries({ ...filter, refetchType: 'none' });
          assert.deepEqual(
            keys.map((key) => cache.getQueryState(key)?.isInvalidated),
            [true, true, false],
          );
          assert.equal(cache.getQueryState(ordinaryKey)?.isInvalidated, false);
          assert.equal(cache.getQueryState(elsewhereKey)?.isInvalidated, false);
          const all = infinite.listItems.filter({ allContexts: true });
          assert.equal(cache.getQueryCache().findAll(all).length, 3);
          await cache.invalidateQueries({ ...all, refetchType: 'none' });
          assert.deepEqual(
            keys.map((key) => cache.getQueryState(key)?.isInvalidated),
            [true, true, true],
          );
          assert.equal(cache.getQueryState(ordinaryKey)?.isInvalidated, false);
          assert.equal(cache.getQueryState(elsewhereKey)?.isInvalidated, false);
        }
      } finally {
        client.clear();
        restored.clear();
      }
    },
} satisfies Readonly<Record<string, (module: Module) => Promise<void>>>;

export async function verifyInfiniteLifecycle(module: Module) {
  for (const check of Object.values(infiniteLifecycleChecks))
    await check(module);
}
