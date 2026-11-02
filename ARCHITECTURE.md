# Architecture and requirements

Pomegranate compiles explicit local OpenAPI into application-owned TypeScript
artifacts. The [README](README.md) describes the current supported vocabulary.
This document owns the boundaries and guarantees that changes must preserve.

## Ownership

| Owner          | Responsibility                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application    | API schemas, OpenAPI export, operation policy, generated artifacts, transport, authentication, retries, deadlines, error interpretation, platform adapters, and integration tests |
| Pomegranate    | Supported contract interpretation, one normalized model, generation, diagnostics, drift detection, and generated-output ownership                                                 |
| Generated code | Types, request validation, URL construction, exact-status response validation, and optional executable clients and query factories using an application executor                  |

The compiler is a development dependency. Generated modules use relative imports
and declared runtime dependencies; applications must not import the compiler at
runtime. Policy labels describe application choices. They do not implement those
choices or establish authorization.

Executable clients are selected independently of queries and bind every operation
on a selected surface to one application executor configuration. They preserve required
input inference, snapshot context and requests before yielding, forward a usable
signal, and return exact-status success envelopes. Declared HTTP and protocol
failures reject; executor errors retain their identity. Direct calls and queries
share cancellation, context normalization, response interpretation and operation
error provenance in `execution-runtime.ts`. Only executable surfaces emit
`call-runtime.ts` for direct-call construction and default signal creation;
query-only output adds no `AbortController` declaration requirement.
Query cache identities and pagination
checks remain in the query runtime. Applications own body reads. Raw executors
return evidence for interpretation after execution; scoped executors can call the
supplied validation callback inside their recovery and deadline scope. The latter
performs exact-status and bound-pagination validation once and returns a detached,
deeply readonly inspection handle. Only an original handle from that invocation
can select its saved response. Evidence passed to the callback is single-use
within that invocation; repeated validation and returning inspected raw evidence
fail explicitly. Handles cannot transform the selected response.

Public parser, call, and query bodies remain mutable. The saved response stays
private until handoff, so inspection cannot change data after validation and
before return or caching. Public mutability after handoff does not make shared
cache mutation safe. Copying and freezing inspection data happens only on the
scoped path, inside the application's selected budget. Callback state closes on
executor settlement and releases saved response trees after every outcome.
Applications own clocks, attempt/total budgets, and transport recovery. The
optional cancellation mapper belongs to this execution boundary, preserves
original reasons by default, and supplies no delivery classification. TanStack
separately owns query cancellation and state reversion.

One application-owned adapter can connect an existing transport's parser hook to
the validation callback. POM does not require a second transport or a raw-response
API when that hook already supplies the observed response. Applications can adopt
generated calls independently of generated query factories, retaining their
existing cache keys, domain ownership, and mutation effects.

Optional query factories derive their keys and requests from one validated input
snapshot. The context passed to the executor must preserve the identity encoded
by the key, including after JSON serialization. Applications supply the API
namespace, nonsecret response-changing cache context, executor, and session-cache
lifecycle. Query options can wait for required inputs using TanStack's skip token
while retaining explicit, validated context. A skipped query must not execute on
mount, invalidation, or manual refetch. Real inputs still validate immediately.
Public operation filters match every parameter variant within one namespace,
client, operation, and complete canonical context; matching across contexts must
be explicit. These identities must survive JSON hydration. Envelopes remain the
default; explicit body storage uses separate cache families and excludes any
operation with a bodyless success. Complete response and pagination validation
precedes body projection. Family filters retain their scope; operation-wide
invalidation spans the six known families without combining their stored-data
types. Applications select a representation centrally and own invalidation policy
and updates to any intentionally coexisting caches. POM neither deduplicates
requests nor synchronizes direct writes across those cache identities.

Infinite-query bindings explicitly select a cursor or offset profile and required
response fields across every success status. Validate the
complete binding before emission. Infinite factories use a cache family separate
from ordinary queries, preserve one base-input/context snapshot across pages,
and validate each assembled page request and its exact-status response. Initial
cursor requests omit the cursor; a null response cursor or a repeated retained cursor
ends pagination. Empty strings remain real cursors. Item selection preserves
page order and duplicates. Offset requests start at integer zero and advance by
the last response's offset plus its actual item count, preserving progress after
page eviction. Empty pages or reaching the reported total end offset traversal.
Validate safe integer metadata, matching response offsets, item counts and
arithmetic before caching success. Offset and cursor caches have distinct
families and retain numeric and string/null page parameters respectively.
Applications own eviction, deduplication, rendering, and consistency while records
change between requests.

Generated query functions delegate transport work, forward cancellation, and
validate response evidence before returning the selected success representation. They do not
resolve credentials or add an automatic retry budget.
Query cache integration must preserve all supported response data, including
dynamic map entries and raw header names with prototype-related names, across
refetches. Share equal plain data without changing keys, prototypes, property
flags, cycles, or repeated references. A failed HTTP or protocol result must not
become successful query data. Per-operation error guards retain exact declared
failure types and require validated provenance for the same generated operation,
client, and namespace.

Pomegranate never starts a backend, reads a database, discovers another checkout,
fetches a remote contract, or selects an authentication provider. Applications
produce their input before invoking the compiler. A passing drift check proves
agreement with that input; the application must separately check that its export
still agrees with the backend.

