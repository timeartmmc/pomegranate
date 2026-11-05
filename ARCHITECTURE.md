# Architecture

POM interprets an explicit local contract and generates a self-contained client
API. This document explains its design constraints. Use the
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
Applications produce inputs before invoking the compiler. A passing drift check
establishes agreement with those inputs, not agreement with a running backend.
Document-level server configuration belongs to the application transport:
applications select and expand endpoints and append the generated contract paths.

Use one versioned policy format and one generated API across applications. Adapt
consumers to them rather than adding project-specific compiler branches or
retaining obsolete formats. OpenAPI security determines credential transport independently of optional policy
metadata. Declared auth labels must agree with it. Application fields use explicit
scalar types, enums and requiredness; they do not authorize requests or define
retry and timeout behavior. Keep one shared generated policy declaration so
executor boundaries preserve the same types as builders. Surface membership has
one explicit owner, inline or configuration, and must classify every operation.

## One contract interpretation

The compiler reads JSON or YAML, validates the complete document, and builds one
normalized descriptor before selecting output. OpenAPI 3.0 input syntax is
lowered at the document boundary into the same schema vocabulary as 3.1;
dialect differences do not enter the descriptor, emitters, or generated runtime. Types, validators, builders,
response parsers, and optional helpers derive from that descriptor. Every
operation and response must be represented or rejected with a useful diagnostic,
including declarations excluded from the selected clients.

Directional fields produce request and response schema graphs before usage
validation, closure and emission. Validate all source declarations first, then
use the same projected graph for types, parsers and protocol bindings. Preserve
fixed-object identity when every property is excluded.

Client projection retains only transitive request and response dependencies.
Client modules must not import another client's operations or schemas. Shared
runtime code is independent of surface membership. Surfaces govern generated
imports; servers remain responsible for authorization.

Keep contract types independent of validator inference. Generated named parsers
must have checked return bodies and report invalid values through the shared
issue sink. An invalid return or recorded issue must fail at every public and
protocol boundary. Use shared scalar and container rules so constrained
references, standalone roots, and operation schemas retain one interpretation.
Keep non-obvious implementation rationale beside the owning code.

Bound schema structure, generated-expression complexity, input reads, and output
size before expensive traversal or formatting. Format modules sequentially.
These limits bound supported work; they do not establish a fixed process memory
ceiling or bound arbitrary getters and regular expressions. Exact limits belong
in the [reference](REFERENCE.md#supported-vocabulary).

## Generated runtime boundaries

Applications run from generated code and declared runtime dependencies, without
the compiler. Author generic helpers in POM and copy them once into an output
set; a separate runtime package is unnecessary. Core and direct-call modules
remain independent of TanStack and React. Query modules declare their Query Core
dependency.

Requests and responses retain direction-specific validation. Validated JSON and
native file references must not retain mutable caller data. Immutable browser
files may retain identity. Protocol interpretation uses one exact-status response
table and preserves observed HTTP evidence on failures. The application decides
what those failures mean.

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

The manifest is the compiler's ownership record. Detect conflicts before
replacing files; preserve unrelated files and modified generated files. Remove
stale output only when prior ownership and unchanged contents are established.
Generated paths must not overlap inputs, escape the intended output, or alias
another inventory name ignoring ASCII case. Output directories and owned target
files must not be symlinks.

`check` is read-only on success and failure. Generation replaces individual files
rather than claiming filesystem-wide atomicity. Interrupted work must be
detectable, and recovery must preserve uncertain ownership and conflicting edits.
See the [output reference](REFERENCE.md#generated-output) for manifest, journal,
lock, and recovery instructions.

## Application adoption

Adopt call sites incrementally while generating the complete output set with one
compiler version. Keep wrappers that implement domain behavior; remove thin
wrappers as their callers migrate. Query factories require their own cache-access
migration and can be adopted independently of direct calls.

Compiler and installed-package checks do not establish application parity,
maintenance savings, or device budget acceptance. Applications need their own
contract inventory, scalar parity, platform checks, and integration tests. Use the
[measurement guidance](CONTRIBUTING.md#measurements-and-adoption) to assess adoption.
Add capabilities for demonstrated needs, with observable tests and explicit
diagnostics for unsupported neighboring forms.
