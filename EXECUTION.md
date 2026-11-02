# Executable clients

See [checkout status](README.md#checkout-status) for release availability.

## Selection and calls

Select surfaces explicitly in configuration or `CompileOptions`:

```json
{
  "clients": ["consumer", "staff"],
  "executionClients": ["consumer"],
  "queries": { "consumer": ["getWidget"] }
}
```

Every execution surface must also appear in `clients`. Unknown, unselected or
duplicate names fail before writing. Omission or `[]` disables execution output.
Each selected surface gets `client.<surface>.execute.ts` and an explicit
`createClient` export from its client entry. Its operations and schema maps stay
independently usable. Execution alone uses the copied local validation runtime and imports no
TanStack, React, or schema-library dependency.
`call-runtime.ts` holds direct-call construction, while `execution-runtime.ts`
shares response interpretation and error identity with queries. Native direct
calls need platform declarations and implementations for `AbortController` and
`AbortSignal`; query-only generation retains its existing declaration requirements.

```ts
import { createClient } from './generated/client.consumer.ts';
import { createQueries } from './generated/client.consumer.queries.ts';

const runtime = { namespace: 'widgets-api-v1', execute: executeRaw };
const client = createClient(runtime);
const queries = createQueries(runtime);
const context = { sessionRevision: 'revision-one', locale: 'en' };

const response = await client.getWidget.call({
  context,
  input: { path: { widgetId: 'demo/widget' } },
  signal,
});
const pending = await client.prepareWidget.call({
  context,
  input: {
    path: { widgetId: 'demo/widget' },
    headers: { 'Idempotency-Key': 'attempt-one' },
    body: { acknowledged: true, label: 'Example widget' },
  },
});
```

Every operation on the surface has `call(args)` and `isError(error)`, including
POST, PUT, PATCH, DELETE, HEAD and OPTIONS. Required path, header and body inputs
retain their builder types; an operation with no required input permits omission
of `input`. Calls return promises. Invalid requests reject before the executor
runs. Successes retain the exact declared 2xx status, raw normalized headers,
validated declared headers and schema-validated data. Bodyless success has an own
`data: undefined` field. Different success statuses retain distinct body types.

`createClient` returns the exported readonly `Client` type. Its `ClientMembers`
interface names declaration members so applications can publish inferred clients
without expanding the entire API. Treat it as a declaration anchor; module
augmentation does not add runtime operations.

## One application executor

Client entries export `Executor`, `Execution`, `ExecutionContext` and `ClientConfig`. An
`Executor` accepts a `PreparedRequest` with body kind `none`, `json` or `multipart`
and a frozen `{ signal, context, validateResponse }` execution object. It can return raw
`{ status, headers, body }` evidence, with numeric status, a plain string header
record, and body text, or an inspection handle from `validateResponse`. It may reject
with an application error. Raw executors can ignore the callback.

The application resolves the API origin, credentials and declared policy labels,
validates merged headers with `request.validateHeaders`, serializes the prepared
body and forwards the signal to its transport. POM invokes this executor once;
the executor owns recovery, retries, deadlines, locale and session fencing. A
broad executor can serve direct calls, ordinary queries and both infinite query
profiles without casts. Existing bodyless `QueryExecutor` implementations remain
valid for queries.

For raw execution, read the final body once and return its evidence. POM parses JSON
and applies the exact-status response schema once after the executor returns.
The JSON example's `createExecutor` shows
this boundary and forwards cancellation. Its legacy parsed `execute` entry
delegates to the same raw path. Returning domain data or reconstructing status and
headers from a discarded parsed success is unsupported.
Application recovery may observe and validate additional HTTP denials before the
final response; that does not make the whole attempt sequence one response.

An existing transport with a response-parser hook can keep its execution path.
One application-owned adapter can replace the prepared request's `parseResponse`
hook with a call to `execution.validateResponse`, retain the original inspection
handle, and return that handle after the transport completes successfully. The
transport still owns serialization, localization, recovery, deadlines, and error
policy. The adapter must preserve the correspondence between the transport's
completed response and the handle it returns. This needs no additional POM
transport interface or per-endpoint bridge.

Context is always required, including for writes and bodyless calls. Use nonsecret
finite JSON scalars for every response-changing session revision, tenant, locale
or transport value. Records must contain enumerable own data properties.
Normalization matches query context: names are sorted and numeric `-0` becomes
`0`, including in the frozen executor snapshot. Never put credentials in context.
The executor must use the snapshot for session and locale checks rather than
rereading mutable application state.

Input validation and context capture happen synchronously before the call yields.
Later caller mutation cannot change the prepared request or executor context.
JSON bodies and native file references are copied; immutable browser `File`
objects retain identity. A direct call's signal is optional; an omitted signal
becomes a fresh usable signal. Pre-aborted calls do not invoke transport.
Cancellation reasons are preserved, including falsy reasons. POM checks after
executor settlement and evidence interpretation so late results cannot become
success. The executor must forward cancellation to interrupt network I/O; an
executor that never settles cannot be interrupted by a POM retry or timer.

## Validation inside recovery and deadlines

`execution.validateResponse(observed)` synchronously checks status, headers, media
type, body, and any bound query-pagination metadata. It returns a deeply readonly,
frozen inspection handle: a detached copy of the validated success, declared HTTP
failure, or protocol failure. Return that same handle to select the saved response.
POM then returns its separately owned mutable success body or throws its usual
`ResponseError`. Inspection data cannot be used to transform the final response.

```ts
import type { Executor } from './generated/client.consumer.ts';

const execute: Executor = async (request, execution) => {
  const observed = await executeRaw(request, execution);
  const inspected = execution.validateResponse(observed);
  // Application recovery can inspect kind, status, headers, and protocol issues.
  return inspected;
};
```

Each evidence object can be passed to the callback only once within an invocation.
Repeated validation or returning already-inspected raw evidence throws `TypeError`;
return its handle instead. Each additional HTTP response in a recovery loop needs
fresh evidence. Recovery can select any handle created by that invocation.
Fabricated, copied, and foreign handles are rejected. The callback closes when
POM observes executor settlement, including rejection, and releases its saved
responses. Cancellation takes precedence over callback-expiry errors.

`ResponseInspection<R>` describes the readonly inspection view;
`ValidatedResponse<R>` names the output-specific branded handle type. Its brand
does not establish runtime provenance; POM accepts only an original handle from
the current invocation. `Execution<R, V>` defaults to the unbranded view, so
explicitly annotated raw adapters remain assignable. A
generic scoped adapter carries its caller's `V` and can serve independently
generated outputs without importing a particular output's brand.

The inspection copy is frozen recursively, while public `parseResponse`, call,
and query bodies remain mutable. TypeScript rejects inspection edits; strict-mode
JavaScript assignments throw. Transform response data after the generated call
or through application-owned domain adapters. Cache updates still need immutable
updates as described in [query integration](QUERIES.md).

Keeping the saved response private prevents edits between validation and handoff.
Handing the executor the real mutable result would avoid the inspection copy but
would give up that boundary. Freezing all public responses would instead change
application editing and hydrated-cache behavior. The isolated inspection keeps
final bodies mutable and places copying only on the scoped-validation path.

Status-based recovery already works with `request.parseResponse` and can leave
successful responses for POM to parse once. Use the callback when complete response
validation belongs inside recovery or a deadline: validating a success with
`request.parseResponse` and then returning raw evidence would validate it again.
The callback also includes bound pagination checks that the request parser does
not own. This applies to malformed successful responses as well as declared
HTTP failures; it does not interpret application errors hidden in a valid body.

Place the callback inside each attempt or total scope whose budget includes
validation and inspection copying. Check a monotonic clock after synchronous
work on both resolved and rejected paths, before recovery or return; a timer
cannot interrupt parsing or copying. POM supplies no clock, deadline, retry loop,
or timeout-label meaning. The extra copy and peak memory belong in the
application's measurements. A simple Fetch executor can keep the raw path.

## Cancellation mapping

The optional `mapCancellation` configuration belongs to execution support and is
shared by clients and query factories. Without a mapper, an observed abort wins
over a late success or rejection and throws its defined signal reason verbatim,
including falsy values. A missing reason receives a portable `AbortError`.

A mapper receives a frozen `CancellationEvent` with `namespace`, `client`,
`operationId`, captured `context`, `reason`, `executorInvoked`, and an optional
`rejection: { error }` for a terminal failure. The wrapper preserves even a caught
`undefined` rejection. Return a plain record containing exactly one enumerable
own `error` data field; POM throws that value verbatim. The mapper is synchronous,
runs once at the final cancellation exit, and its own exception propagates.
Promises, accessors, and malformed return records throw `TypeError`. Reasons and
application errors themselves are not frozen.

Pre-aborted calls skip building and execution. Their event has
`executorInvoked: false` and no rejection. Mapping covers call guards and query
function guards after usable signal and context capture; skipped queries do not
run it. Invalid arguments that cannot establish that context remain input errors.
Checks inside the validation callback retain the original abort reason so
application recovery sees it before final mapping.

`executorInvoked` records whether POM called the executor. It does not prove a
request was sent. An invoked write remains possibly sent unless the application
transport has more precise delivery evidence. Use that evidence when preserving
classified write errors; cancellation alone cannot authorize replay.

The hook is most useful to direct-call consumers. TanStack owns query cancellation
and state reversion: a cancelled query observer or `fetchQuery` caller can receive
TanStack's cancellation result rather than the query function's mapped error.
The hook does not replace Query Core cancellation handling. Cancellation remains
cooperative; the executor must settle and forward its signal to network I/O.

## Failures and application effects

Declared HTTP failures and protocol failures reject with `ResponseError`.
`ResponseError` is the same constructor as the existing `QueryResponseError`,
including its `name: 'QueryResponseError'`, constructor shape and `instanceof`
behavior. Use the operation's guard to recover its declared failure types:

```ts
try {
  await client.prepareWidget.call(args);
} catch (error) {
  if (!client.prepareWidget.isError(error)) throw error;
  if (error.result.kind === 'protocol') {
    reportProtocolIssues(error.result.issues);
  } else if (error.result.status === 409) {
    showConflict(error.result.data);
  }
}
```

The guard accepts only failures validated for the same generated operation,
surface and namespace, including across recreated clients and query factories.
Constructed, copied, serialized, independently generated or result-replaced errors
do not gain this provenance. Application executor errors propagate by identity.
Malformed JavaScript executor evidence throws `TypeError`; protocol failures
retain status and headers and expose no domain data.

Direct calls fit a mutation function, such as
`mutationFn: input => client.prepareWidget.call({ context, input })`. Denials
reject and cannot trigger a successful mutation or cache an error as successful
query data. Applications explicitly own invalidation, optimistic updates,
persistence, session-cache removal, product transformations and side effects.
POM infers none of these from operation names or HTTP methods. Keep domain
wrappers that still serve an application purpose.

## Uploads and queries

Multipart selection still requires a browser or native target. Executable upload
inputs preserve every declared text, file and repeated-file field. Browser
inputs require `File`; native inputs require `{ uri, name?, mediaType? }` and
compile without DOM libraries when platform types supply the standard globals.
The application uses `request.multipart` and the complete validated body to
create its platform body. It owns file access, progress and fresh body creation
for every retry. POM does not construct `FormData` or open a native URI.

`test/multipart-fixture.ts` supplies the synthetic upload contract, while
`test/execution-browser-app.ts` exercises a single generic executor that switches
only on body kind for real uploads, writes and mounted queries. The isolated
package check generates and runs these public synthetic contracts after removing
the compiler. The JSON example focuses on reads, writes and selected queries.

Query keys, readiness and skip conditions, filters, sharing and pagination remain
query concerns. Pagination metadata is checked before a page becomes successful
cache data. A direct call validates the operation response schema and imposes no
pagination traversal policy. See [query integration](QUERIES.md) for those APIs.
