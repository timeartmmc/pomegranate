# Query integration

## Optional query options

Select bodyless GET or HEAD operations per client with `queries` in configuration
or `CompileOptions`, for example:

```json
{
  "queries": { "consumer": ["getWidget", "checkHealth"] }
}
```

This adds `client.consumer.queries.ts` and a shared `query-runtime.ts` without
changing the existing client entries. Query modules import `@tanstack/query-core`
at runtime; install 5.90.20 or newer within 5.x. React applications can use
TanStack React Query 5.90.20 or newer within 5.x. Use the same Query Core release
as your framework adapter. Clients without selected queries need neither TanStack
nor React.

TypeScript environments without DOM libraries must supply platform declarations
for `AbortSignal` and `VoidFunction`. Node types provide `AbortSignal`; if needed,
add `interface VoidFunction { (): void; }` in a global `.d.ts` file.
Cancellation also supports native signals without `throwIfAborted` or `reason`;
it preserves a provided reason and uses an error named `AbortError` when none is
available.

Supply an application `QueryExecutor` as `executeRaw` below. It receives the
prepared request and `{ signal, context }`, and returns raw `{ status, headers, body }`
HTTP evidence with body text. It owns credentials, merged-header validation,
transport headers, deadlines, and retries. Forward the signal to the transport.
Use the frozen context snapshot to bind transport values and session checks to
the same identity as the key, rather than reading changed application state.
The existing example's `execute` returns an already parsed result and does not
implement this raw-response interface.

```ts
import { createQueries } from './generated/client.consumer.queries.ts';

const queries = createQueries({
  namespace: 'widgets-api-v1',
  execute: executeRaw,
});
const args = {
  context: { session: 'synthetic-session-1', locale: 'en' },
  input: { path: { widgetId: 'demo/widget' } },
};
const options = queries.getWidget.options(args);
const key = queries.getWidget.key(args);
```

Pass `options` to `QueryClient.fetchQuery` or a query hook. The key carries result
types for cache access. Namespace the API origin and contract version explicitly;
include every response-changing user/session, tenant, locale, or transport value
in the required nonsecret `context`. Its values are finite JSON scalars; numeric
`-0` becomes `0` in both the key and executor snapshot so JSON cache hydration
preserves identity. Keys include the validated URL and endpoint headers, so
supply credentials through the executor rather than endpoint inputs. Treat
generated keys as opaque.

Factories validate real inputs immediately and snapshot inputs and context.
For a hook waiting on required inputs, pass TanStack's `skipToken` as `input`:

```ts
import { skipToken, useQuery } from '@tanstack/react-query';

function useWidget(widgetId: string | undefined) {
  return useQuery(
    queries.getWidget.options({
      context: { session: 'synthetic-session-1', locale: 'en' },
      input: widgetId === undefined ? skipToken : { path: { widgetId } },
    }),
  );
}
```

Context stays required and is validated even while skipped. A skipped query has
no executable query function: mounting and invalidation do not run the executor,
and manual `refetch` reports TanStack's missing-query-function error without
running it. Supply real input on a later render to enable the query. The returned
options retain response inference and a typed cache key in either state.
`key(args)` accepts real inputs only. Setting `enabled: false` with real input
still validates that input immediately.

To invalidate every input variant of one operation, pass its public filter to the
query client:

```ts
await queryClient.invalidateQueries(
  queries.getWidget.filter({ context: args.context }),
);
await queryClient.invalidateQueries(
  queries.getWidget.filter({ allContexts: true }),
);
```

The first filter matches the complete canonical context, including all field
names and scalar types. Additional fields create a different context; numeric
`-0` and `0` share identity. Matching survives JSON cache hydration. The second
filter explicitly matches across contexts. Both isolate the factory's namespace,
client, and operation. Preserve both the returned `queryKey` and `predicate` when
adding application filters. Applications own when and why invalidation happens.

Query functions forward cancellation, reject late results after cancellation,
and set `retry: false` so the executor owns the retry budget. Success data is the
validated response envelope, including exact status and bodyless `data: undefined`.
Declared HTTP errors and protocol failures reject with a `QueryResponseError`
whose `result` holds the failure envelope. Malformed executor evidence rejects
with `TypeError`; transport errors propagate. Options
set `structuralSharing: false` to preserve every legal JSON map entry during
cache updates; unchanged refetches may produce new object
identities. Preserve the generated key, query function, retry, and
structural-sharing settings when adding application options. Applications own
freshness, enabled conditions, selection, and cancellation or removal of old
session caches. Mutation and cache-effect bindings are not generated. Forward cursor pagination
is available through the infinite factories below.

