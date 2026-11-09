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
  structural limits, exact types, useful issues, and independently typed parser
  outputs.
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
on both supported TypeScript lines. Exercise long reference-alias chains with
`skipLibCheck` enabled and disabled in the separate declaration consumer.
The packed check also verifies licenses,
allowed inventory, and clean builds.
Check generated modules and the compiler's public declarations with `strict`
enabled, disabled, and disabled with `noImplicitAny`. Each mode checks unused
locals and parameters, including standalone constrained-reference chains.

## Measurements and adoption

### Case correctness

Maintained benchmark cases live in `bench/cases/`. Run
`bun run bench:preflight` to rebuild and check the synthetic `json-response` case,
currently version 2. Its independent expectations cover accepted boundaries,
validation and issue paths, stripping, detached mutable results across calls,
changed-input validation, excluded-field reads, and protocol behavior. The report
records case/output hashes and bytes; this preflight remains explicitly untimed.
The separate validation profile below collects exploratory timings. Performance
acceptance gates remain unfinished. Review the case version whenever its workload
or promised behavior changes.

Benchmark code follows the same strict types, Oxlint, Oxfmt and verification as
other repository code. Canonical checks test the oracle against deliberately
incorrect implementations and run the preflight against the installed tarball.
Generated core modules execute in a temporary directory without dependency links.

### Generated-source budgets

Run `bun run bench:output` to rebuild and check the synthetic
`shared-contract-output` case, currently version 1. Its four contracts combine
one or 32 operations with one or eight distinct sections in a shared response
schema. The check compares repeated compilation, exercises generated operations
and validators, and typechecks a standalone consumer before accepting source sizes.

The policy in `bench/output-growth.ts` pins the complete file inventory and
reference UTF-8 source sizes from compiler `da32f73`. Each file receives the
larger of 512 extra bytes or `ceil(reference bytes * 5 / 100)` extra bytes, so
small boilerplate edits fit without changing the reference. The combined
operation/schema growth may exceed the sum of the separate growth axes by at
most 1,024 bytes. Counts
include runtime helpers and comments. Review output diffs and preserve behavioral
and type checks when changing the reference or allowances.

The report includes reference sizes, the benchmark tree identity, and package
versions with manifest paths for the compiler and TypeScript entries. A version
describes the entry's enclosing package, including custom wrappers; it is `null`
when version metadata is unavailable. Failed checks retain their scratch directory
with inputs, available generated files and logs, and `failure.json`; the error
names that directory. Successful checks remove scratch output.

Canonical installed-package verification runs the same family through a copied
harness, the installed compiler and the consumer's TypeScript. These limits cover
deterministic generated source; bundled size, typecheck cost, latency, allocations
and broader performance acceptance remain unqualified.

### Artifact preparation

To prepare complete local package artifacts, create a JSON plan under ignored
`.local/` storage. Supply each archive's SHA-256 as 64 lowercase hexadecimal
digits, replacing the placeholders below:

```json
{
  "version": 1,
  "baseline": { "path": "./baseline.tgz", "sha256": "<sha256>" },
  "candidate": { "path": "./candidate.tgz", "sha256": "<sha256>" },
  "releaseAnchor": { "path": "./release-anchor.tgz", "sha256": "<sha256>" }
}
```

All three roles are required. Archive paths resolve from the plan file's real
directory. Plans must be UTF-8 JSON no larger than 64 KiB; each archive is limited
to 64 MiB. Run preparation with a new output directory whose parent exists:

```sh
bun run bench:prepare .local/bench-plan.json .local/bench-run-001
```

Preparation verifies all archive hashes before installation, installs each role
in a separate npm consumer with lifecycle scripts disabled, and runs the same
captured preflight in each consumer. Dependency resolution may require registry
access. Runtime dependencies must be bundled or resolve to HTTP(S) archives with
integrity metadata; linked directories and Git sources are unsupported. Dependency
locks record resolutions, and an installed-file inventory records actual bytes.
Links escaping a consumer's installed tree are rejected.

The run directory retains archive snapshots, a replayable `plan.json` pointing to
those snapshots, dependency locks, installed-file inventories, harness copies,
qualified generated files, and installation/preflight logs. Successful preparation
writes `report.json`, which records hashes for archives, installed code, the harness
and generated outputs.
It also records tool versions and `performance: "unmeasured"`.
Preparation reports use `schemaVersion: 2`; their `controller` identity uses the
same relative-path file inventory and tree hash as timing source fingerprints.
Plan syntax and schema errors fail before creating
the run directory; failures after a run starts retain available evidence and
`failure.json`. Preparation refuses to reuse an existing output directory. Use a
fresh path for each attempt. Replaying the retained plan uses the current
controller and harness and resolves dependencies again; compare those identities,
dependency locks and installed code before using results together. Preparation
establishes artifact and behavioral evidence; its report contains no timings.

