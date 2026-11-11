import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useInfiniteQuery,
  useMutation,
} from '@tanstack/react-query';
import { createClient } from './.generated/execution/client.consumer.ts';
import type { Executor } from './.generated/execution/client.consumer.ts';
import {
  createQueries,
  createInfiniteQueries,
  shareQueryData,
} from './.generated/execution/client.consumer.queries.ts';
import { createClient as createUploads } from './.generated/multipart/client.browser.ts';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, message);
}

export async function runExecutionBrowser() {
  let requests = 0;
  let reads = 0;
  let scoped = false;
  let scopedValidations = 0;
  let onBodyRead: (() => void) | undefined;
  const execute: Executor<Readonly<Record<string, unknown>>> = async (
    request,
    execution,
  ) => {
    requests++;
    let body: BodyInit | undefined;
    if (request.bodyKind === 'json') body = JSON.stringify(request.body);
    if (request.bodyKind === 'multipart') {
      const form = new FormData();
      check(
        request.body !== null && typeof request.body === 'object',
        'multipart body',
      );
      for (const field of request.multipart) {
        const value: unknown = Reflect.get(request.body, field.name);
        const parts: readonly unknown[] = field.multiple
          ? Array.isArray(value)
            ? value
            : []
          : value === undefined
            ? []
            : [value];
        for (const part of parts) {
          check(
            typeof part === 'string' || part instanceof File,
            'multipart part',
          );
          form.append(field.name, part);
        }
      }
      body = form;
    }
    const response = await fetch(request.url, {
      method: request.method,
      signal: execution.signal,
      headers: request.validateHeaders({
        ...request.headers,
        Authorization: 'Bearer synthetic',
        'X-Language': String(execution.context['locale']),
        ...(request.bodyKind === 'json'
          ? { 'Content-Type': 'application/json' }
          : {}),
      }),
      ...(body === undefined ? {} : { body }),
    });
    reads++;
    const text = response.text();
    const reading = onBodyRead;
    onBodyRead = undefined;
    reading?.();
    const observed = {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await text,
    };
    if (!scoped) return observed;
    scopedValidations++;
    return execution.validateResponse(observed);
  };
  const runtime = { namespace: 'browser-api-v1', execute };
  const client = createClient(runtime);
  const uploads = createUploads(runtime);
  const context = { revision: 'browser-one', locale: 'en' };
  const command = (label: string) => ({
    context,
    input: {
      headers: { 'Idempotency-Key': 'browser-attempt' },
      body: { label, values: ['one'] },
    },
  });
  check(
    (await client.readItem.call({ context, input: { path: { id: 'direct' } } }))
      .data.label === 'Browser',
    'direct read',
  );
  for (const operation of [
    client.createWidget,
    client.replaceWidget,
    client.write_options,
  ])
    check(
      (await operation.call(command('Created'))).status === 201,
      'write status',
    );
  check(
    (
      await client.removeWidget.call({
        context,
        input: { path: { id: 'item' } },
      })
    ).data === undefined,
    'delete data',
  );
  check((await client.health.call({ context })).status === 204, 'head');
  check(
    (await client.commandOptions.call({ context })).status === 204,
    'options',
  );
  const file = new File(['synthetic file'], 'sample.txt', {
    type: 'text/plain',
  });
  const upload = await uploads.upload.call({
    context,
    input: {
      body: {
        caption: 'a\nb',
        note: 'a\r\nb',
        cover: file,
        attachments: [file, file],
        extras: [file],
      },
    },
  });
  check(upload.data.count === 6, 'complete multipart upload');

  // Query happy paths are covered by the raw/scoped and envelope/body matrix
  // below. This mount owns mutation failure, recovery and application effects.
  const cache = new QueryClient();
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  let effects = 0;
  function useCommandMutation() {
    return useMutation({
      mutationFn: (label: string) => client.createWidget.call(command(label)),
      onSuccess: () => {
        effects++;
      },
    });
  }
  let latest: ReturnType<typeof useCommandMutation> | undefined;
  function Probe() {
    latest = useCommandMutation();
    return createElement('output', null, latest.status);
  }
  function state() {
    check(latest, 'mounted state');
    return latest;
  }
  async function until(condition: () => boolean, description: string) {
    const deadline = performance.now() + 5_000;
    while (!condition()) {
      check(
        performance.now() < deadline,
        `mounted mutation timeout: ${description}; ${state().status}`,
      );
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      });
    }
  }
  try {
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: cache },
          createElement(Probe),
        ),
      );
    });
    await act(async () => {
      try {
        await state().mutateAsync('Denied');
        throw new Error('denial must reject');
      } catch (error) {
        check(client.createWidget.isError(error), 'typed mutation failure');
      }
    });
    await until(() => state().isError, 'failed mutation');
    equal(effects, 0, 'denial must not trigger success effects');
    await act(async () => {
      await state().mutateAsync('Created');
    });
    await until(() => state().isSuccess, 'successful mutation');
    equal(effects, 1, 'explicit application success callback');
  } finally {
    await act(async () => root.unmount());
    element.remove();
    cache.clear();
  }

  const mountedCombinations: string[] = [];
  for (const placement of ['raw', 'scoped'] as const) {
    for (const representation of ['envelope', 'body'] as const) {
      scoped = placement === 'scoped';
      const body = representation === 'body';
      const runtime = { namespace: `browser-matrix-${placement}`, execute };
      const ordinary = createQueries(runtime);
      const pages = createInfiniteQueries(runtime);
      const itemArgs = { context, input: { path: { id: 'matrix' } } };
      const cursorArgs = { context, input: { path: { collection: 'matrix' } } };
      const offsetArgs = { context, input: { path: { category: 'matrix' } } };
      const cache = new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: Infinity,
            gcTime: Infinity,
            structuralSharing: shareQueryData,
          },
        },
      });
      const element = document.createElement('div');
      document.body.append(element);
      const mounted = createRoot(element);
      function useMatrix() {
        return {
          ordinary: body
            ? useQuery(ordinary.readItem.body().options(itemArgs))
            : useQuery(ordinary.readItem.options(itemArgs)),
          cursor: body
            ? useInfiniteQuery({
                ...pages.listItems.body().options(cursorArgs),
                select: pages.listItems.body().items,
              })
            : useInfiniteQuery({
                ...pages.listItems.options(cursorArgs),
                select: pages.listItems.items,
              }),
          offset: body
            ? useInfiniteQuery({
                ...pages.listRecords.body().options(offsetArgs),
                select: pages.listRecords.body().items,
              })
            : useInfiniteQuery({
                ...pages.listRecords.options(offsetArgs),
                select: pages.listRecords.items,
              }),
        };
      }
      let latest: ReturnType<typeof useMatrix> | undefined;
      function MatrixProbe() {
        latest = useMatrix();
        return createElement(
          'output',
          null,
          JSON.stringify({
            ordinary: latest.ordinary.data,
            cursor: latest.cursor.data,
            offset: latest.offset.data,
          }),
        );
      }
      function matrix() {
        check(latest, 'mounted matrix state');
        return latest;
      }
      async function settled(condition: () => boolean) {
        const deadline = performance.now() + 5_000;
        while (!condition()) {
          check(
            performance.now() < deadline,
            `matrix timeout: ${placement}/${representation}`,
          );
          await act(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
          });
        }
      }
      try {
        await act(async () =>
          mounted.render(
            createElement(
              QueryClientProvider,
              { client: cache },
              createElement(MatrixProbe),
            ),
          ),
        );
        await settled(
          () =>
            matrix().ordinary.isSuccess &&
            matrix().cursor.isSuccess &&
            matrix().offset.isSuccess,
        );
        // Optimistic inserts can overfill a server page. Mounted hooks must
        // remain usable and stop paging until invalidation restores metadata.
        const offsetRequests = requests;
        await act(async () => {
          if (body) {
            const key = pages.listRecords.body().key(offsetArgs);
            const previous = cache.getQueryData(key);
            check(previous, 'body offset cache');
            cache.setQueryData(key, {
              ...previous,
              pages: previous.pages.map((page) => ({
                ...page,
                entries: [...page.entries, { id: 'optimistic' }],
              })),
            });
          } else {
            const key = pages.listRecords.key(offsetArgs);
            const previous = cache.getQueryData(key);
            check(previous, 'envelope offset cache');
            cache.setQueryData(key, {
              ...previous,
              pages: previous.pages.map((page) => {
                check(page.status === 200, 'initial offset success');
                return {
                  ...page,
                  data: {
                    ...page.data,
                    entries: [...page.data.entries, { id: 'optimistic' }],
                  },
                };
              }),
            });
          }
        });
        await settled(() => matrix().offset.data?.length === 2);
        equal(
          matrix().offset.hasNextPage,
          false,
          'optimistic offset paging stops',
        );
        await act(async () => {
          await matrix().offset.fetchNextPage();
        });
        equal(requests, offsetRequests, 'stopped paging sends no request');
        equal(
          matrix().offset.fetchStatus,
          'idle',
          'optimistic offset query stays idle',
        );
        await act(async () => {
          await cache.invalidateQueries(
            pages.listRecords.invalidationFilter({ context }),
          );
        });
        await settled(
          () =>
            matrix().offset.data?.length === 1 && !matrix().offset.isFetching,
        );
        equal(
          matrix().offset.hasNextPage,
          true,
          'valid refetch restores offset paging',
        );
        const item = matrix().ordinary.data;
        check(item, 'matrix ordinary data');
        equal(
          'data' in item ? item.data.label : item.label,
          'Browser',
          'matrix stored representation',
        );
        await act(async () => {
          await matrix().cursor.fetchNextPage();
          await matrix().offset.fetchNextPage();
        });
        await settled(
          () =>
            matrix().cursor.data?.length === 2 &&
            matrix().offset.data?.length === 2,
        );
        const cursorItem = matrix().cursor.data?.[1];
        check(
          cursorItem && 'code' in cursorItem && cursorItem.code === 2,
          'matrix exact cursor status',
        );
        const previous = matrix().ordinary.data;
        const before = requests;
        await act(async () => {
          await cache.invalidateQueries(
            ordinary.readItem.invalidationFilter({ context }),
          );
        });
        await settled(() => !matrix().ordinary.isFetching);
        equal(requests, before + 1, 'one mounted operation refetch');
        equal(
          matrix().ordinary.data,
          previous,
          'equal matrix refetch shares stored data',
        );
        for (const family of ['ordinary', 'cursor', 'offset'])
          mountedCombinations.push(`${placement}/${representation}/${family}`);
      } finally {
        await act(async () => mounted.unmount());
        element.remove();
        cache.clear();
      }
    }
  }
  const mixedInvalidations: string[] = [];
  for (const profile of ['cursor', 'offset'] as const) {
    scoped = profile === 'offset';
    const runtime = { namespace: `browser-mixed-${profile}`, execute };
    const ordinary = createQueries(runtime);
    const infinite = createInfiniteQueries(runtime);
    const cursorArgs = { context, input: { path: { collection: 'mixed' } } };
    const offsetArgs = { context, input: { path: { category: 'mixed' } } };
    const cache = new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: Infinity,
          gcTime: Infinity,
          structuralSharing: shareQueryData,
        },
      },
    });
    const element = document.createElement('div');
    document.body.append(element);
    const mounted = createRoot(element);
    function useMixed() {
      return {
        envelope:
          profile === 'cursor'
            ? useQuery(ordinary.listItems.options(cursorArgs))
            : useQuery(ordinary.listRecords.options(offsetArgs)),
        body:
          profile === 'cursor'
            ? useQuery(ordinary.listItems.body().options(cursorArgs))
            : useQuery(ordinary.listRecords.body().options(offsetArgs)),
        envelopePages:
          profile === 'cursor'
            ? useInfiniteQuery(infinite.listItems.options(cursorArgs))
            : useInfiniteQuery(infinite.listRecords.options(offsetArgs)),
        bodyPages:
          profile === 'cursor'
            ? useInfiniteQuery(infinite.listItems.body().options(cursorArgs))
            : useInfiniteQuery(infinite.listRecords.body().options(offsetArgs)),
      };
    }
    let latest: ReturnType<typeof useMixed> | undefined;
    function MixedProbe() {
      latest = useMixed();
      return createElement(
        'output',
        null,
        JSON.stringify({
          envelope: latest.envelope.data,
          body: latest.body.data,
          envelopePages: latest.envelopePages.data,
          bodyPages: latest.bodyPages.data,
        }),
      );
    }
    function mixed() {
      check(latest, 'mounted mixed-family state');
      return latest;
    }
    try {
      const initial = requests;
      await act(async () =>
        mounted.render(
          createElement(
            QueryClientProvider,
            { client: cache },
            createElement(MixedProbe),
          ),
        ),
      );
      const deadline = performance.now() + 5_000;
      while (!Object.values(mixed()).every((value) => value.isSuccess)) {
        check(performance.now() < deadline, 'mixed-family mount timeout');
        await act(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        });
      }
      equal(
        requests,
        initial + 4,
        'representations and pagination profiles have independent requests',
      );
      await act(async () => {
        if (profile === 'cursor') {
          const key = ordinary.listItems.body().key(cursorArgs);
          const previous = cache.getQueryData(key);
          check(previous, 'mixed cursor body cache');
          cache.setQueryData(key, {
            ...previous,
            results: [{ id: 'local', label: 'Local edit' }],
          });
          const envelope = cache.getQueryData(
            ordinary.listItems.key(cursorArgs),
          );
          check(envelope?.status === 200, 'mixed cursor envelope status');
          equal(
            envelope.data.results[0]?.id,
            'one',
            'body writes do not update envelope data',
          );
        } else {
          const key = ordinary.listRecords.body().key(offsetArgs);
          const previous = cache.getQueryData(key);
          check(previous, 'mixed offset body cache');
          cache.setQueryData(key, { ...previous, entries: [{ id: 'local' }] });
          equal(
            cache.getQueryData(ordinary.listRecords.key(offsetArgs))?.data
              .entries[0]?.id,
            'one',
            'body writes do not update envelope data',
          );
        }
      });
      const before = requests;
      await act(async () => {
        await cache.invalidateQueries(
          profile === 'cursor'
            ? ordinary.listItems.invalidationFilter({ context })
            : ordinary.listRecords.invalidationFilter({ context }),
        );
      });
      equal(
        requests,
        before + 4,
        'one operation-wide invalidation refetches all four caches once',
      );
      mixedInvalidations.push(`${scoped ? 'scoped' : 'raw'}/${profile}`);
    } finally {
      await act(async () => mounted.unmount());
      element.remove();
      cache.clear();
    }
  }
  scoped = false;

  const controller = new AbortController();
  const reason = { cancelled: 'response read' };
  // Abort at the observed body-read boundary, independent of machine timing.
  onBodyRead = () => controller.abort(reason);
  const pending = client.readItem.call({
    context,
    input: { path: { id: 'slow' } },
    signal: controller.signal,
  });
  try {
    await pending;
    throw new Error('cancelled body read must reject');
  } catch (error) {
    check(error === reason, 'preserve response-read abort reason');
  }
  check(requests === reads, 'one body read per observed response');
  return {
    requests,
    reads,
    effects,
    mountedCombinations,
    mixedInvalidations,
    scopedValidations,
  };
}
