# Architecture

POM reads a local contract and generates a client API. This document describes
the compiler's boundaries. Use the
[contract reference](REFERENCE.md) for supported syntax and current behavior, and
[Contributing](CONTRIBUTING.md) for verification and releases.

## Ownership

| POM owns                                                                | Applications own                                                             |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Contract interpretation, normalized models, generation, and diagnostics | API schemas, exported operation policy, and scalar parity                    |
| Generated types, validators, builders, and protocol helpers             | Transport, serialization, credentials, retries, deadlines, and domain errors |
| Deterministic output and its owned inventory                            | Generated artifacts, cache lifecycle, domain effects, and integration tests  |

POM never discovers consumer repositories, invokes their backends, reads their
databases, fetches remote contracts, or implements authentication providers.
Applications provide the inputs. Drift checks compare generated files with
those inputs; they do not test a running backend.
Server configuration belongs to the application transport: applications select
and expand endpoints and append the generated contract paths. Generated requests
only pass Path Item and Operation server overrides through to that transport.

Use one versioned policy format and generated API across applications. Keep
application-specific behavior in adapters. OpenAPI security preserves inherited
requirements, scheme identities, OAuth scopes, anonymous alternatives, and OR/AND
structure. Optional auth labels must agree with the effective security transport,
including its composite form. Applications select an allowed alternative and
manage every credential; generated code never obtains or injects credentials.
Policy fields declare
types, enums, and requiredness; applications implement authorization, retries,
and timeouts. Builders and executors share one generated policy declaration.
Every operation must declare surface membership through either inline metadata
or configuration.

## One contract interpretation

The compiler validates the complete JSON or YAML document before selecting output.
It converts OpenAPI 3.0 syntax to the same schema vocabulary used for 3.1. Types,
validators, builders, response parsers, and optional helpers use one normalized
descriptor. Every operation and response must be represented or rejected with a
useful diagnostic, including declarations excluded from selected clients.

Fixed metadata records materialize every setting as an own field, including
explicit defaults or `undefined` for absence. Keep sparse source and public
configuration types at normalization boundaries; internal code consumes complete,
kind-specific records. Use `Map` for internal tables indexed by contract names.
Runtime policy, security, context, and header dictionaries use null prototypes
so inherited data cannot supply omitted metadata. Application payloads have their
separate structural field policy; do not normalize them as compiler settings.

Validate source declarations before projecting request and response fields.
Resolve supported `allOf` compositions before directional projection. Preserve
every branch's constraints and explicit object closure; combining fields must
not widen a closed branch or discard constraints on overlapping properties.
Derive object construction after resolving openness, closure, fields, and bounds.
Scalar validation plans combine bounds and literals and retain each unique
pattern, format, and multiple assertion, independent of reference ancestry.
Use those projected schema graphs for usage validation, dependency selection,
types, parsers, and protocol bindings. Keep fixed-object identity when projection
excludes every property.
Support local reference cycles that descend through object properties, array
items, or map values. Reject cycles that only revisit the same value through
aliases, unions, or composition before selecting outputs. Recursive validators
must bound depth and work, reject active-ancestor cycles, and preserve separate
detached outputs for shared children in different positions. Generated recursive
types and parsers must initialize safely without executing consumer data.
Bound work within schema normalization and reserve collection work before
constructing results. Opaque annotation payloads retain their own
validation. Diagnose excessive work with guidance to reduce or split the input
contract, or use component references for repeated inline schemas.

Client projection retains only transitive request and response dependencies.
Client modules must not import another client's operations or schemas. Shared
runtime code is independent of surface membership. Surfaces govern generated
imports; servers remain responsible for authorization.

Canonical type discovery is independent of consumer membership. Seed each client
and standalone module with its public types and directional inline parser
annotations, then derive its type closure from emitted declaration links and
group declarations with the same consumers. This keeps shared type bodies
without importing unrelated declarations through a shared module.

Keep contract types independent of validator inference. Generated named parsers
declare independent output types, checked against return bodies or typed
constructor tables. Fixed-object construction and literal membership use narrow
assertions in the shared runtime; keep their proof obligations beside the code.
The emitter remains responsible for complete tables and correct constraints.
Parsers report invalid values through the shared issue sink. An invalid return
or recorded issue must fail at every public and protocol boundary.
Use shared scalar and container rules so constrained
references, standalone roots, and operation schemas retain one interpretation.
Keep non-obvious implementation rationale beside the owning code.

Bound schema structure, generated-expression complexity, input reads, and output
size before expensive traversal or formatting. Format modules sequentially.
These limits bound supported work; they do not establish a fixed process memory
ceiling or bound arbitrary getters, proxies, and regular expressions. Exact
limits belong in the [reference](REFERENCE.md#supported-vocabulary).

## Generated runtime boundaries

Applications run generated code and its declared runtime dependencies. Shared
helpers are copied into each output set. Core and direct-call modules remain
independent of TanStack and React; query modules require Query Core.

Requests and responses retain direction-specific validation. Validated JSON and
native file references must not retain mutable caller data. Immutable browser
files may retain identity. Protocol interpretation uses one response table, in
which an exact status takes precedence over its range and a range over
`default`, and preserves observed HTTP evidence on failures. The application
decides what those failures mean.

[Execution](EXECUTION.md) is a validation boundary around an application executor.
It must validate a selected response once. Scoped inspection keeps the saved
response private until handoff, using a detached readonly view for recovery;
public response bodies remain mutable. Applications own clocks, attempt and total
budgets, delivery classification, and transport cancellation.

[Query integration](QUERIES.md) adds cache identity and pagination, not a second
transport. Keys and executor context derive from one validated snapshot and must
preserve identity through JSON hydration. Validate the full response and bound
pagination metadata before storing success or projecting its body. Keep distinct
cache representations separate, preserve supported map/header data during
sharing, and require validated provenance for operation-specific error guards.
Applications own invalidation, direct cache writes, session removal, and
consistency while records change.

## Determinism and output ownership

Resolve paths from the real configuration file and canonicalize existing output
parents. Do not execute configuration or read consumer formatter settings.
Identical supported inputs and compiler versions must produce identical bytes.
Render and validate the complete output set before any write.

The manifest records ownership and content hashes. Warn before replacing edited
owned targets; preserve unrelated files and edited or uncertain stale files.
Remove stale output only when a recorded hash proves it is unchanged. Without a
valid manifest, recover ownership only from the exact generated source banner;
the banner alone never authorizes stale deletion.
Generated paths must not overlap inputs, escape the intended output, or alias
another inventory name ignoring ASCII case. Output directories and owned target
files must not be symlinks.

`check` is read-only on success and failure. Generation replaces individual files
rather than claiming filesystem-wide atomicity. Interrupted work must be
detectable through output drift. Regenerate from current inputs after an
interruption; preserve uncertain stale files instead of replaying an earlier
output set. See the [output reference](REFERENCE.md#generated-output) for
manifest, lock, and recovery instructions.

## Application adoption

Adopt call sites incrementally while generating the complete output set with one
compiler version. Keep wrappers that implement domain behavior; remove thin
wrappers as their callers migrate. Query factories require their own cache-access
migration and can be adopted independently of direct calls.

Applications need their own contract, platform, scalar, and integration checks.
Measure maintenance costs and device budgets in the application. Use the
[measurement guidance](CONTRIBUTING.md#measurements-and-adoption) to assess adoption.
Keep improvements proportional to their permanent complexity, with observable
tests and explicit diagnostics for unsupported neighboring forms.