### Artifact comparison

Use the artifact plan above to prepare and time all three POM roles with the
built-in adapter:

```sh
bun run bench:compare .local/bench-plan.json .local/bench-comparison-001
```

An optional third argument names a JSON settings file containing any of `seed`,
`rounds`, `policy` and `profiles`, using the
[validation timing settings](#exploratory-validation-timings).
The settings file must be UTF-8 JSON no larger than 64 KiB. The output directory
must be new and its parent must exist.

The comparison prepares artifacts under `prepared/`, creates adapters and a
`timing-plan.json`, then writes timing evidence under `timing/`. Adapters load the
exact generated bytes retained by preparation. Installation, compiler loading and
generation stay outside the measured validation profile. Captured archives,
installed code, generated output and controller identities are checked around the
comparison. The final root `report.json` joins preparation and timing evidence
with hashes of both stage reports. Failed stages retain available evidence and
`failure.json`; the CLI exits nonzero for failed or partial comparisons.

Canonical installed-package verification copies the harness outside the checkout
and checks empty collections, JSON decoding, 128-record output and multiple issue
paths across three installed artifacts. It uses fresh timed workers without a
performance threshold. Timing summaries remain exploratory under the limits below.

### Exploratory validation timings

Run `bun run bench:run <timing-plan.json> <new-output-directory>` for the shared
`json-response` response-body validation and construction profile. This uses a
separate plan format from artifact preparation. Keep plans, adapters and reports
under ignored `.local/` storage:

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

Timing plans must be UTF-8 JSON no larger than 64 KiB. Provide the adapter module
and source paths before running. Paths resolve from the plan file's real
directory.
Adapter IDs use ASCII letters, digits, underscores or hyphens and must be unique
ignoring ASCII case. Each module exports `create()`, which may return a promise.
It supplies a synchronous `validate`, a nonempty string-valued
`identity` record, and optional `dispose` cleanup. Validation uses the
[`safeParse` result shape](REFERENCE.md#schema-validation). Adapter normalization,
copying and stripping belong inside `validate`; their cost is measured.

The benchmark harness tree and adapter entry modules are fingerprinted
automatically. Declare all other code and inputs that affect validation in
`sources`, including generated validators and dependency trees. Sources may be
regular files or directories. The caller owns the completeness of adapter sources;
the runner does not discover their imports. Keep output directories outside source
trees. Invalid declared source paths stop setup before adapter qualification;
changes to captured sources invalidate the whole run.

| Scenario               | Measured operation                                                      |
| ---------------------- | ----------------------------------------------------------------------- |
| `parsed-valid`         | Validate parsed data and construct detached, stripped output            |
| `json-valid`           | Decode JSON, validate and construct detached, stripped output           |
| `parsed-invalid-first` | Validate an invalid tag in the first record and construct diagnostics   |
| `parsed-invalid-last`  | Validate an invalid tag in the last record and construct diagnostics    |
| `parsed-invalid-many`  | Validate invalid tags in up to 16 initial records and report every path |

The optional `profiles` list selects between 1 and 32 unique scenario/count pairs.
Each `records` value is an integer from 0 through 128. Invalid profiles require at
least one record; `parsed-invalid-many` requires at least two. Without `profiles`,
the runner selects `parsed-valid`, `json-valid` and `parsed-invalid-last`, each
with two records. Every selected profile must pass the oracle before an adapter
is timed. The multi-error profile stays below the diagnostic issue cap; it does
not measure overflow behavior.

The runtime workload is independently versioned as `json-response-runtime`
version 1; the contract/preflight case remains version 2. Timing reports use
`schemaVersion: 2` and record scenario and record count in observations and
summaries.

Module loading, adapter creation and cleanup stay outside measured windows.
Measurements include common result consumption. Preflight runs separately; each
measured process uses a 64-entry input pool, finite warmup/windows, retained
results and natural GC. Workers run serially in seeded randomized order. The optional
`policy` supplies all four fields: `warmupMs`, `sampleMs`, `samples`, and `batchSize`.
Defaults are seed `20261108`, 12 rounds, 100 ms warmup, five 100 ms windows and a
batch size of 128. The report records the effective policy.

Mark a deliberate semantic negative control with `"expect": "ineligible"`. It
must be rejected by the shared oracle; setup failures or unexpected acceptance
fail the run. Expected controls are not timed. Other preflight failures appear
as ineligible adapters in a partial report, and the CLI exits nonzero.

The fresh output directory retains the plan, preflight evidence, raw process
observations, source identities and `report.json`. Workers write results to
separate `*.result.json` files and retain stdout and stderr as logs, so adapter
logging cannot corrupt qualification or measurement results. Measured-worker
execution or identity failures retain logs and `failure.json` with the failed
stage and error.
Summaries report the median of process means and observed min/max in microseconds
per operation. These are local exploratory measurements, with no confidence
intervals or performance acceptance verdict. Noise/detection qualification,
resource/type-cost coverage and controlled performance CI remain unfinished.
Interpret results for the declared adapters, normalized result contract and seeded
workload.

### Calibration pilot

The calibration analyzer checks fixed-plan controls against the same timing
profile. Before collecting data, create a version 1 study under ignored `.local/`
storage with explicit `rounds`, `policy`, `profiles`, a `reference` adapter ID,
`comparisons`, semantic negative `controls`, and `sessions`. Comparisons declare
an `id` and either `kind: "identical"` or `kind: "repeat"` with an integer `every`
from 1 through 1024. Include at least one identical control and two sessions;
each session declares an `id`, a distinct numeric `seed`, and its timing `report`
path. Report paths resolve from the study file's real directory. Study files use
the 64 KiB UTF-8 JSON limit; each input timing report is limited to 16 MiB.

Use `repeatValidation` from `bench/controls.ts` to wrap a base adapter. The
reference uses `every: 0`; identical controls use the same factory module,
sources and identity. Repeated-work controls use the same base validator and
perform an extra validation every declared number of calls. In `controls`, list
IDs of adapters marked `expect: "ineligible"` in the timing plans.

Prepare the session timing plans before collection. Use the study's rounds,
policy, profiles and adapter IDs, selecting each session's declared seed. Include
the study path in every adapter's `sources`. Keep the study unchanged through
analysis and use the same collection harness for all sessions. Once all session
reports exist, run:

```sh
node bench/analyze-calibration.ts .local/study.json .local/calibration-analysis
```

The output directory must be new and its parent must exist. The analyzer checks
study, host, source and adapter identities before pairing process means within
their original randomized round. Every comparison must declare exactly the
reference's `sources` list; repeat wrappers may use different entry modules.
Source lists remain caller declarations, not discovered import graphs. It reports
conditional median intervals with a correction across the declared
comparison/profile cells in each session.
Measurement windows remain observations within one process. If no finite interval
meets the declared family level, bounds are `null` and the signal is `unresolved`.
The report preserves collection identities and records the analyzer's own source
receipt, so a copied analyzer can process retained reports.

These reports are pilot evidence. Neighboring sessions and shared reference
controls can be dependent; session counts do not establish a false-alarm rate or
detection power. Extra-call frequency does not specify a percentage slowdown.
A minimum detectable effect and performance acceptance gates remain unfinished.

### Local diagnostic scripts

Use `node scripts/benchmark-execution.ts [baseline-ref]` for handwritten/generated
binding, size, typecheck, and runtime comparisons (default baseline: `HEAD`). Use
`node scripts/benchmark-query-sharing.ts` for sharing comparisons. Timings are
local evidence, never machine-dependent CI thresholds. Include the source
revision, toolchain versions and exact command scope when reporting results.
Use `node scripts/benchmark-typecheck.ts [baseline-ref] [path-to-tsc]` for
600-, 1,200-, and 3,000-component contracts with distinct parser graphs. Rebuild
first; the optional compiler path lets the same fixture measure each supported
TypeScript line.

### Application adoption

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

Keep plans, working notes, and private consumer reports in ignored `.local/`
storage. Exclude them from Git, packages, and public documentation links.

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

Record the compiler version and integrity in the consumer lockfile. On upgrade,
regenerate all outputs, review API changes, update callers, and run application
integration checks. `pom check` verifies generated bytes; it does not check
compatibility with an earlier API.

The package is [MIT licensed](LICENSE). Copied runtime helpers carry its complete
notice into generated output; retain it when redistributing them. Generated
schemas and application inputs remain application-owned. Preserve source
provenance and required notices when adapting reusable code.
