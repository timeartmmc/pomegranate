import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  QueryClient,
  QueryClientProvider,
  skipToken,
  useQuery,
  useInfiniteQuery,
} from '@tanstack/react-query';
import type { QueryKey, UseQueryOptions } from '@tanstack/react-query';
import {
  createQueries,
  QueryResponseError,
} from './.generated/queries/client.consumer.queries.ts';
import { createQueries as createStaffQueries } from './.generated/queries/client.staff.queries.ts';
import { createInfiniteQueries } from './.generated/infinite/client.consumer.queries.ts';
import type {
  CacheContext,
  QueryExecutor,
} from './.generated/queries/client.consumer.queries.ts';
import type { ObservedResponse } from './.generated/queries/runtime.ts';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, message: string): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
  );
}

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, staleTime: Infinity, retry: 3 },
    },
  });
}

function item(label: string, id = 'item'): ObservedResponse {
  return {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, label }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function until(
  condition: () => boolean,
  description: string,
): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!condition()) {
    check(performance.now() < deadline, `Timed out waiting for ${description}`);
    await flush();
  }
}

async function mountQuery<
  TQueryFnData,
  TKey extends QueryKey,
  TData = TQueryFnData,
>(
  client: QueryClient,
  options: () => UseQueryOptions<TQueryFnData, Error, TData, TKey>,
) {
  return mountHook(client, () => useQuery(options()));
}

