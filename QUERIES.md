# Query integration

Query factories generate TanStack options, cache keys, filters, and pagination
helpers around an application executor. They store success envelopes by default;
API-body storage is an explicit choice.

Query factories are optional and independent of executable clients.
Applications can use generated calls with their existing cache keys, readers,
writers, and mutation effects. Adopt factory keys only with an explicit migration
of every affected cache access.

## Ordinary queries

Select bodyless GET or HEAD operations per client with `queries` in configuration
or `CompileOptions`, for example:

```json
{
  "queries": { "consumer": ["getWidget", "checkHealth"] }
}
```

This adds `client.consumer.queries.ts` and shared `execution-runtime.ts`, `query-runtime.ts` and
`query-sharing.ts` helpers without changing the existing client entries.
Query modules import `@tanstack/query-core`
at runtime; install 5.104.5 or newer within 5.x. React applications can use
TanStack React Query 5.104.5 or newer within 5.x. Use the same Query Core release
as your framework adapter, including persistence adapters that share Query Core.
Clients without selected queries need neither TanStack nor React and do not
require a query-library upgrade for executable-client adoption.

Query modules reference their configured operation selections directly, allowing
bundlers to remove unrelated operations and schemas. Each factory retains its
complete configured selection. Importing the full `operations` registry or using
`createClient` retains that client's complete API. Bundle savings depend on the
application and bundler; generation still validates every declaration and emits
the complete selected client surfaces.

Factories return the exported readonly `Queries` and `InfiniteQueries` types.
Their `QueryMembers` and `InfiniteQueryMembers` interfaces keep inferred
application declarations compact. Treat these interfaces as declaration anchors;
module augmentation does not add runtime factories.

TypeScript environments without DOM libraries must supply platform declarations
for `AbortSignal` and `VoidFunction`. Node types provide `AbortSignal`; if needed,
add `interface VoidFunction { (): void; }` in a global `.d.ts` file.
Cancellation also supports native signals without `throwIfAborted` or `reason`;
the default behavior preserves a provided reason and uses an error named
`AbortError` when none is available.

