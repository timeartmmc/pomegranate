# Contributing

## Verify the checkout

Use Node.js 26.x and the Bun version pinned in `package.json`:

```sh
bun ci
bunx playwright install --with-deps --only-shell chromium
bun run verify
```

Use Bun for installation, scripts, and packaging; `bun.lock` is the sole lockfile.
Keep development Node types on Node 26. CI runs `verify` on Node 26 and
both advertised consumer minimums, Node 22.18.0 and 24.0.0. Consumer setup belongs
in the [README](README.md#quick-start).

`verify` checks formatting, builds the package, prepares generated test signatures,
then runs strict types, type-aware lint, Node tests, Chromium integration,
example drift/execution, and an isolated packed install. Keep CI and this command
aligned. Node tests have a 30-second default timeout.

Use **Oxlint** for JavaScript/TypeScript linting and **Oxfmt** for supported-file
formatting. Both are required by `verify`. Strict types and lint cover compiler,
example, tests, helpers, scripts, and dependency declarations. Tests use `noEmit`
and `erasableSyntaxOnly`; Node executes their TypeScript directly. Generated
modules use the pinned formatter with explicit options and are excluded from lint.
Keep necessary lint exceptions local and explain the behavior they preserve.

For focused checks after changing compiler source, rebuild first. Before running
`typecheck` or `lint` separately, also run `bun run test:prepare` so ignored
`test/.generated` signatures match the compiler. Runtime tests generate fresh
temporary outputs.

For a focused local browser check, run `bun run test:browser` after installing
Chromium with the command above. It rebuilds the compiler and runs
`test/*.browser.test.ts`: real Fetch, multipart files, cancellation, and mounted
query-hook integration. These checks use local fixtures and servers. Keep bulk
schema and cache cases in Node tests; add browser cases for behavior that depends
on browser APIs or mounted hooks. The complete `verify` command includes both.

## Make a change

Read [Architecture](ARCHITECTURE.md) before changing contract interpretation or
generated behavior. Change generated files through their input or emitter. To
refresh the synthetic example:

```sh
bun run build
bun run example:generate
bun run example:check
bun run example:run
```

Review the generated diff. Use `bun run format` for human-authored source and
documentation, then run `bun run verify` before submitting a change. Preserve
concurrent work and avoid broad rewrites of unrelated files.

Review dependency updates manually. New dependency, runtime, and tooling versions
must have been published for at least six full days. `bunfig.toml` enforces that
age for newly resolved npm packages; it does not change existing lockfile entries.

## Verification expectations

Test observable guarantees and meaningful failure paths. A schema or protocol
feature needs accepted cases, rejected neighboring forms, agreement between types
and validators, and an installed-consumer check when the public API changes.
Output changes need drift, ownership, and recovery coverage. Avoid tests that only
repeat emitted text. Keep detailed cases in tests and fixtures.

Check the affected boundaries together:

- Input and contract interpretation: JSON/YAML equivalence, malformed input,
  security inheritance, validation before selection, and transitive projection.
- Validation: scalar and container rules, references, constraints, defaults,
  structural limits, exact types, useful issues, and checked parser returns.
  The schema oracle compares supported cases with Ajv2020, a development dependency.
- Output: deterministic complete rendering, read-only drift, protected inputs,
  aliases and symlinks, conflicts, stale cleanup, and interrupted generation.
- Execution: input snapshots, raw/scoped responses, exact statuses, error
  provenance, single-use evidence, callback cleanup, cancellation, and complete
  browser/native uploads.
- Queries: identity, skip transitions, context filters, error guards, sharing,
  hydration, and ordinary/cursor/offset pagination in envelope/body modes.

Exercise execution and cache changes across raw/scoped executors and both stored
representations. Chromium tests use real Fetch against a local synthetic server
and mounted React query, infinite-query, and mutation hooks. Include failure,
cancellation, late-result, and immutable-cache-update behavior where affected.
Bundle regressions compare minified browser ESM and execute retained contracts;
size assertions cover retention, while runtime timings have no CI thresholds.

### Installed consumers and declarations

The packed check installs through npm with strict engine and peer checks,
TypeScript 5.7.3, Node 22 types, and minimum Query Core. Core and execution-only
outputs run before TanStack is installed. Generated TypeScript runs on Node and
Bun, and emitted JavaScript runs on Node after removing the compiler, formatter,
and YAML parser. No sibling checkout or source symlink may supply runtime code.

Compile native uploads without DOM libraries or browser file globals. Query-only
output must compile without AbortController, Node, or DOM types when its platform
declarations are supplied. Keep dependency declaration checking enabled.

Emit declarations for generated modules and inferred application exports, then
check a separate consumer without the original sources. Cover reusable adapters,
inspection types, cache APIs, wide objects and enums, and `isolatedDeclarations`
on both supported TypeScript lines. The packed check also verifies licenses,
allowed inventory, and clean builds.

## Measurements and adoption

Use `node scripts/benchmark-execution.ts [baseline-ref]` for handwritten/generated
binding, size, typecheck, and runtime comparisons (default baseline: `HEAD`). Use
`node scripts/benchmark-query-sharing.ts` for sharing comparisons. Timings are
local evidence, never machine-dependent CI thresholds. Include the source
revision, toolchain versions and exact command scope when reporting results.

Broader synthetic investigations should measure validation, complete local
call/cache pipelines, sharing, browser behavior, isolated allocation and peak
memory, generation, typechecking, retained bundles, and editor responsiveness
separately. Keep detailed results and reproduction commands with the investigation.

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

## Public documentation and local notes

Keep proposals, sprint plans, working notes, and private consumer reports in
`.local/`, outside Git and the npm package. Existing root proposal files are also
ignored. Do not link public docs to local notes. The coordination board lives
under Git metadata and stays local; keep its entries short and human.

Public docs describe current behavior or durable requirements. Keep dated
measurement evidence separate from those rules. Use synthetic public fixtures;
real contracts, exporters, application patches, credentials, environment files,
and private repository history stay outside the public repository and package.
Before making repository history public, inspect it too: untracking a file does
not remove its earlier revisions.

Use the [README](README.md#further-reading) as the documentation map. Update the
page responsible for a topic and link to it from other guides.

## Before publication

Run the complete canonical checks and required consumer checks against the
release commit. Choose an unpublished package version and authenticate an npm
account allowed to publish `pomegranate-compiler`. Pack, inspect, verify, and
publish the same artifact:

```sh
bun pm pack --filename /tmp/pomegranate-compiler.tgz
node scripts/verify-package.ts /tmp/pomegranate-compiler.tgz
bun publish --dry-run --access public /tmp/pomegranate-compiler.tgz
bun publish --access public /tmp/pomegranate-compiler.tgz
```

Inspect the actual archive inventory before publication. Confirm the registry's
version and integrity afterward. GitHub and npm releases are separate steps.
For unreleased consumer testing, stop after packing and verifying, then install
the local tarball instead of the registry version.

Consumers record compiler version and integrity in their lockfile. An upgrade
regenerates the complete output set with that compiler and its declared runtime
dependencies, reviews API changes, adapts affected callers, and runs application
parity/integration checks. `pom check` verifies generated bytes, not compatibility
with an earlier API.

The package is [MIT licensed](LICENSE). Copied runtime helpers carry its complete
notice into generated output; retain it when redistributing them. Generated
schemas and application inputs remain application-owned. Preserve source
provenance and required notices when adapting reusable code.