async function mountHook<Result extends { status: string }>(
  client: QueryClient,
  hook: () => Result,
) {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  let latest: Result | undefined;
  let mounted = true;
  function Probe() {
    latest = hook();
    return createElement('output', null, latest.status);
  }
  async function update() {
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client }, createElement(Probe)),
      );
    });
  }
  await update();
  return {
    get result(): Result {
      check(latest !== undefined, 'The real query hook must render');
      return latest;
    },
    update,
    async unmount() {
      if (!mounted) return;
      mounted = false;
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

async function skip() {
  const client = queryClient();
  let calls = 0;
  const queries = createQueries({
    namespace: 'mounted-skip',
    execute: async (request) => {
      calls += 1;
      return item(`call-${calls}`, request.url);
    },
  });
  const context = { session: 'waiting' };
  let input: { path: { id: string } } | typeof skipToken = skipToken;
  const mounted = await mountQuery(client, () =>
    queries.readItem.options({ context, input }),
  );
  try {
    same(calls, 0, 'Mounting a skipped query must not invoke the executor');
    same(
      mounted.result.status,
      'pending',
      'A skipped hook must remain pending',
    );
    same(mounted.result.fetchStatus, 'idle', 'A skipped hook must remain idle');
    await act(async () =>
      client.invalidateQueries(queries.readItem.filter({ context })),
    );
    same(calls, 0, 'Invalidating a skipped query must not invoke the executor');
    let skippedRefetch!: Awaited<ReturnType<typeof mounted.result.refetch>>;
    await act(async () => {
      skippedRefetch = await mounted.result.refetch();
    });
    check(
      skippedRefetch.isError &&
        /Missing queryFn/.test(skippedRefetch.error.message),
      'Manual skipped refetch must retain TanStack skipToken semantics',
    );
    same(
      calls,
      0,
      'Manually refetching a skipped query must not invoke the executor',
    );

    input = { path: { id: 'now-known' } };
    await mounted.update();
    await until(
      () => mounted.result.isSuccess,
      'skipped to enabled transition',
    );
    check(
      mounted.result.data?.data.id === '/items/now-known',
      'The enabled hook must use the real required input',
    );
    same(calls, 1, 'Enabling a skipped query must execute once');
    await act(async () => {
      await mounted.result.refetch();
    });
    await until(
      () => mounted.result.data?.data.label === 'call-2',
      'enabled manual refetch',
    );
    same(calls, 2, 'An enabled manual refetch must execute');

    input = skipToken;
    await mounted.update();
    check(
      mounted.result.data === undefined,
      'Skipping again must not display the enabled identity data',
    );
    await act(async () =>
      client.invalidateQueries(queries.readItem.filter({ context })),
    );
    await act(async () => {
      await mounted.result.refetch();
    });
    same(
      calls,
      2,
      'A query skipped again must remain inert through invalidation and refetch',
    );
  } finally {
    await mounted.unmount();
    client.clear();
  }
}

async function identity() {
  const client = queryClient();
  const attempts: {
    signal: AbortSignal;
    context: CacheContext;
    url: string;
    completion: ReturnType<typeof deferred<ObservedResponse>>;
  }[] = [];
  const queries = createQueries({
    namespace: 'mounted-identities',
    execute: async (request, execution) => {
      const completion = deferred<ObservedResponse>();
      attempts.push({ ...execution, url: request.url, completion });
      return completion.promise;
    },
  });
  const originalInput = { path: { id: 'first' } };
  const originalContext = { session: 'one' };
  const first = queries.readItem.options({
    context: originalContext,
    input: originalInput,
  });
  let options = first;
  const mounted = await mountQuery(client, () => options);
  try {
    await until(() => attempts.length === 1, 'first identity request');
    const old = attempts[0]!;
    originalInput.path.id = 'caller-mutated';
    originalContext.session = 'caller-mutated';
    check(
      old.url === '/items/first' && old.context['session'] === 'one',
      'Prepared input and executor context must be immutable snapshots',
    );
    check(
      Object.isFrozen(old.context),
      'The mounted executor context must be frozen',
    );

    const second = queries.readItem.options({
      context: { session: 'one' },
      input: { path: { id: 'second' } },
    });
    options = second;
    await mounted.update();
    await until(() => attempts.length === 2, 'changed input request');
    check(
      old.signal.aborted,
      'Changing inputs must cancel the former unobserved request',
    );

    const third = queries.readItem.options({
      context: { session: 'two' },
      input: { path: { id: 'second' } },
    });
    options = third;
    await mounted.update();
    await until(() => attempts.length === 3, 'changed context request');
    check(
      attempts[1]!.signal.aborted,
      'Changing context must cancel the former identity',
    );
    check(
      attempts[2]!.context['session'] === 'two',
      'The new identity must receive its own context',
    );
    await act(async () =>
      attempts[2]!.completion.resolve(item('current', 'second')),
    );
    await until(
      () => mounted.result.data?.data.label === 'current',
      'current identity response',
    );
    const current = mounted.result.data;
    await act(async () => {
      old.completion.resolve(item('late-first', 'first'));
      attempts[1]!.completion.reject(
        new Error('late previous-session rejection'),
      );
    });
    await flush();
    check(
      mounted.result.data === current,
      'Late responses must not overwrite the current hook identity',
    );
    check(
      client.getQueryData(third.queryKey) === current,
      'Late responses must not overwrite the current cache identity',
    );
    check(
      client.getQueryData(first.queryKey) === undefined,
      'A cancelled input identity must not acquire late data',
    );
    check(
      client.getQueryData(second.queryKey) === undefined,
      'A cancelled context identity must not acquire late data',
    );
    check(
      attempts.length === 3,
      'Cancelled executor completions must not create extra attempts',
    );
  } finally {
    await mounted.unmount();
    for (const attempt of attempts) attempt.completion.resolve(item('cleanup'));
    client.clear();
  }
}

async function filters() {
  const client = queryClient();
  const calls: string[] = [];
  const execute =
    (scope: string): QueryExecutor =>
    async (request, { context }) => {
      calls.push(
        `${scope}/${request.operationId}/${request.url}/${JSON.stringify(context)}`,
      );
      return request.operationId === 'health'
        ? { status: 204, headers: {}, body: '' }
        : item(`response-${calls.length}`, request.url);
    };
  const queries = createQueries({
    namespace: 'mounted-filter',
    execute: execute('consumer'),
  });
  const staff = createStaffQueries({
    namespace: 'mounted-filter',
    execute: execute('staff'),
  });
  const other = createQueries({
    namespace: 'different-api',
    execute: execute('other-api'),
  });
  const context = {
    session: 'one',
    variant: -0,
    ['__proto__']: 'literal',
    constructor: null,
  };
  const reordered = {
    constructor: null,
    ['__proto__']: 'literal',
    variant: 0,
    session: 'one',
  };
  const input = { path: { id: 'one' }, query: { page: 1 } };
  const mounts = [
    await mountQuery(client, () =>
      queries.readItem.options({ context, input }),
    ),
    await mountQuery(client, () =>
      queries.readItem.options({
        context: reordered,
        input: { path: { id: 'two' }, query: { page: 2 } },
      }),
    ),
    await mountQuery(client, () =>
      queries.readItem.options({
        context: { ...context, zExtra: 'extra' },
        input,
      }),
    ),
    await mountQuery(client, () =>
      queries.readItem.options({
        context: { ...context, variant: '0' },
        input,
      }),
    ),
    await mountQuery(client, () =>
      queries.readItem.options({
        context: { ...context, variant: false },
        input,
      }),
    ),
    await mountQuery(client, () =>
      queries.readItem.options({
        context: { ...context, session: 'two' },
        input,
      }),
    ),
    await mountQuery(client, () => queries.health.options({ context })),
    await mountQuery(client, () => staff.readItem.options({ context, input })),
    await mountQuery(client, () => other.readItem.options({ context, input })),
  ];
  try {
    await until(
      () => mounts.every((mounted) => mounted.result.isSuccess),
      'mounted invalidation matrix',
    );
    check(
      calls.length === mounts.length,
      'Every distinct mounted identity must execute once',
    );
    const initial = mounts.map((mounted) => mounted.result.data);
    const before = [...calls];
    await act(async () =>
      client.invalidateQueries(queries.readItem.filter({ context: reordered })),
    );
    await until(
      () => mounts.every((mounted) => !mounted.result.isFetching),
      'scoped operation invalidation',
    );
    same(
      calls.slice(before.length).sort(),
      before.slice(0, 2).sort(),
      'Scoped invalidation must refetch all parameter variants and only the complete canonical context',
    );
    for (let index = 0; index < mounts.length; index += 1) {
      if (index < 2)
        check(
          mounts[index]!.result.data !== initial[index],
          'Matching variants must receive refetched envelopes',
        );
      else
        check(
          mounts[index]!.result.data === initial[index],
          'Unrelated operation, client, namespace or context must retain its data',
        );
    }
    const scopedCount = calls.length;
    await act(async () =>
      client.invalidateQueries(queries.readItem.filter({ allContexts: true })),
    );
    same(
      calls.slice(scopedCount).sort(),
      before.slice(0, 6).sort(),
      'Explicit allContexts invalidation must cross contexts within the same namespace/client/operation',
    );
    for (let index = 6; index < mounts.length; index += 1)
      check(
        mounts[index]!.result.data === initial[index],
        'All-context invalidation must still isolate operations, clients and namespaces',
      );
  } finally {
    for (const mounted of mounts) await mounted.unmount();
    client.clear();
  }
}

async function failures() {
  const client = queryClient();
  let calls = 0;
  const transport = new Error('Synthetic executor exhausted its own attempts');
  let observed: ObservedResponse | Error = {
    status: 202,
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'pending' },
    body: '{"state":"pending","reference":"known"}',
  };
  const queries = createQueries({
    namespace: 'mounted-failures',
    execute: async () => {
      calls += 1;
      if (observed instanceof Error) throw observed;
      return observed;
    },
  });
  const options = queries.readOutcome.options({ context: {} });
  const mounted = await mountQuery(client, () => options);
  try {
    await until(
      () => mounted.result.isSuccess,
      'initial exact-status response',
    );
    const previous = mounted.result.data;
    check(
      previous?.status === 202 && previous.data.reference === 'known',
      'The hook must receive the declared 202 envelope',
    );
    const scenarios = [
      {
        status: 202,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': 'wrong-body',
        },
        body: '{"state":"ready","value":1}',
      },
      {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
        body: '{"detail":"declared failure"}',
      },
      transport,
    ] as const;
    for (const [index, failure] of scenarios.entries()) {
      observed = failure;
      await act(async () => {
        await mounted.result.refetch();
      });
      await until(() => mounted.result.isError, 'failed mounted refetch');
      const error = mounted.result.error;
      check(
        mounted.result.data === previous,
        'A failed refetch must preserve the prior validated success envelope',
      );
      check(
        client.getQueryData(options.queryKey) === previous,
        'Failed evidence must never become successful cache data',
      );
      check(
        calls === index + 2,
        'Generated retry:false must preserve the executor-owned attempt budget',
      );
      if (failure instanceof Error)
        check(error === transport, 'Transport errors must propagate unchanged');
      else {
        check(
          error instanceof QueryResponseError,
          'HTTP and protocol failures must retain QueryResponseError',
        );
        check(
          error.result.status === failure.status,
          'A rejected refetch must retain its observed exact HTTP status',
        );
        check(
          error.result.kind === (index === 0 ? 'protocol' : 'error'),
          'Status/body mismatch and declared HTTP errors must remain distinguishable',
        );
      }
    }
  } finally {
    await mounted.unmount();
    client.clear();
  }
}

