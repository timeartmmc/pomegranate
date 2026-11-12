# Architecture

POM compiles a local API contract into TypeScript. This document describes its
design rules. See the [reference](REFERENCE.md) for supported inputs and
generated APIs, and [Contributing](CONTRIBUTING.md) for checks and releases.

## Ownership

| POM maintains                                                        | Applications provide                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Contract interpretation, compiler models, generation and diagnostics | API schemas, operation policy and matching scalar rules                     |
| Generated types, validators, builders and protocol helpers           | Transport, serialization, credentials, retries, deadlines and domain errors |
| Reproducible output and its file manifest                            | Generated artifacts, cache updates and integration tests                    |

POM reads supplied local inputs. It does not discover application repositories,
call their backends, read databases, fetch remote contracts or implement
authentication providers. Output checks compare generated files with their
inputs; applications test their running APIs.

Applications select and expand server URLs, append the generated paths, choose
credentials and apply operation policy. Generated requests pass security
requirements and any server overrides to the transport. Policy describes labels,
types and required fields; it does not implement authorization, retries or
timeouts. Use one policy format and generated API across applications, with
domain behavior in application adapters.

## One contract interpretation

Validate the complete document before selecting output, including unused
components and unselected operations. Normalize OpenAPI 3.0 and 3.1 into one
compiler model used by types, validators, builders and protocol helpers. Reject
unsupported declarations with a useful error; never silently drop an operation
or response.

Keep input normalization, reference analysis and compile-time schema checks
separate. Generated validators check application payloads at runtime.

Internal metadata records have own fields for every setting, using defaults or
`undefined` for absence. Accept sparse configuration at input boundaries. Use
`Map` for compiler tables indexed by contract names. Runtime policy, security,
context and header dictionaries have null prototypes so inherited values cannot
supply metadata. Application payloads follow their separate field rules.

Validate source schemas, resolve supported `allOf` compositions, then derive
request and response schemas. Composition must preserve every constraint and
closed-object rule. Scalar plans retain distinct patterns, formats and
`multipleOf` assertions through aliases. Excluding every directional field must
leave a fixed object, rather than turn it into a map. Use the resulting schemas
for validation, dependency selection, types and protocol bindings.

Allow reference cycles that descend through object properties, array items or
map values. Reject cycles through aliases, unions or composition that revisit
the same value. Recursive validators must bound depth and work, reject input
cycles and return separate copies for shared children in different positions.
Generated recursive types and parsers must initialize without reading
application data.

Reserve collection work before allocating results, and bound normalization,
schema depth, generated expressions, input reads and output size before
expensive work. Validate annotation payloads separately. Limits must give errors
that help authors reduce or split the contract. These bounds do not cap process
memory, arbitrary getters, proxies or regular-expression execution time. Exact
limits belong in the [reference](REFERENCE.md#supported-vocabulary).

Each client includes only its transitive request and response dependencies; it
must not import another client's operations or schemas. Shared runtime helpers
do not depend on client selection. Surfaces select generated imports; servers
enforce authorization.

Discover type declarations independently of client membership, starting from
public types and inline parser annotations. Share declarations only between
outputs that need them, without pulling unrelated types into those outputs.

Generated parsers declare contract types independently of validator inference.
Check parser bodies and field tables against those types. Keep the justification
for necessary type assertions beside the runtime code. Shared scalar and
container rules must give references, standalone validators and operations the
same behavior. An invalid return or recorded issue must fail validation at every
public boundary.

## Generated runtime boundaries

Applications run generated code and its declared dependencies. Shared helpers
are copied into each output set. Core and direct-call modules have no package
runtime dependencies; query modules require Query Core.

Requests and responses use their respective schemas. Validation copies JSON and
native file references; response bodies remain mutable. Immutable browser files
may retain identity. Response parsing selects one status and media declaration,
preserves the observed status and headers, and reports validation failures
without trying a less specific declaration. The
[reference](REFERENCE.md#response-evidence) defines that selection order.

[Executable clients](EXECUTION.md) validate the selected response once. Scoped
inspection uses a detached readonly view and keeps the saved response private
until return. Applications supply clocks, retry budgets, delivery classification
and cancellation.

[Query factories](QUERIES.md) use the same executor. Capture input and context
before execution, then build keys from those values. Preserve key identity
through JSON hydration. Validate responses and pagination metadata before
caching or extracting the body. Keep cache representations separate, preserve
supported map and header keys during sharing, and accept operation-specific
errors only from validated results. Applications handle invalidation, direct
writes, session cleanup and consistency between requests.

## Determinism and output ownership

Resolve paths from the real configuration directory and resolve symlinks in
existing output parents. Do not execute configuration or read application
formatter settings. Identical supported inputs and compiler versions must
produce identical bytes. Use the pinned formatter, format modules sequentially,
and render and validate the complete output set before writing.

The manifest records generated files and their hashes. Warn before replacing
edited generated files. Delete a stale file only when its recorded hash matches;
preserve unrelated or uncertain files. Without a valid manifest, the exact POM
banner can establish ownership for replacement, but never authorize stale
deletion. Generated paths must not overlap inputs, escape the output directory
or collide ignoring ASCII case. Output directories and generated target files
cannot be symlinks.

`check` must be read-only on success and failure. Generation replaces individual
files and writes the manifest last; it does not replace the directory
atomically. After interruption, regenerate from current inputs and preserve
uncertain files. See [output recovery](REFERENCE.md#generated-output) for
manifest and lock handling.

## Application adoption

Migrate call sites incrementally while generating the complete output set with
one compiler version. Keep wrappers with domain behavior; remove wrappers that
only forward calls as their callers migrate. Query factories can be adopted
independently of direct calls and require changes to cache access.

Applications need their own contract, platform, scalar and integration checks.
Measure maintenance costs and device budgets using the [measurement
guidance](CONTRIBUTING.md#measurements-and-adoption).
