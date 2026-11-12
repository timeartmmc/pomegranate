# Contributing

## Verify the checkout

Use Node.js 26.x and the Bun version pinned in `package.json`:

```sh
bun ci
bunx playwright install --with-deps --only-shell chromium
bun run verify
```

Use Bun for installation, scripts, and packaging; `bun.lock` is the sole
lockfile. Keep development Node types on Node 26. CI runs `verify` on Node 26
and both advertised consumer minimums, Node 22.18.0 and 24.0.0. Consumer setup
belongs in the [README](README.md#quick-start).

`verify` checks formatting, builds the package, prepares generated test
signatures, and runs typechecks, type-aware lint, Node and Chromium tests,
example drift and execution checks, and an isolated packed install. Keep CI
aligned with this command. Node tests have a 30-second default timeout.

Use **Oxlint** for JavaScript/TypeScript linting and **Oxfmt** for
supported-file formatting. Both are required by `verify`. Strict types and lint
cover compiler, example, tests, helpers, scripts, and dependency declarations.
Tests use `noEmit` and `erasableSyntaxOnly`; Node executes their TypeScript
directly. Generated modules use the pinned formatter with explicit options and
are excluded from lint. Keep necessary lint exceptions local and explain the
behavior they preserve.

For focused checks after changing compiler source, rebuild first. Before running
`typecheck` or `lint` separately, also run `bun run test:prepare` so ignored
`test/.generated` signatures match the compiler. Runtime tests generate fresh
temporary outputs.

For a focused browser check, run `bun run test:browser` after installing
Chromium. It rebuilds the compiler and runs `test/*.browser.test.ts` against
local fixtures and servers. Keep bulk schema and cache cases in Node tests; use
browser tests for Fetch, multipart files, cancellation, and mounted query hooks.
`verify` includes both.

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

Review the generated diff. Use `bun run format` for source and documentation,
then run `bun run verify` before submitting a change. Preserve unrelated
changes.

Review dependency updates manually. New dependency, runtime, and tooling
versions must have been published for at least six full days. `bunfig.toml`
enforces that age for newly resolved npm packages; it does not change existing
lockfile entries.

## Verification expectations

Test accepted and rejected inputs, failure paths, and agreement between types
and validators. Public API changes also need an installed-consumer check. Output
changes need drift, ownership, and recovery coverage. Avoid tests that only
repeat emitted text. Keep detailed cases in tests and fixtures.

Check the affected boundaries together:

- Input and contract interpretation: JSON/YAML equivalence, malformed input,
  security inheritance, validation before selection, and transitive projection.
- Validation: scalar and container rules, references, constraints, defaults,
  structural limits, exact types, useful issues, and independently typed parser
  outputs.
  The schema oracle compares supported cases with Ajv2020, a development dependency.
- Output: deterministic complete rendering, read-only drift, protected inputs,
  aliases and symlinks, conflicts, stale cleanup, and interrupted generation.
- Execution: input snapshots, raw/scoped responses, exact, range and default
  statuses, error provenance, single-use raw responses, callback cleanup,
  cancellation, and complete browser/native uploads.
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
output must compile without AbortController, Node, or DOM types when its
platform declarations are supplied. Keep dependency declaration checking
enabled.

Emit declarations for generated modules and inferred application exports, then
check a separate consumer without the original sources. Cover reusable adapters,
inspection types, cache APIs, wide objects and enums, and `isolatedDeclarations`
on both supported TypeScript lines. Exercise long reference-alias chains with
`skipLibCheck` enabled and disabled in the separate declaration consumer. The
packed check also verifies licenses, package contents, and clean builds.

Check generated modules and the compiler's public declarations with `strict`
enabled. Also check generated modules with only `strictNullChecks` enabled and
with unused locals and parameters checked; disabling null checks must report
`Pomegranate output requires strictNullChecks`. Exercise generated builders,
direct calls, query factories, and typed cache access, including accepted body
factories and rejected bodyless-success selections.

## Measurements and adoption

Source-size checks enforce explicit byte budgets. Timing results are
exploratory: they have no performance acceptance thresholds and do not establish
application budgets. For commands with an output-directory argument, choose a
new path whose parent already exists. Keep benchmark plans, settings, adapters,
and reports in ignored `.local/` storage.

### Case correctness

Benchmark cases live in `bench/cases/`. Run `bun run bench:preflight` to rebuild
and check the synthetic `json-response` case, currently version 2. Its
independent expectations cover accepted boundaries, validation and issue paths,
stripping, detached mutable results across calls, changed inputs, excluded-field
reads, and protocol behavior. The report records a hash of the case code, plus
hashes and byte counts for generated files; it collects no timings. Review the
case version when its workload or expected behavior changes.

Benchmark code follows the same strict types, Oxlint, Oxfmt and verification as
other repository code. `verify` tests the oracle against deliberately incorrect
implementations and run the preflight against the installed tarball. Generated
core modules execute in a temporary directory without dependency links.

### Generated-source budgets

Run `bun run bench:output` to rebuild and check the synthetic
`shared-contract-output` case, currently version 1. Its four contracts combine
one or 32 operations with one or eight distinct sections in a shared response
schema. The check compares repeated compilation, exercises generated operations
and validators, and typechecks a standalone consumer before accepting source
sizes.

`bench/output-growth.ts` fixes the expected file inventory and reference UTF-8
source sizes. Most references come from compiler `da32f73`; policy version 6
updates only `runtime.ts`. The file records its source digest and the history of
reviewed size increases.

Each file allows the larger of 512 extra bytes or
`ceil(reference bytes * 5 / 100)` extra bytes. Combined operation/schema growth
may exceed the sum of their separate growth by at most 1,024 bytes. Counts
include runtime helpers and comments. Review output diffs and preserve behavior
and type checks when changing a reference or allowance.

The report includes reference sizes, a hash of the benchmark code, and package
versions and manifest paths for the compiler and TypeScript. Versions identify
the enclosing package, including for custom wrappers, or are `null` when
unavailable. Failed checks name and retain a scratch directory with
`failure.json`, logs, `input.json`, generated files, repeated output under
`repeat/`, and the `input-after-first.json` and `input-after-repeat.json`
snapshots completed so far. Determinism failures name the differing file.
Successful checks remove scratch output.

The package check runs these cases with a copied benchmark runner, the installed
compiler, and the consumer's TypeScript. These limits cover generated source
size and determinism. They set no budget for bundled size, latency, allocations,
or application performance.

### Synthetic TypeScript checking

Run the `core-typecheck` case, version 2, against the installed packages in the
[artifact plan](#artifact-preparation):

```sh
bun run bench:typecheck .local/bench-plan.json .local/typecheck-run-001
```

An optional third argument names a JSON settings file with `seed` (unsigned
32-bit integer), `rounds` (1–30, default 3), and `profiles` (unique IDs from the
list below). The default seed is 20261109. Package and TypeScript installation
may require registry access.

| Profile                                          |          Components |         Operations | Extra string fields per object |
| ------------------------------------------------ | ------------------: | -----------------: | -----------------------------: |
| `base`                                           |                  32 |                 32 |                              1 |
| `distinct-600`, `distinct-1200`, `distinct-3000` | 600 / 1,200 / 3,000 | same as components |                              1 |
| `width-32`, `width-125`, `width-128`             |                  32 |                 32 |                 32 / 125 / 128 |
| `shared-1`, `shared-8`                           |               1 / 8 |                 32 |                              1 |
| `shared-wide`                                    |                   1 |                 32 |                             32 |

Every object also has a distinct literal `kind`, integer `score`, and
string-array `tags`. The distinct profiles grow component/operation pairs; width
and sharing each vary one dimension from `base`, and `shared-wide` combines
them. All cases stay within compiler limits. `width-125` has 128 total
properties; `width-128` has 131. Both use the same field-table constructor as
smaller objects. The separate `smoke` profile has 2 components, 3 operations,
and 2 extra fields; it is excluded from the default matrix.

Before timing, the runner checks every operation and request/response schema,
and typechecks all generated modules. Small consumers exercise first, middle,
and last operations: request validation, builders, response narrowing and
validation, array inference, field access, and inferred exports. Negative type
checks reject missing required inputs and incorrect literals and field types,
including accidental `any`. Executable clients, queries, mutations, and
pagination are not covered.

The runner prepares packages and installs TypeScript 5.7.3 (the consumer
minimum) and the exact development version from `package.json`. Installation,
generation, consumer checks, and effective-option capture finish before
measurement. Each round shuffles package/profile/toolchain combinations with the
recorded seed, then runs fresh TypeScript processes serially. `verify` runs the
small correctness tests and one installed smoke round on both TypeScript
versions.

`report.json` records process wall time and TypeScript check time in
milliseconds, instantiations, and memory in TypeScript's reported `K` units;
effective options and workload dimensions; tool and host details; and hashes of
archives, locks, installed code, benchmark code, and projects. Process wall time
includes TypeScript startup and project loading. TypeScript's memory counter is
**not peak process memory**, which is unmeasured. The run directory retains
stdout, stderr, checked projects, the schedule, and individual samples. Missing,
duplicate, or malformed counters fail the run. Failures retain available results
and `failure.json` and exit nonzero. Timings apply to these workloads on the
recorded machine and toolchain.

### Compiler generation cost

Run the `compiler-generation` case, version 1, against the installed packages in
the [artifact plan](#artifact-preparation):

```sh
bun run bench:generate .local/bench-plan.json .local/generation-run-001
```

An optional third argument names a JSON settings file with `seed` (default
20261109), `rounds` (1–30, default 3), and unique `profiles` IDs:
`operations-100`, `operations-1000`, `operations-10000`. All three profiles run
by default. The separate `smoke` profile uses three operations and is the only
profile run by the package check.

These contracts reuse the typecheck case's shared object schema: one component,
one extra string field, and JSON request/response bodies. Only operation count
changes. The 10,000-operation case fits current compiler limits with this shared
schema; it does not promise that every 10,000-operation contract fits.

Before timing, the runner installs packages, prepares inputs, runs the read-only
CLI drift check, checks every operation and schema name, and exercises builders
and response parsers. Every measured output must match the checked output's
complete file inventory and hashes, including its ownership manifest. Fresh Node
workers run serially in seeded randomized package/profile/mode order.

Both modes invoke the installed package's actual CLI entry. Cold runs start a
fresh process. Warm runs perform one untimed full generation before the measured
generation in that process; the compiler and formatter retain their module
caches. Both invocations use fresh output directories. Node's persistent compile
cache is disabled in both modes; OS filesystem caches are not flushed.

The generation interval covers the CLI invocation: input/config reading,
parsing, normalization, emission, formatting and writes, plus compiler loading
in cold mode. `generationMs` excludes Node startup and worker setup.
`processWallMs` records the entire fresh worker, including startup, setup, any
warmup, and result writing. `operationsPerSecond` is input operations × 1,000 /
`generationMs`; it describes batch code generation, not API request throughput.

`peakRssKiB` uses Node's `process.resourceUsage().maxRSS`: the worker's lifetime
peak resident memory, including compiler loading, native formatter memory and
any warmup. It is not a sampled heap value or a warm-only memory delta. See the
[Node resource usage
definition](https://nodejs.org/api/process.html#processresourceusage) for its
KiB units. This is separate from TypeScript's reported memory counter.

The run directory retains tool and host versions, workload dimensions, commands,
package and source hashes, stdout, stderr, worker records, inventories, and
samples. `qualified.json` records the checked projects; `schedule.json` records
each sample's round, package role, profile, and mode. Inputs are hashed before
checks. Checked outputs are retained; measured and warmup copies are removed
after both inventories match. Failures retain available inputs, outputs, logs,
and `failure.json`. Missing or malformed measurements fail the run.

### Artifact preparation

Create a JSON plan for three local package archives. Supply each archive's
SHA-256 as 64 lowercase hexadecimal digits, replacing the placeholders below:

```json
{
  "version": 1,
  "baseline": { "path": "./baseline.tgz", "sha256": "<sha256>" },
  "candidate": { "path": "./candidate.tgz", "sha256": "<sha256>" },
  "releaseAnchor": { "path": "./release-anchor.tgz", "sha256": "<sha256>" }
}
```

All three roles are required. Archive paths resolve from the plan file's real
directory. Plans must be UTF-8 JSON no larger than 64 KiB; each archive is
limited to 64 MiB. Run:

```sh
bun run bench:prepare .local/bench-plan.json .local/bench-run-001
```

Preparation verifies all archive hashes before installation, installs each role
in a separate npm consumer with lifecycle scripts disabled, and runs the same
captured preflight in each consumer. Dependency resolution may require registry
access. Runtime dependencies must be bundled or resolve to HTTP(S) archives with
integrity metadata; linked directories and Git sources are unsupported.
Dependency locks record resolutions, and an installed-file inventory records
actual bytes. Links escaping a consumer's installed tree are rejected.

The run directory retains archive copies, a replayable `plan.json` pointing to
them, dependency locks, installed-file inventories, benchmark code, checked
generated files, and installation/preflight logs. `report.json` records archive,
installed-code, benchmark, and output hashes, tool versions, and
`performance: "unmeasured"`. Reports use `schemaVersion: 2`; the `controller`
uses the same relative-path inventory and tree hash as timing source
fingerprints.

Invalid plans fail before creating the run directory; later failures retain
available files and `failure.json`. Replaying the retained plan uses the current
runner and benchmark code and resolves dependencies again. Compare their hashes,
dependency locks, and installed code before combining results. Preparation
checks package contents and behavior; it collects no timings.

### Artifact comparison

Use the plan above to prepare and time all three packages with the built-in
adapter:

```sh
bun run bench:compare .local/bench-plan.json .local/bench-comparison-001
```

An optional third argument names a JSON settings file containing any of `seed`,
`rounds`, `policy` and `profiles`, using the [validation timing
settings](#exploratory-validation-timings). The settings file must be UTF-8 JSON
no larger than 64 KiB.

The comparison prepares packages under `prepared/`, creates adapters and
`timing-plan.json`, and writes measurements under `timing/`. Adapters load the
exact generated bytes retained by preparation. Installation, compiler loading,
and generation stay outside validation timing. The runner checks archive,
installed-code, output, and controller hashes before and after comparison. The
root `report.json` combines preparation and timing results with hashes of both
reports. Failed stages retain available results and `failure.json`; failed or
partial comparisons exit nonzero.

The package check copies the benchmark code outside the checkout and tests empty
collections, JSON decoding, 128-record output, and multiple issue paths across
three installed packages using fresh timed workers.

### Exploratory validation timings

Run `bun run bench:run <timing-plan.json> <new-output-directory>` for the shared
`json-response` response-body validation and construction profile. This uses a
separate plan format from package preparation:

```json
{
  "version": 1,
  "seed": 20261108,
  "rounds": 12,
  "profiles": [
    { "scenario": "parsed-valid", "records": 128 },
    { "scenario": "json-valid", "records": 128 },
    { "scenario": "parsed-invalid-many", "records": 128 }
  ],
  "adapters": [
    {
      "id": "candidate",
      "module": "./adapters/candidate.mjs",
      "sources": ["./generated", "./runtime-dependencies"]
    }
  ]
}
```

Timing plans must be UTF-8 JSON no larger than 64 KiB. Provide the adapter
module and source paths before running. Paths resolve from the plan file's real
directory. Adapter IDs use ASCII letters, digits, underscores or hyphens and
must be unique ignoring ASCII case. Each module exports `create()`, which may
return a promise. It supplies a synchronous `validate`, a nonempty string-valued
`identity` record, and optional `dispose` cleanup. Validation uses the
[`safeParse` result shape](REFERENCE.md#schema-validation). Adapter
normalization, copying and stripping belong inside `validate`; their cost is
measured.

The runner hashes benchmark code and adapter entry modules automatically.
Declare all other code and inputs that affect validation in `sources`, including
generated validators and dependency trees. Sources may be files or directories.
List every dependency: the runner does not discover imports. Keep output
directories outside source trees. Invalid source paths stop setup before adapter
checks; changes to recorded sources invalidate the run.

| Scenario               | Measured operation                                                      |
| ---------------------- | ----------------------------------------------------------------------- |
| `parsed-valid`         | Validate parsed data and construct detached, stripped output            |
| `json-valid`           | Decode JSON, validate and construct detached, stripped output           |
| `parsed-invalid-first` | Validate an invalid tag in the first record and construct diagnostics   |
| `parsed-invalid-last`  | Validate an invalid tag in the last record and construct diagnostics    |
| `parsed-invalid-many`  | Validate invalid tags in up to 16 initial records and report every path |

The optional `profiles` list selects between 1 and 32 unique scenario/count
pairs. Each `records` value is an integer from 0 through 128. Invalid profiles
require at least one record; `parsed-invalid-many` requires at least two.
Without `profiles`, the runner selects `parsed-valid`, `json-valid` and
`parsed-invalid-last`, each with two records. Every selected profile must pass
the oracle before an adapter is timed. The multi-error profile stays below the
diagnostic issue cap; it does not measure overflow behavior.

The runtime workload is independently versioned as `json-response-runtime`
version 1; the contract/preflight case remains version 2. Timing reports use
`schemaVersion: 2` and record scenario and record count in observations and
summaries.

Module loading, adapter creation and cleanup stay outside measured windows.
Measurements include common result consumption. Preflight runs separately; each
measured process uses a 64-entry input pool, bounded warmup and sampling
windows, and retained results. Garbage collection runs normally. Workers run
serially in seeded randomized order. The optional `policy` supplies all four
fields: `warmupMs`, `sampleMs`, `samples`, and `batchSize`. Defaults are seed
`20261108`, 12 rounds, 100 ms warmup, five 100 ms windows and a batch size of 128. The report records the effective policy.

Mark a deliberate semantic negative control with `"expect": "ineligible"`. It
must be rejected by the shared oracle; setup failures or unexpected acceptance
fail the run. Expected controls are not timed. Other preflight failures appear
as ineligible adapters in a partial report, and the CLI exits nonzero.

The output directory retains the plan, preflight results, process measurements,
source hashes, and `report.json`. Workers write separate `*.result.json` files
and stdout/stderr logs, so adapter logging cannot corrupt results. Worker
failures and source changes retain logs and `failure.json` with the failed stage
and error. Summaries report the median of process means and observed min/max in
microseconds per operation, without confidence intervals. Noise and slowdown
detection, resource and type costs, and controlled performance CI need further
work. Results apply to the declared adapters, result shape, and seeded workload.

### Calibration pilot

The calibration analyzer compares identical controls and controls that repeat
validation. Before collecting data, create a version 1 study with explicit
`rounds`, `policy`, `profiles`, a `reference` adapter ID, `comparisons`,
semantic negative `controls`, and `sessions`. Each comparison declares an `id`
and either `kind: "identical"` or `kind: "repeat"` with an integer `every` from
1 through 1024. Include at least one identical control and two runs in
`sessions`. Each run declares an `id`, a distinct numeric `seed`, and a timing
`report` path. Paths resolve from the study file's real directory. The study
must be UTF-8 JSON no larger than 64 KiB; each timing report is limited to 16
MiB.

Use `repeatValidation` from `bench/controls.ts` to wrap a base adapter. The
reference uses `every: 0`; identical controls use the same factory module,
sources, and identity. Controls that repeat validation use the same base
validator and perform an extra validation every declared number of calls. In
`controls`, list IDs of adapters marked `expect: "ineligible"` in the timing
plans.

Prepare one timing plan per run before collecting data. Use the study's rounds,
policy, profiles, and adapter IDs with that run's seed. Include the study path
in every adapter's `sources`. Keep the study unchanged through analysis and use
the same benchmark code for every run. Once all reports exist, run:

```sh
node bench/analyze-calibration.ts .local/study.json .local/calibration-analysis
```

The analyzer checks the study, host, source, and adapter identities before
pairing process means from their original randomized round. Each comparison must
declare the reference's exact `sources` list; repeat wrappers may use different
entry modules. The runner does not discover imports.

The analyzer reports conditional median intervals, corrected across the declared
comparison/profile combinations within each run. Measurement windows within one
process are not independent runs. If no finite interval meets the method's
family confidence level, bounds are `null` and the signal is `unresolved`. The
report preserves the collection details and hashes the analyzer's sources, so a
copied analyzer can process retained reports.

These reports are preliminary. Repeated runs and shared reference controls can
be dependent; their count does not establish a false-alarm rate or detection
power. Extra-call frequency does not specify a percentage slowdown. The analyzer
does not establish a minimum detectable effect or a performance acceptance
threshold.

### Local diagnostic scripts

Use `node scripts/benchmark-execution.ts [baseline-ref]` for
handwritten/generated binding, size, typecheck, and runtime comparisons (default
baseline: `HEAD`). Use `node scripts/benchmark-query-sharing.ts` for sharing
comparisons. Timings are local measurements. Include the source revision,
toolchain versions, and exact command when reporting results. For generated
TypeScript costs, use the [synthetic checking
runner](#synthetic-typescript-checking).

### Application adoption

Check behavior and integration in the application and set time and memory
budgets. Compare bundle size, typecheck and parsing costs, copying, freezing,
sharing, allocations, and handwritten integration code with both the existing
approach and a version using shared helpers. Include bridges, configuration,
cache writers, and remaining wrappers. Compiler checks cannot establish
application savings or budget compliance; measure those separately. A
status-only transport may gain nothing from scoped validation.

Exercise the existing transport through one shared adapter before proposing
transport changes. Keep real contracts, application patches, and detailed
consumer reports outside this public checkout. Select queries independently of
direct calls; when selected, verify one compatible Query Core resolution across
framework and persistence adapters in the consumer lockfile.

## Public documentation and local notes

Keep plans, working notes, and private consumer reports in ignored `.local/`
storage. Exclude them from Git, packages, and public documentation links.

Public docs describe current behavior or durable requirements. Keep dated
measurements separate from those rules. Use synthetic public fixtures; real
contracts, exporters, application patches, credentials, environment files, and
private repository history stay outside the public repository and package.
Before making repository history public, inspect it too: untracking a file does
not remove its earlier revisions.

Use the [README](README.md#further-reading) as the documentation map. Update the
page responsible for a topic and link to it from other guides.

## Before publication

Run `bun run verify` and required consumer checks against the release commit.
Choose an unpublished package version and authenticate an npm account allowed to
publish `pomegranate-compiler`. Pack, inspect, verify, and publish the same
archive:

```sh
bun pm pack --filename /tmp/pomegranate-compiler.tgz
node scripts/verify-package.ts /tmp/pomegranate-compiler.tgz
bun publish --dry-run --access public /tmp/pomegranate-compiler.tgz
bun publish --access public /tmp/pomegranate-compiler.tgz
```

Inspect the actual archive inventory before publication. Confirm the registry's
version and integrity afterward. GitHub and npm releases are separate steps. For
unreleased consumer testing, stop after packing and verifying, then install the
local tarball instead of the registry version.

Record the compiler version and integrity in the consumer lockfile. On upgrade,
regenerate all outputs, review API changes, update callers, and run application
integration checks. `pom check` verifies generated bytes; it does not check
compatibility with an earlier API.

The package is [MIT licensed](LICENSE). Copied runtime helpers carry its
complete notice into generated output; retain it when redistributing them.
Generated schemas and application inputs remain application-owned. Preserve
source provenance and required notices when adapting reusable code.