Supply an application `QueryExecutor` as `executeRaw` below. It accepts bodyless
requests and shares the [executor contract](EXECUTION.md#one-application-executor)
with direct calls, including raw response evidence, scoped validation,
credentials, merged-header validation, retries, and deadlines. The checkout's
`examples/json/transport.ts` demonstrates `createExecutor` for calls and queries.

```ts
import { createQueries } from './generated/client.consumer.queries.ts';

const queries = createQueries({
  namespace: 'widgets-api-v1',
  execute: executeRaw,
});
const args = {
  context: { cacheScope: 'demo-user-revision-1', locale: 'en' },
  input: { path: { widgetId: 'demo/widget' } },
};
const options = queries.getWidget.options(args);
const key = queries.getWidget.key(args);
```

### Keys and context

Pass `options` to `QueryClient.fetchQuery` or a query hook. The key carries result
types for cache access. Namespace the API origin and contract version explicitly;
include every response-changing user/session, tenant, locale, or transport value
in the required nonsecret `context`. Context follows the
[execution context rules](EXECUTION.md#context-and-snapshots), including scalar
normalization, so JSON hydration preserves identity. Keys include the validated
URL and endpoint headers, so supply credentials through the executor rather than
endpoint inputs. Treat generated keys as opaque.
`cacheScope` above is a nonsecret cache revision, never a bearer token or session
credential. Change it when the response's user or session identity changes.

### Waiting for inputs

Factories validate real inputs immediately and snapshot inputs and context.
For a hook waiting on required inputs, pass TanStack's `skipToken` as `input`:

```ts
import { skipToken, useQuery } from '@tanstack/react-query';

function useWidget(widgetId: string | undefined) {
  return useQuery(
    queries.getWidget.options({
      context: { cacheScope: 'demo-user-revision-1', locale: 'en' },
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

### Invalidation

To invalidate every input variant in the factory's cache family, pass its public
filter to the query client:

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

To invalidate all supported representations and pagination families of that
operation, use `invalidationFilter` instead:

```ts
await queryClient.invalidateQueries(
  queries.getWidget.invalidationFilter({ context: args.context }),
);
```

It accepts the same `{ context }` or `{ allContexts: true }` scope. Its predicate
matches the complete context and the same namespace, client, and operation across
the six families below, including JSON-hydrated keys. Unknown key formats do not
match. Preserve its returned predicate when adding application filters; it has no
single-family `queryKey` or common stored-data type. Use family-specific keys for
typed data reads and writes. `filter` remains scoped to its family.

### Errors and cancellation

Query functions forward cancellation, reject late results after cancellation,
and set `retry: false` so the executor owns the retry budget. By default, success
data is the validated response envelope, including its status and bodyless `data: undefined`.
Declared HTTP errors and protocol failures reject with a `QueryResponseError`
whose `result` holds the failure envelope. Narrow an unknown error with the
operation's `isError` guard to recover its status and declared body types:

```ts
try {
  await queryClient.fetchQuery(options);
} catch (error) {
  if (queries.getWidget.isError(error)) {
    if (error.result.kind === 'protocol') {
      console.error(error.result.issues);
    } else {
      // Narrow result.status to a declared error status to access its body.
      console.error(error.result.status, error.result.data);
    }
  } else {
    throw error;
  }
}
```

Error provenance, transport failures, and malformed executor evidence follow the
[shared failure rules](EXECUTION.md#failures-and-application-effects). Ordinary
and infinite factories for the same generated operation, client, and namespace
recognize each other's validated failures. `QueryResponseError` remains available
for broad response-error handling.

Client and query configurations accept the same optional `mapCancellation`,
described under [cancellation mapping](EXECUTION.md#cancellation-mapping).
TanStack handles its own query cancellations and can replace the query function's
mapped rejection with its cancellation result.

## Choose cache storage once per operation

Factories store success envelopes by default. For an operation whose every
possible success has a JSON or text body, `.body()` creates a factory that
stores only the validated API body. Possible successes are the 2xx statuses,
`2XX`, and a `default` that
[still receives a 2xx status](REFERENCE.md#response-evidence). Envelope results
retain the validated `contentType` and its data correlation; body-only storage retains the payload union without
that discriminator. Any bodyless success makes body mode unavailable in
types and rejects JavaScript selection before transport. JSON `null` is valid;
successful `undefined` query data is never stored. All response and bound
pagination checks finish before projection. Observer `select` only changes an
observer's view, not the stored representation.

When upgrading generated output that introduces response `contentType` metadata,
rotate the application's cache namespace or migrate persisted envelope data.
Response media types are not request-key inputs: the server's choice is known
only after execution.

Select and export the representation in one application query module, and have
components and cache writers use that export:

```ts
const factories = createQueries({
  namespace: 'widgets-api-v1',
  execute: executeRaw,
});
export const widgetQuery = factories.getWidget.body();

const key = widgetQuery.key(args);
const body = queryClient.getQueryData(key); // The API body type, not an envelope.
```

Use one representation per operation in normal application code. Choose envelopes
when status or response headers affect the application. Repeated `.body()`
selection keeps the same cache identity; factory object identity is irrelevant.
Storage is an application choice, so there is no additional `pom.json` setting.

The representations use separate keys:

| Query profile | Envelope family   | Body family            |
| ------------- | ----------------- | ---------------------- |
| Ordinary      | `pom-query-v1`    | `pom-query-body-v1`    |
| Cursor        | `pom-infinite-v1` | `pom-infinite-body-v1` |
| Offset        | `pom-offset-v1`   | `pom-offset-body-v1`   |

All retain namespace, client, operation, complete context, and validated input
identity. Cache access, hydration, and page selectors retain the selected stored
type. Operation error guards work across these families for the same generated
operation, namespace, and client.

If both representations are used, they have independent cache entries:
requests are not deduplicated between them, and `setQueryData` on one does not
update the other. `invalidationFilter` can refresh both but does not synchronize
direct writes. Applications own updates to every representation they keep. This
also applies when ordinary and infinite caches coexist.

## Sharing and hydration

Options use POM's `shareQueryData` function for structural sharing. Equal plain
data trees reuse their previous references; changed trees reuse equal children.
Sharing preserves every map and header key, including `__proto__` and
`constructor: null`, plus prototypes, property flags, and key order.
Deep JSON is processed iteratively without a call-stack depth limit. Sharing
inspects compared data; measure its time and allocations on application workloads.
Appending pages can retain existing page references without inspecting their
contents again.

Selections containing class instances, accessors, sparse arrays, symbol or
nonenumerable fields, cycles, or repeated object references keep the new value
when sharing would change it. Inputs are never mutated. Data-only observers can
avoid redraws on unchanged refetches; observers of loading or timestamp fields
can still update. Preserve the generated key, query function, retry, and
structural-sharing settings when adding application options. Applications own
freshness, enabled conditions, selection, and cancellation or removal of old
session caches. Mutation and cache-effect bindings are not generated.

On TanStack 5.104.5, `useQueries({ combine })` applies its own structural sharing
and ignores the per-query setting. Keep arbitrary JSON maps out of combined
results: entries such as `__proto__` can be lost.
Hydration restores data without generated options. Configure
`shareQueryData` as the query default before cold `setQueryData` writes or hydration,
including entries created before generated options exist:

```ts
import { QueryClient } from '@tanstack/query-core';
import { shareQueryData } from './generated/client.consumer.queries.ts';

const queryClient = new QueryClient({
  defaultOptions: { queries: { structuralSharing: shareQueryData } },
});
```

Reading fresh cached data with `fetchQuery` does not install the generated
setting. JSON hydration does not preserve frozen descriptors or null prototypes;
the first live refetch can replace the envelope and header records to restore
them while still sharing equal body subtrees.
Body storage has no frozen-body transition on that first refetch. Hydration and
direct writes do not validate response schemas or create validation handles;
applications own their sources and compatibility. Keep cache updates immutable
even though returned body types are mutable.

## Cursor pagination

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
must name an optional string or nullable string query parameter. Every representation of each [possible success](#choose-cache-storage-once-per-operation) must have a fixed JSON object body with a required nullable string
`continuation` field and a required array `results` field. Component references
are supported. Bindings name top-level fields; nested paths, tagged-union page
objects, numeric cursors, backward pagination, and bodyless
success responses are unsupported.

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
      context: { cacheScope: 'demo-user-revision-1' },
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

Base inputs exclude the bound pagination parameter; supplying it fails validation. Factories
validate and copy base inputs immediately, including arrays and structural
fields, so later pages do not reread caller state. The first page omits the
cursor with `initialPageParam: null`, whether its request schema accepts null or
only strings. Nullable query values mean omission, so null is never sent as a
cursor value. Later pages validate the server's cursor
through the ordinary request builder before execution. An invalid cursor fails
before transport; a failed later fetch retains any previous cached collection.

A `null` response cursor ends pagination. Empty strings are real cursors, and
empty item arrays do not end pagination when a next cursor exists. A cursor
already present in the retained `pageParams` ends pagination to prevent repeated
pages and cycles. TanStack's `maxPages` option can evict that history; applications
that enable eviction own the resulting limit on cycle detection.

With default envelope storage and no `select`, data is `{ pages, pageParams }`:
each page is its validated success envelope, and page parameters are
strings or the initial `null`. Keys retain these types through cache access and
JSON hydration. Use
`key(args)` for a real request and `filter({ context })` or
`filter({ allContexts: true })` for infinite-cache invalidation. Ordinary query
filters and infinite query filters address their own cache families.

Select `.body()` centrally for an infinite factory to store each validated page's
API body instead. The collection still has `pages` and `pageParams`, with the same
cursor types, and that factory's `items` selector accepts the selected page shape.
Its `invalidationFilter` spans all supported families for the operation, while
`filter` remains specific to its representation and pagination profile.

Required inputs can wait using `input: skipToken`, with the same explicit,
validated context as ordinary queries. Cancellation and failed HTTP/protocol
results follow the same executor rules. Preserve the generated key, query
function, initial page parameter, next-page callback, retry, and structural-sharing
settings when adding application options.

Infinite options keep their outer object extensible: Query Core
5.104.5 marks it as an infinite query before copying options. They can be passed
directly to `fetchInfiniteQuery`, `ensureInfiniteQueryData`, and
`prefetchInfiniteQuery`. Keys remain frozen, base inputs are copied, and executor
context is a frozen snapshot. The map-preservation and hydration limits above apply
to infinite caches too.

## Numeric offsets

For a response shaped like `{ items, total, limit, offset }`, select an offset
binding instead of a cursor binding:

```json
{
  "infiniteQueries": {
    "consumer": {
      "listRecords": {
        "offset": "offset",
        "responseOffset": "offset",
        "responseLimit": "limit",
        "total": "total",
        "items": "items"
      }
    }
  }
}
```

The binding names the request query parameter and four distinct top-level response
fields; names need not follow this example. The request offset must be a
nonnullable integer parameter whose constraints accept `0`; it may be required.
Every declared representation of each [possible success](#choose-cache-storage-once-per-operation) must have a fixed JSON object body with the bound
fields required: integer offset, limit and total, and an array of items.
Component references are supported. Nested fields and mixed cursor/offset
bindings receive diagnostics.

Use the same factory methods as for cursors. Base inputs exclude the request
offset. The first request
explicitly sends `0` with `initialPageParam: 0`; all cached `pageParams` remain
numbers, including through declaration emission and JSON hydration. Supply page
size and other query parameters as ordinary base inputs when needed. OpenAPI
default annotations do not insert request values.

The next offset is the last response's offset plus its returned item count.
A short page can continue; an empty page or reaching the latest response's total
ends traversal. Advancing from the response preserves progress when `maxPages`
evicts earlier pages. A shrinking total can end traversal without discarding
already returned items. Applications own consistency when records change
between requests; the helper does not deduplicate or provide a snapshot.

Before caching success, the helper requires a nonnegative safe integer offset
and total, a positive safe integer limit, a response offset matching the request,
and at most `limit` returned items. Offset arithmetic must stay within the safe
integer range. Violations reject with a scoped protocol error, retaining response
status and headers; previous successful pages remain available. Each subsequent
request also passes the ordinary request schema's constraints. Invalid numeric
page parameters fail before transport. Offset, cursor, and ordinary query filters
address separate cache families, even for the same initial URL.

Direct cache writes can temporarily make a page's offset metadata inconsistent,
for example by inserting an item beyond its declared limit. That page stops
forward pagination until a valid refetch or cache update restores the bounds.
Incoming HTTP responses still receive the full metadata checks above. Use
invalidation to refresh server page boundaries after such edits.
