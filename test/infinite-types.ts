import { QueryClient, skipToken } from '@tanstack/query-core';
import { useInfiniteQuery } from '@tanstack/react-query';
import { createInfiniteQueries } from './query-generated/client.consumer.queries.ts';

const infinite = createInfiniteQueries({
  namespace: 'pages',
  execute: async () => ({ status: 200, headers: {}, body: '' }),
});
const infiniteArgs = {
  context: { session: 'one' },
  input: { path: { collection: 'widgets' } },
};
const infiniteClient = new QueryClient();
const infiniteCached = infiniteClient.getQueryData(
  infinite.listItems.key(infiniteArgs),
);
if (infiniteCached) {
  const infiniteCursor: string | null | undefined =
    infiniteCached.pageParams[0];
  const infiniteItem: string | undefined =
    infiniteCached.pages[0]?.data.results[0]?.id;
  void [infiniteCursor, infiniteItem];
  // @ts-expect-error Infinite keys tag the complete page collection.
  void infiniteCached.data;
  // @ts-expect-error Item types survive the cache boundary.
  void infiniteCached.pages[0]?.data.results[0]?.missing;
}
const infiniteSkipped = infinite.listItems.options({
  context: {},
  input: skipToken,
});
const infiniteWaiting = infinite.listItems.options({
  context: {},
  input: Math.random() ? skipToken : infiniteArgs.input,
});
void [infiniteSkipped, infiniteWaiting];
infinite.listItems.options({
  context: {},
  input: {
    path: { collection: 'widgets' },
    query: {
      // @ts-expect-error The cursor is supplied by pagination, not base input.
      after: 'override',
    },
  },
});
// @ts-expect-error Required base path inputs remain required.
infinite.listItems.options({ context: {} });
// @ts-expect-error Context is explicit even while skipped.
infinite.listItems.options({ input: skipToken });
// @ts-expect-error Skipped inputs cannot identify a real request.
infinite.listItems.key({ context: {}, input: skipToken });
// @ts-expect-error Only selected infinite operations are exported.
void infinite.readItem;
infinite.listItems.items({
  // @ts-expect-error Page envelopes must retain their declared data shape.
  pages: [{ data: { results: [7] } }],
  pageParams: [null],
});

export function useSyntheticInfinite(collection: string | undefined) {
  const result = useInfiniteQuery({
    ...infinite.listItems.options({
      context: {},
      input: collection === undefined ? skipToken : { path: { collection } },
    }),
    select: infinite.listItems.items,
  });
  const id: string | undefined = result.data?.[0]?.id;
  void id;
  // @ts-expect-error The selected list retains its generated item type.
  const wrong: number = result.data?.[0]?.id;
  void wrong;
  return result;
}

export async function fetchSyntheticInfinite() {
  const result = await infiniteClient.fetchInfiniteQuery({
    ...infinite.listItems.options(infiniteArgs),
    pages: 2,
  });
  const item: string | undefined = infinite.listItems.items(result)[0]?.id;
  void item;
  if (result.pages[0]?.status === 206) {
    const status: 206 = result.pages[0].status;
    void status;
  }
}
