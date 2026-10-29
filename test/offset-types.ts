import { QueryClient, skipToken } from '@tanstack/query-core';
import { useInfiniteQuery } from '@tanstack/react-query';
import { createInfiniteQueries } from './offset-generated/client.consumer.queries.ts';

const offsets = createInfiniteQueries({
  namespace: 'typed-offsets',
  execute: async () => ({ status: 200, headers: {}, body: '' }),
});
const offsetArgs = { context: {}, input: { path: { category: 'records' } } };
const offsetClient = new QueryClient();
const offsetOptions = offsets.listRecords.options(offsetArgs);
const initialOffset: 0 = offsetOptions.initialPageParam;
void initialOffset;
const offsetData = offsetClient.getQueryData(offsetOptions.queryKey);
if (offsetData) {
  const page: number | undefined = offsetData.pageParams[0];
  const id: string | undefined = offsets.listRecords.items(offsetData)[0]?.id;
  void [page, id];
  // @ts-expect-error Offset keys never carry string cursors.
  const cursor: string = offsetData.pageParams[0];
  void cursor;
  // @ts-expect-error The item selector retains the declared item type.
  void offsets.listRecords.items(offsetData)[0]?.missing;
}
offsets.listRecords.options({ context: {}, input: skipToken });
offsets.listRecords.options({
  ...offsetArgs,
  // @ts-expect-error Offsets are supplied by the generated traversal.
  input: { path: { category: 'records' }, query: { start: 0 } },
});
// @ts-expect-error Required base path parameters stay required.
offsets.listRecords.options({ context: {} });
// @ts-expect-error Skipping does not remove the cache-context requirement.
offsets.listRecords.options({ input: skipToken });
offsetOptions.queryFn({
  client: offsetClient,
  queryKey: offsetOptions.queryKey,
  signal: new AbortController().signal,
  meta: undefined,
  direction: 'forward',
  // @ts-expect-error Offset factories reject string page parameters.
  pageParam: '2',
});
// @ts-expect-error Offset page collections contain numeric page parameters.
offsets.listRecords.items({ pages: [], pageParams: [null] });

export function useOffsets(category: string | undefined) {
  const query = useInfiniteQuery({
    ...offsets.listRecords.options({
      context: {},
      input: category ? { path: { category } } : skipToken,
    }),
    select: offsets.listRecords.items,
  });
  const id: string | undefined = query.data?.[0]?.id;
  void id;
  return query;
}
