# Architecture and requirements

Pomegranate compiles explicit local OpenAPI into application-owned TypeScript
artifacts. The [README](README.md) describes the current supported vocabulary.
This document owns the boundaries and guarantees that changes must preserve.

## Ownership

| Owner          | Responsibility                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application    | API schemas, OpenAPI export, operation policy, generated artifacts, transport, authentication, retries, deadlines, error interpretation, platform adapters, and integration tests |
| Pomegranate    | Supported contract interpretation, one normalized model, generation, diagnostics, drift detection, and generated-output ownership                                                 |
| Generated code | Types, request validation, URL construction, and exact-status response validation without network I/O                                                                             |

The compiler is a development dependency. Generated modules use relative imports
and declared runtime dependencies; applications must not import the compiler at
runtime. Policy labels describe application choices. They do not implement those
choices or establish authorization.

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

Use one versioned metadata format: document-level `x-pom-policy` declares policy,
and operation-level `x-pom` selects it. Applications adapt to this format. Keep
project names, exception names, auth providers, and package aliases out of the
compiler.

Requests reject unknown fields and invalid values when a builder is called.
Responses strip additive object fields while rejecting missing required values,
changed types, and unsupported enum values. Defaults must not fabricate a valid
response. Keep optional TypeScript properties consistent with runtime omission
and explicit `undefined` behavior.

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

Surfaces control the generated import boundary. They are not authorization
boundaries, and generating a bearer requirement does not obtain or verify a token.

## Determinism and output ownership

Resolve paths from the configuration file, without executable configuration or
host formatter settings. Render and validate the complete output set before
writing. Identical supported inputs and compiler versions must produce identical
bytes.

The output manifest records the compiler-owned inventory. Generation must detect
ownership conflicts before replacing files, preserve unrelated files and modified
generated files, and remove stale files only when their prior ownership and
unchanged contents are established. Reject generated paths that overlap inputs
or escape the intended output through traversal or symlinks.

`check` is read-only, including on failure. It must report missing, changed, and
stale outputs. It cannot promise a transaction across the filesystem; interrupted
generation must be detectable, and recovery must preserve files whose ownership
or contents are uncertain.

## Next demonstrated needs

The compiler and installed-package workflow do not complete extraction into
existing applications. Subsequent work must be driven by a concrete consumer and
tested before adoption:

- Extend the schema vocabulary, including nullable unions, formats, dynamic maps,
  and application-owned scalar parity tests.
- Add browser and native multipart contracts. Applications retain file access,
  serialization, progress, and retry-body creation.
- Generate standalone non-HTTP validators with their transitive schemas.
- Migrate each application completely to the canonical generated API and run its
  required integration checks, preserving transport and platform behavior.

Keep those requirements distinct from the currently supported vocabulary. A new
capability needs observable tests and an honest diagnostic for its unsupported
neighbors; it does not require a general extension framework.
