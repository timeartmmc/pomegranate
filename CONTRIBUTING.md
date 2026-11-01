# Contributing

Use Node.js 26.x and the Bun version pinned in `package.json`. Install the locked
development dependencies and the Chromium headless shell, then run the complete
verification command from the repository root:

```sh
bun ci
bunx playwright install --with-deps --only-shell chromium
bun run verify
```

Bun owns repository dependency installation, script dispatch, and tarball
packaging; `bun.lock` is the sole lockfile. Keep development Node types on the
Node 26 major. CI runs the complete verification command on Node 26 and on the
advertised Node 22.18.0 and 24.0.0 minimums. Use `bun run test` to invoke the
declared Node test command with a 30-second default timeout. Consumer
requirements belong in the [README](README.md#use-pom-in-a-project).

`verify` checks formatting, builds the package, prepares generated test signatures,
and runs strict typechecking and type-aware lint before the compiler and runtime
tests. It exercises generated code through Chromium Fetch against a local
synthetic server, checks and runs the synthetic example, and exercises a packed
install in an isolated consumer. That consumer installs through npm with strict
engine and peer checks, using the minimum supported Zod and TypeScript 5.7.3
with Node 22 types. It checks equivalent JSON/YAML generation, shared
YAML policy reuse, BOM-prefixed JSON inputs and configuration, parent-directory
aliases, scalar contradiction diagnostics, and malformed-input failures.
Source tests use the pinned development releases. After removing the
compiler, formatter, and YAML parser, the installed-package check runs generated
TypeScript directly on Node and Bun and emitted JavaScript on Node. It must not
rely on a sibling checkout or a source symlink. Keep CI and this command aligned.
Builds recreate the compiler-owned `dist` directory so removed source modules
cannot survive into a package. The packed-install check also verifies this
cleanup and compiles generated clients with `noPropertyAccessFromIndexSignature`.

Query checks exercise generated factories with TanStack Query Core and React
Query types, including cache identities, scalar normalization, exact response
statuses, scoped typed error guards, malformed executor evidence, cancellation,
and executor errors. Shared acceptance checks cover structural sharing of equal
and changed data, special map/header keys, deep JSON, property descriptors,
unsupported selections, graph identities, and JSON hydration. The packed consumer
repeats those checks against generated TypeScript and emitted JavaScript after
removing the compiler.
Mounted integration tests bundle fresh generated modules with React DOM and run
real `useQuery` and `useInfiniteQuery` hooks in Chromium. They check render counts
for equal and changed selections, skipped-to-enabled transitions, identity
changes, scoped invalidation, refetch failures, map selections, and cancellation
with late responses. They need no external application or backend.

Infinite-query checks cover empty and encoded cursors, retained cursor cycles,
base-input snapshots, exact statuses, failed later pages, direct Query Client
fetch/ensure/prefetch calls, cancellation, JSON hydration, cache-family isolation,
whole-list refetches, page eviction, concurrent next-page calls, scoped
invalidation, and unsupported binding shapes. The packed consumer repeats the shared
acceptance checks after removing the compiler. Declaration checks include
infinite factories, page collections, item selectors, and an application's
registered `unknown` error type.

Offset checks additionally cover a zero origin, numeric page parameters, short
pages, empty and shrinking totals, malformed metadata, response/request mismatch,
safe integer overflow, and continuation after retained-page eviction. Chromium
hooks and compiler-free installed consumers exercise both pagination profiles.

The packed check first generates queries without TanStack installed, then installs
the minimum supported Query Core version and runs the generated integration after
removing the compiler. Core-only consumers must not require the optional query
dependency.

Executable-client checks cover every supported method, JSON writes, exact success
and failure statuses, scoped cross-API guards, snapshots, cancellation reasons,
application-owned recovery, retries and session fencing, and complete browser/native
multipart inputs. Chromium runs direct calls and mounted query, infinite query and
mutation hooks against one local synthetic server and shared raw executor. Parse
instrumentation checks one body read, JSON parse and schema pass per final response.
Declaration consumers retain positive and expected-error call cases independently
of generated sources. The packed consumer generates, compiles and executes
execution-only output before installing TanStack, compiles native output without
DOM libraries, and repeats shared execution checks after removing the compiler.
An additional query-only check excludes both Node and DOM types, supplying only
the existing platform signal, callback and URL declarations. This prevents an
unused direct-call helper from expanding the query dependency boundary.
`node scripts/benchmark-execution.ts [baseline-ref]` records a synthetic handwritten-binding
comparison, generated size, typecheck cost and runtime timing, including queries
against the selected Git revision (default `HEAD`); timings are evidence,
not machine-dependent CI thresholds. Dated milestone evidence belongs in
the source checkout's
[dated executable-client record](md/history/2026-10-29-executable-clients.txt),
and [execution/query integration record](md/history/2026-11-01-execution-integration.txt),
separate from current API documentation.

Execution/cache changes must additionally exercise raw and scoped executors with
ordinary, cursor, and offset factories in envelope and body modes. Cover complete
validation inside attempt and total budgets using controlled clocks, without
claiming a speedup for status-only recovery. Check one parse per inspected
response, frozen inspection isolation with mutable returned bodies, single-use
evidence, rejected foreign/copied handles, callback expiry, parser/context capture,
and cleanup after every outcome. Cancellation coverage includes pre-abort, late
success/rejection, falsy reasons, undefined rejection, mapper failure, and the
distinction between a mapped query-function error and Query Core cancellation.

Body-cache checks include every declared success status, bodyless exclusion,
JSON null, bound pagination failures, typed cold writers, immutable updates,
hydration, failed-refresh retention, and central structural sharing before options
exist. Exercise exact-family isolation and operation-wide invalidation across
all six known families and complete contexts. Prove that coexisting representations
make independent requests and do not synchronize direct writes. Mounted hooks and
compiler-free packed consumers must run the new ordinary/cursor/offset combinations;
older envelope-only browser success is insufficient. Type and declaration checks
include explicitly annotated raw/bodyless `Execution` adapters, reusable scoped
adapters across generated outputs, readonly inspection edits, and body cache APIs.

Keep implementation verification separate from application adoption. Record
handwritten integration LOC against the existing approach and a shared-helper
baseline, counting added bridges, configuration, cache writers, and remaining
wrappers. A scoped-validation improvement need not reduce LOC in a status-only
transport. Measure generated/retained bundle size, typecheck cost, parsing,
copying/freezing, sharing latency, and allocations as evidence. Do not invent
machine-dependent pass thresholds. An adopting application supplies its own
performance and memory ceilings before comparison and runs its complete parity
and integration checks. Without that evidence, report adoption as unassessed;
compiler verification alone establishes no application savings or budget pass.
Consumer experiments should exercise the existing transport through one shared
adapter before proposing transport changes. Keep real contracts, application
patches, and detailed consumer reports outside the public POM checkout. Select
query factories separately from direct calls; selecting no queries imposes no
TanStack dependency. When queries are selected, verify one compatible Query Core
resolution across framework and persistence adapters in the consumer's lockfile.

Query declaration checks emit generated modules and inferred application exports
of factories, enabled and skippable options, keys, operation filters, typed error
guards, and the sharing helper, then
typecheck a separate consumer against the emitted `.d.ts` files. They retain
positive and expected-error type cases and verify that the consumer resolves no
original generated sources. Source tests
use the pinned TypeScript release; the packed check repeats this with TypeScript
5.7.3 after removing the compiler.
The query typecheck without DOM libraries supplies the platform's `VoidFunction`
declaration explicitly and keeps dependency declaration checking enabled.

Strict TypeScript checks the compiler, tests, fixture helpers, verification
scripts, and dependency declarations. The test program uses `noEmit` and
`erasableSyntaxOnly`; Node runs the TypeScript test sources directly. Oxlint adds
type-aware checks for compiler, example, test, and script TypeScript, including
unsafe values, Promise misuse, and exhaustiveness.

`test:prepare` writes real generated signatures to ignored `test/.generated`
directories for test typechecking. Runtime tests still generate fresh temporary
outputs. Generated modules are excluded from lint, and the separate consumer type
fixtures retain their positive cases and expected errors through actual consumer
compilation.

Use Oxlint for JavaScript/TypeScript linting and Oxfmt for supported-file
formatting. Keep both enforced by `bun run verify`, preserving the check scopes
above when changing tooling. The pinned Oxfmt API owns generated bytes through
explicit compiler options, independent of consumer formatter configuration.
Generated clients do not import the formatter.

`test/schema-oracle.test.ts` compares emitted request and response validators
with Ajv2020 on selected supported schema cases. The composition fixture crosses
constrained references and tagged unions with nullable values, optional fields,
arrays, and maps; strict consumer types check the same combinations. Ajv follows
the original references and evaluates `oneOf` independently. It treats OpenAPI's
component container and discriminator as annotations, without rewriting schemas.
Ajv is a development dependency; generated code uses Zod.

`test/schema-fixture.ts` supplies synthetic union, map, scalar, and default cases
to both the source tests and the isolated package check. `test/schema-types.ts`
checks their generated TypeScript contracts. These checks do not establish
parity with an application's own scalar validators.

`test/multipart-fixture.ts` exercises the complete upload body, repeated file
parts, browser/native input types, and native execution without browser file
globals. Source and packed-install checks compile native output without the DOM
library, using Node types for `URLSearchParams`. Application-specific file access
and retries still need consumer tests.

## Make a change

This repository keeps only `main`. Review dependency updates manually;
automatic dependency-update pull requests are disabled.
Select new dependency, runtime, and tooling versions only after they have been
published for at least six full days. `bunfig.toml` enforces this for newly
resolved npm packages; existing lockfile entries are unchanged by the age gate.

Read [architecture and requirements](ARCHITECTURE.md) before changing contract
interpretation or generated behavior. Change generated files through their
owning input or emitter. For the synthetic example:

```sh
bun run build
bun run example:generate
bun run example:check
bun run example:run
```

Review the generated diff. Run `bun run format` for human-authored source and
documentation as needed, then run `bun run verify`. Tests import the built
package; rebuild before a focused `bun run test` after changing source.
Rebuild and run `bun run test:prepare` before invoking `typecheck` or `lint`
separately so their generated signatures match the compiler.

Add tests for observable behavior and meaningful failure paths. A new schema or
protocol feature needs positive coverage, a rejected neighboring form, agreement
between emitted types and validators, and an installed-consumer check when it
changes the public API. Output changes need drift and ownership tests. Avoid
tests that only repeat emitter text.

Use synthetic public fixtures. Application repositories own real schemas,
exporters, scalar corpora, transports, and integration checks. A compiler test
does not establish that an application integration is ready.

## Before publication

Consumers install released versions from npm and record the compiler version
and integrity in their lockfile. Use a locally packed tarball to verify
unreleased changes. Regenerate the complete output set with the selected
compiler and its declared runtime dependencies; never mix generated
modules from different compiler builds. An upgrade includes reviewing generated
API changes, adapting every affected caller, and running consumer parity and
integration checks. `pom check` verifies bytes for the installed compiler, not
compatibility with an earlier generated API.

The package is MIT licensed and configured for public npm distribution as
`pomegranate-compiler`. Authenticate an npm account that can publish that
package, and choose an unpublished package version before packing. Verify the
release commit with the complete canonical checks and required consumer checks.
Then inspect and publish the same packed artifact:

```sh
bun pm pack --filename /tmp/pomegranate-compiler-0.3.0.tgz
node scripts/verify-package.ts /tmp/pomegranate-compiler-0.3.0.tgz
bun publish --dry-run --access public /tmp/pomegranate-compiler-0.3.0.tgz
bun publish --access public /tmp/pomegranate-compiler-0.3.0.tgz
```

Use the selected version in the filename. Confirm the registry's version and
integrity after publishing. A GitHub release and an npm release are separate
publication steps; neither replaces verification of the packed install.

The package includes [LICENSE](LICENSE). The copied runtime helpers carry its
complete notice into generated output; retain that notice when redistributing
them. The installed-package check verifies both the packaged license and the
generated helper notices. Generated schemas and application inputs remain
application-owned.

The initial standalone implementation uses earlier application-specific compilers
as behavioral references; its source modules are newly authored. Preserve
accurate source provenance and any required notices when publishing.

Inspect the actual `bun pm pack` inventory before publication. Keep application
contracts, private repository history, credentials, environment files, and local
paths out of the public repository and distribution.
If reusable source is adapted, preserve the notices its license requires.