## One contract interpretation

Validate the input and build one complete normalized model before emission. Types,
validators, builders, and protocol helpers must derive from that model. A declared
operation or response must be represented or rejected with a useful diagnostic;
unsupported semantics must not disappear or become weaker validation.
Bound schema structure and generated validator expression complexity before
entering native formatting. Excess complexity receives a contract diagnostic;
annotation values such as defaults are not generated expressions.

Terminal reference resolution is cached within each normalized descriptor.
Intermediate defaults and sibling constraints still receive context-specific
validation; compiling a mutable input document again creates a fresh descriptor.

Use one versioned metadata format: document-level `x-pom-policy` declares policy,
and operation-level `x-pom` selects it. Applications adapt to this format. Keep
project names, exception names, auth providers, and package aliases out of the
compiler.

Requests reject unknown fields in fixed objects and invalid values when a builder
is called. Responses strip additive fields from fixed objects while rejecting
missing required values, changed types, and unsupported enum values. Declared
dynamic maps validate and preserve every entry. Prepared JSON bodies and native
file references must not retain mutable caller objects. Browser file objects may
retain identity; their bytes are immutable. Multipart builders retain all
declared fields. Applications own file access, serialization, progress, and
creation of fresh bodies for retries.
Multipart text must already use CRLF line endings so standard FormData
serialization preserves the value that passed its schema. Reject isolated CR/LF
rather than normalizing caller text into a different contract value.

Request defaults are annotations and must not supply omitted values or change
requiredness. Reject defaults throughout response schemas, including referenced
schemas; defaults must not fabricate a valid response. Keep optional TypeScript
properties consistent with runtime omission and explicit `undefined` behavior.

Represent responses in one table keyed by the exact HTTP status. A body valid for
one status does not validate another status unless both declare that schema.
Protocol failures retain the observed status and headers so the application can
interpret known HTTP evidence. The generated helper does not turn HTTP errors
into an application-specific exception policy.

## Security and client projection

Auth labels bind to a transport requirement, `none` or `bearer`. Cross-check each
binding against effective OpenAPI security without assigning business meaning to
a label or provider meaning to a security scheme name. Applications retain token
resolution, readiness checks, and authorization behavior.

Preserve [OpenAPI security inheritance](https://spec.openapis.org/oas/v3.1.0.html#operation-object):
an operation's own security declaration replaces the document declaration.
Explicit public overrides must not inherit bearer requirements accidentally.
Unsupported alternatives, combined schemes, or role restrictions must receive
diagnostics rather than being reduced to a weaker credential requirement.

Validate every declaration and operation before selecting clients. Each operation
has explicit surface membership; unselected membership does not exempt it from
validation. Project each selected client with only the transitive schemas needed
by its requests and responses, retaining direction-specific validation. A client
must not import another client's operation or schema modules. Shared generic
runtime code is independent of client membership.

Selected query modules reference individual operation and schema declarations.
Bundlers can remove unused declarations without changing the shared instances or
frozen full-client aggregates. Only audited validator/operation construction and
fresh aggregate freezing carry purity annotations; parsing and application
callbacks remain observable runtime work.

Surfaces control the generated import boundary. They are not authorization
boundaries, and generating a bearer requirement does not obtain or verify a token.

## Determinism and output ownership

Resolve paths from the configuration file, without executable configuration or
host formatter settings. Render and validate the complete output set before
writing. Identical supported inputs and compiler versions must produce identical
bytes.

Resolve existing configured output parents to their real location once, retaining
any missing directory suffix. Use that canonical output root throughout checking,
locking, generation, and recovery. Parent aliases such as macOS `/tmp` select a
location; the output directory itself and owned target files must not be symlinks.

The output manifest records the compiler-owned inventory. Generation must detect
ownership conflicts before replacing files, preserve unrelated files and modified
generated files, and remove stale files only when their prior ownership and
unchanged contents are established. Reject generated paths that overlap inputs
or escape the intended output through traversal or symlinks.
Treat inventory names that differ only in ASCII case as aliases on every
platform. Reject them before planning replacements or stale-file deletion.

`check` is read-only, including on failure. It must report missing, changed, and
stale outputs. It cannot promise a transaction across the filesystem; interrupted
generation must be detectable, and recovery must preserve files whose ownership
or contents are uncertain.

## Consumer adoption

Consumer adoption requires application-owned evidence beyond compiler and
installed-package checks:

- Use application-owned scalar parity and complete contract inventories as
  adoption gates. Extend remaining forms only for demonstrated consumer needs.
- Migrate each application completely to the canonical generated API and run its
  required integration checks, preserving transport and platform behavior.

Adopt individual call sites incrementally while regenerating the complete output
set from one compiler version. Remove thin endpoint wrappers as their callers
migrate; retain wrappers that implement domain behavior. Shared setup has a fixed
cost, so a small pilot can increase handwritten code. A compatibility experiment
does not establish net maintenance savings, a full application migration, or
device performance acceptance.

Keep those requirements distinct from the currently supported vocabulary. A new
capability needs observable tests and an honest diagnostic for its unsupported
neighbors; it does not require a general extension framework.
