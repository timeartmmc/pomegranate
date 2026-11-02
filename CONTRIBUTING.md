# Contributing

Use Node.js 26.x and the Bun version pinned in `package.json`. Install the locked
development dependencies and the Chromium headless shell, then run the complete
verification command from the repository root:

```sh
bun ci
bunx playwright install --with-deps --only-shell chromium
bun run verify
```

Bun owns dependency installation, script dispatch, and tarball packaging;
`bun.lock` is the sole lockfile. Keep development Node types on Node 26. CI runs
this command on Node 26 and the advertised Node 22.18.0 and 24.0.0 minimums.
Consumer requirements belong in the [README](README.md#use-pom-in-a-project).

`verify` checks formatting, builds the package, prepares generated test signatures,
then runs strict types, type-aware lint, compiler/runtime tests, Chromium
integration, example drift/execution, and an isolated packed install. Keep CI and
this command aligned. Tests use Node's runner with a 30-second default timeout.

Use Oxlint for JavaScript/TypeScript linting and Oxfmt for supported-file
formatting. Enforce both through `verify`. Strict types and lint cover compiler,
example, tests, fixture helpers, scripts, and dependency declarations. Tests use
`noEmit` and `erasableSyntaxOnly`; Node executes their TypeScript directly.
`test:prepare` writes real signatures to ignored `test/.generated` directories;
runtime tests generate fresh temporary outputs. Consumer type fixtures retain
positive and expected-error cases through actual consumer compilation. Generated
modules are excluded from lint and use the pinned formatter's explicit options,
independent of host configuration.

Bundle regressions use the pinned esbuild dependency and repository Bun version.
They compare minified browser ESM output and execute the retained contracts,
including sparse ordinary/cursor/offset queries and browser/native multipart.
Size assertions cover retention behavior; runtime timings have no CI thresholds.

## Required coverage

Test observable guarantees and meaningful failure paths across these boundaries:

- Contract interpretation: accepted values, rejected neighboring forms, scalar
  contradictions, defaults, maps, constrained references, tagged unions, nullable
  values, and agreement between types and validators. `schema-oracle.test.ts`
  compares supported cases with Ajv2020 without rewriting references or `oneOf`.
  Ajv is a development dependency; generated validation uses the native runtime.
- Input and selection: equivalent JSON/YAML, shared YAML policy, BOMs, duplicate
  keys, malformed UTF-8, security inheritance, unsupported unselected operations,
  and transitive client/standalone projection.
- Output ownership: complete rendering before writes, clean builds, deterministic
  bytes, read-only drift, protected inputs, parent aliases, symlinks, modified or
  unrelated files, stale cleanup, and interrupted-generation recovery.
- Execution: every supported method, required/optional inputs, JSON and complete
  browser/native multipart bodies, exact statuses, scoped error provenance,
  snapshots, and application-owned recovery, retries, deadlines, and session fencing.
- Queries: canonical identities, complete-context filters, skip transitions,
  typed errors including registered `unknown` errors, hydration, failed-refresh
  retention, and independent envelope/body caches across all six families.
- Pagination: encoded and empty cursors, retained cycles, failed later pages,
  fetch/ensure/prefetch APIs, whole-list refetch, eviction, concurrency, zero-origin
  offsets, short/empty pages, shrinking totals, matching offsets, and safe arithmetic.
- Sharing: equal/changed selections, deep JSON, special map/header names,
  prototypes, property flags, key order, cycles, repeated references, unsupported
  selections, and preservation of inputs.

Execution/cache changes must cover raw/scoped executors with ordinary, cursor,
and offset factories in envelope/body modes. Check one body read, JSON parse and
schema pass per inspected response; complete validation inside controlled attempt
and total budgets; frozen inspection isolation with mutable final bodies;
single-use evidence; foreign/copied handles; callback expiry; parser/context
capture; and cleanup after every outcome. Cancellation includes pre-abort, late
success/rejection, falsy reasons, undefined rejection, mapper failure, and the
difference between a mapped query-function error and Query Core cancellation.

Body-cache coverage includes every success status, bodyless exclusion, JSON null,
bound pagination failures, typed cold writers, immutable writes, hydration, and
central sharing before options exist. Operation-wide invalidation must span all
six known families and complete contexts. Coexisting caches make independent
requests and do not synchronize direct writes.

Chromium tests use real Fetch against a local synthetic server and mount React
query, infinite-query, and mutation hooks. Cover render counts, readiness,
identity changes, scoped invalidation, failed refetches, special maps, and
cancellation with late results. Run the raw/scoped and envelope/body combinations;
older envelope-only browser success does not cover those paths.

## Installed consumers and declarations

The packed consumer installs through npm with strict engine/peer checks, minimum
Query Core, TypeScript 5.7.3, and Node 22 types, with no schema library installed. Source tests use pinned
development dependencies. Verify core and execution-only output before installing
TanStack. Run generated TypeScript on Node and Bun and emitted JavaScript on Node
after removing the compiler, formatter, and YAML parser. No sibling checkout or
source symlink may supply the runtime.

Compile native uploads without DOM libraries or browser file globals. Query-only
ordinary/cursor/offset output must need no AbortController, Node, or DOM types;
supply the platform signal, callback, and URL declarations explicitly. Keep
dependency declaration checking enabled and supply `VoidFunction` where needed.

Emit declarations for generated modules and inferred application exports of
clients, adapters, factories, options, keys, filters, guards, and sharing helpers.
Typecheck a separate consumer that resolves no original generated sources.
Include reusable scoped adapters across independent outputs, explicitly annotated
raw/bodyless `Execution` adapters, readonly inspection edits, and body-cache APIs.
Repeat with the packed minimum dependencies. Verify packaged/generated licenses,
allowed inventory, clean `dist`, and `noPropertyAccessFromIndexSignature`.

Parser changes must retain checked return bodies, exact contract types, the
`parse`/`safeParse` facade, useful aggregate diagnostics, and component-local names.
Check observed array counts and effective bounds before any item read, including
aliases and arbitrary JSON. Keep wide objects, large literal enums, long aliases,
and corrupted-return type controls covered on both supported TypeScript lines.
Wide publication coverage includes 1,024-field objects, 2,048-member literal enums,
schema registries and inferred client/query wrappers, with producer sources removed
before downstream checking.

## Measurements and adoption

Use `node scripts/benchmark-execution.ts [baseline-ref]` for handwritten/generated
binding, size, typecheck, and runtime comparisons (default baseline: `HEAD`). Use
`node scripts/benchmark-query-sharing.ts` for sharing comparisons. Timings are
local evidence, never machine-dependent CI thresholds. Keep dated results separate
from current usage; the source checkout retains the
[verification and measurement summary](md/history/2026-11-01-verification.txt).

Application adoption needs its own parity/integration checks and declared time
and memory budgets. Measure generated/retained bundle size, typecheck, parsing,
copying/freezing, sharing, allocations, and handwritten integration LOC against
both the existing approach and a shared-helper baseline. Count bridges,
configuration, cache writers, and remaining wrappers. Compiler checks establish
neither application savings nor budget acceptance; report these as unassessed
without evidence. A status-only transport need not benefit from scoped validation.

Exercise the existing transport through one shared adapter before proposing
transport changes. Keep real contracts, application patches, and detailed consumer
reports outside this public checkout. Select queries independently of direct calls;
when selected, verify one compatible Query Core resolution across framework and
persistence adapters in the consumer lockfile.

## Make a change

The source checkout's [sprint proposal](SPRINT_PROPOSAL.txt) owns the proposed
mutation and nullable-cursor milestones. [Future proposals](FUTURE_PROPOSALS.txt)
hold deferred capabilities and decisions; neither document describes shipped work.

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