async function maps() {
  const client = queryClient();
  let calls = 0;
  const queries = createQueries({
    namespace: 'mounted-maps',
    execute: async () => {
      calls += 1;
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: `{"__proto__":{"nested":${calls}},"constructor":null,"prototype":"legal","value":${calls}}`,
      };
    },
  });
  const options = queries.readMap.options({ context: {} });
  const mounted = await mountQuery(client, () => ({
    ...options,
    select: (result) => result.data,
  }));
  try {
    await until(() => mounted.result.isSuccess, 'initial dynamic map');
    const previous = mounted.result.data;
    for (const expected of [1, 2]) {
      if (expected === 2) {
        await act(async () => {
          await mounted.result.refetch();
        });
        await until(
          () => mounted.result.data?.['value'] === 2,
          'dynamic map refetch',
        );
      }
      const data = mounted.result.data;
      check(data !== undefined, 'The selected map must exist');
      check(
        Object.hasOwn(data, '__proto__'),
        'Mounted selection must preserve the legal __proto__ map entry',
      );
      same(
        data['__proto__'],
        { nested: expected },
        'Mounted selection must retain nested map values',
      );
      check(
        Object.hasOwn(data, 'constructor') && data['constructor'] === null,
        'Mounted cache updates must preserve constructor:null',
      );
      check(
        data['prototype'] === 'legal' && data['value'] === expected,
        'Every other declared map entry must survive',
      );
      same(
        client.getQueryData(options.queryKey)?.data,
        data,
        'The cache and observer selection must retain the same complete map',
      );
    }
    check(
      mounted.result.data !== previous,
      'A refetch must publish its new complete map',
    );
    check(calls === 2, 'Map refetch must execute once');
  } finally {
    await mounted.unmount();
    client.clear();
  }
}