On TanStack 5.90.20, `useQueries({ combine })` applies its own structural sharing
and ignores the per-query setting. Keep arbitrary JSON maps out of combined
results: entries such as `__proto__` or `constructor: null` can be lost or
rejected. Hydration restores data without generated options. Configure query or
hydration defaults with `structuralSharing: false` before hydrating entries that
application code will update with `setQueryData`. Reading fresh cached data with
`fetchQuery` does not install the generated setting.

## Infinite queries

Bind forward cursor pagination explicitly in configuration or `CompileOptions`:

```json
{
  "infiniteQueries": {
    "consumer": {
      "listItems": {
        "cursor": "after",
        "nextCursor": "continuation",
        "items": "results"
      }
    }
  }
}
```

`listItems` must be a bodyless GET operation on the selected client. `after`
must name an optional, nonnullable string query parameter. Every declared 2xx
response must have a fixed JSON object body with a required nullable string
`continuation` field and a required array `results` field. Component references
are supported. Bindings name top-level fields; nested paths, tagged-union page
objects, numeric cursors, offset pagination, backward pagination, and bodyless
success responses receive diagnostics or remain outside this profile.

This selection adds `createInfiniteQueries` to `client.consumer.queries.ts` and
uses the same executor and runtime dependencies as ordinary queries. Either
selection can be used independently; selecting an operation for both exposes
separate factories and cache identities.

```ts
import { useInfiniteQuery } from '@tanstack/react-query';
import { createInfiniteQueries } from './generated/client.consumer.queries.ts';

const infinite = createInfiniteQueries({
  namespace: 'widgets-api-v1',
  execute: executeRaw,
});

function useItems(collection: string) {
  return useInfiniteQuery({
    ...infinite.listItems.options({
      context: { session: 'synthetic-session-1' },
      input: { path: { collection }, query: { limit: 20 } },
    }),
    select: infinite.listItems.items,
  });
}
```

The hook exposes TanStack's `fetchNextPage`, `hasNextPage`, loading, and error
state. The optional `items` selector flattens the declared arrays into a fresh,
typed array in page order. It preserves duplicates and item values. Applications
own rendering, deduplication policy, and mutation/invalidation bindings.

Base inputs exclude the bound cursor; supplying it fails validation. Factories
validate and copy base inputs immediately, including arrays and structural
fields, so later pages do not reread caller state. The first page omits the
cursor with `initialPageParam: null`. Later pages validate the server's cursor
through the ordinary request builder before execution. An invalid cursor fails
before transport; a failed later fetch retains any previous cached collection.

A `null` response cursor ends pagination. Empty strings are real cursors, and
empty item arrays do not end pagination when a next cursor exists. A cursor
already present in the retained `pageParams` ends pagination to prevent repeated
pages and cycles. TanStack's `maxPages` option can evict that history; applications
that enable eviction own the resulting limit on cycle detection.

Without `select`, data is `{ pages, pageParams }`: each page is its exact-status
validated success envelope, and page parameters are strings or the initial
`null`. Keys retain these types through cache access and JSON hydration. Use
`key(args)` for a real request and `filter({ context })` or
`filter({ allContexts: true })` for infinite-cache invalidation. Ordinary query
filters and infinite query filters address their own cache families.

Required inputs can wait using `input: skipToken`, with the same explicit,
validated context as ordinary queries. Cancellation and failed HTTP/protocol
results follow the same executor rules. Preserve the generated key, query
function, initial page parameter, next-page callback, retry, and structural-sharing
settings when adding application options.

Infinite options intentionally keep their outer object extensible: Query Core
5.90.20 installs its behavior there before copying options. They can be passed
directly to `fetchInfiniteQuery`, `ensureInfiniteQueryData`, and
`prefetchInfiniteQuery`. Keys remain frozen, base inputs are copied, and executor
context is a frozen snapshot. The map-preservation and hydration limits above apply
to infinite caches too.