async function unmount() {
  const client = queryClient();
  const completion = deferred<ObservedResponse>();
  let signal: AbortSignal | undefined;
  let calls = 0;
  const queries = createQueries({
    namespace: 'mounted-unmount',
    execute: async (_request, execution) => {
      calls += 1;
      signal = execution.signal;
      return completion.promise;
    },
  });
  const options = queries.readItem.options({
    context: { session: 'one' },
    input: { path: { id: 'unmounted' } },
  });
  const mounted = await mountQuery(client, () => options);
  try {
    await until(() => signal !== undefined, 'mounted executor');
    check(
      signal !== undefined && !signal.aborted,
      'A mounted request must start with a live signal',
    );
    await mounted.unmount();
    check(
      signal.aborted,
      'Unmounting the final React observer must abort the executor signal',
    );
    await act(async () => completion.resolve(item('late after unmount')));
    await flush();
    check(
      client.getQueryData(options.queryKey) === undefined,
      'An executor ignoring unmount cancellation must not cache its late result',
    );
    check(
      calls === 1,
      'Unmount cancellation must not restart executor retries',
    );
  } finally {
    await mounted.unmount();
    completion.resolve(item('cleanup'));
    client.clear();
  }
}

async function infinite() {
  const client = queryClient();
  const calls: { url: string; signal: AbortSignal; session: unknown }[] = [];
  const late = deferred<ObservedResponse>();
  let failNext = true;
  const page = (id: string, continuation: string | null): ObservedResponse => ({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      results: [
        {
          id,
          label: id,
          attributes: { ['__proto__']: null, constructor: null },
        },
      ],
      continuation,
    }),
  });
  const queries = createInfiniteQueries({
    namespace: 'mounted-infinite',
    execute: async (request, { signal, context }) => {
      calls.push({ url: request.url, signal, session: context['session'] });
      const cursor = new URL(
        request.url,
        'https://synthetic.invalid',
      ).searchParams.get('after');
      if (context['session'] === 'two') return page('new-session', null);
      if (cursor === 'b') return late.promise;
      if (cursor === 'a' && failNext)
        return {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
          body: '{"detail":"Missing"}',
        };
      return page(cursor ?? 'initial', cursor === null ? 'a' : 'b');
    },
  });
  let input: { path: { collection: string } } | typeof skipToken = skipToken;
  let context = { session: 'one' };
  const mounted = await mountHook(client, () =>
    useInfiniteQuery({
      ...queries.listItems.options({ context, input }),
      select: queries.listItems.items,
    }),
  );
  try {
    same(calls.length, 0, 'Skipped infinite queries must not execute');
    input = { path: { collection: 'widgets' } };
    await mounted.update();
    await until(() => mounted.result.isSuccess, 'initial infinite page');
    same(
      mounted.result.data?.map((item) => item.id),
      ['initial'],
      'The initial page must be selected',
    );
    const previous = mounted.result.data;
    await act(async () => {
      await mounted.result.fetchNextPage();
    });
    check(
      mounted.result.isFetchNextPageError,
      'A failed next page must remain an error',
    );
    check(
      mounted.result.data === previous,
      'A failed next page must retain selected cached data',
    );
    check(
      mounted.result.error instanceof QueryResponseError,
      'A failed page must retain HTTP evidence',
    );
    failNext = false;
    await act(async () => {
      await mounted.result.fetchNextPage();
    });
    await until(
      () => mounted.result.data?.length === 2,
      'second infinite page',
    );
    const selected = mounted.result.data;
    check(
      selected?.[1]?.attributes !== undefined &&
        Object.hasOwn(selected[1].attributes, '__proto__'),
      'Infinite selections must preserve legal map entries',
    );
    let pending!: ReturnType<typeof mounted.result.fetchNextPage>;
    await act(async () => {
      pending = mounted.result.fetchNextPage();
    });
    await until(() => calls.length === 4, 'pending third page');
    context = { session: 'two' };
    await mounted.update();
    await until(
      () => mounted.result.data?.[0]?.id === 'new-session',
      'new infinite session',
    );
    check(
      calls[3]!.signal.aborted,
      'Changing infinite context must abort the old page',
    );
    await act(async () => {
      late.resolve(page('late', null));
      await pending;
    });
    same(
      mounted.result.data?.map((item) => item.id),
      ['new-session'],
      'Late pages must not cross session caches',
    );
    same(
      queries.listItems
        .items(
          client.getQueryData(
            queries.listItems.key({ context: { session: 'one' }, input }),
          ),
        )
        .map((item) => item.id),
      ['initial', 'a'],
      'Cancelled pages must preserve the previous complete collection',
    );
  } finally {
    late.resolve(page('cleanup', null));
    await mounted.unmount();
    client.clear();
  }
}

const cases = { skip, identity, filters, failures, maps, unmount, infinite };
export type MountedCase = keyof typeof cases;

export async function runMountedCase(name: MountedCase): Promise<void> {
  await cases[name]();
}
