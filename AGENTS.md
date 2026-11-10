# Working on Pomegranate

Pomegranate (POM) compiles supported OpenAPI contracts into TypeScript validators,
request builders, and protocol helpers.

Read [README.md](README.md) for an introduction,
[REFERENCE.md](REFERENCE.md) for supported contracts and usage,
[ARCHITECTURE.md](ARCHITECTURE.md) for boundaries and requirements, and
[CONTRIBUTING.md](CONTRIBUTING.md) for verification and publication guidance.

## Working agreement

- Finish and verify each change before expanding scope. Report results and
  remaining limits accurately.
- Before adding code, inspect the owning implementation and existing helpers.
  Before finishing, review the complete diff for duplicated domain rules,
  unnecessary abstractions, tautological assertions, and tests that merely defend
  implementation details. Fix demonstrated problems; require a concrete benefit
  for structural changes.
- Preserve unrelated changes.
- Codex sessions running at ultra reasoning effort may delegate work when useful.
  Do not delegate at other effort levels.
- Do not commit, publish, or deploy without an explicit request.
- Use the local coordination board for agent status, findings, and shared operations.
- Keep plans and working notes in ignored `.local/` storage.
  Never track or package them, or link to them from public documentation.

## Boundaries

- POM consumes explicit local inputs and configuration. It does not discover
  consumer repositories, invoke their backends, access databases, or implement
  their authentication providers and domain policy.
- Consumers own API schemas, exported operation policy, transports, generated
  artifacts, and application integration tests. POM owns contract interpretation,
  generation, diagnostics, and its output inventory.
- Generated protocol helpers perform validation without fetching. Applications
  run from generated code and declared runtime dependencies; the compiler is a
  development dependency.
- Use one canonical metadata and generated format. Adapt consumers to it rather
  than retaining project-specific compiler branches or obsolete formats.
- Broader OpenAPI support is a product goal, including broader `allOf` support.
  Current vocabulary limits are implementation stages, not permanent architectural
  boundaries. Revisit compiler representations and simplifying assumptions when
  they obstruct correct support. Stage extensions with explicit diagnostics for
  unsupported forms.
- Prioritize OpenAPI 3.0+ interoperability and generated API use cases. A
  general-purpose JSON Schema engine is not a separate product goal.
- Improve POM's general usefulness, correctness, clarity, and interoperability.
  Require benefits proportional to permanent implementation, testing, and
  maintenance complexity. Prefer explicit limits and actionable diagnostics for
  rare, avoidable cases that authors can express using existing supported
  constructs. Do not add specialized machinery merely to make every technically
  expressible input succeed.
- Unsupported semantics must produce explicit diagnostics; no operation may
  disappear silently.
- Render and validate the complete output set before writing. Drift checks must
  be read-only. Cleanup must preserve inputs and unrelated or modified files.

## Verification and documentation

- Enforce the [Oxlint and Oxfmt tooling policy](CONTRIBUTING.md) in canonical
  verification.
- Test observable guarantees and meaningful failure paths. Exercise the package
  as installed, including a standalone synthetic example, at coherent milestones.
- Evaluate findings by a realistic trigger and concrete user impact. Keep the
  implementation and tests proportional to that impact.
- Keep non-obvious contract and boundary rationale beside the owning code. Use
  types and tests for routine facts; keep necessary lint exceptions local and
  explain the behavior they preserve.
- Keep public fixtures synthetic and exclude consumer contracts, private history,
  credentials, and environment files from distribution.
- Document current behavior separately from intended behavior and dated evidence.
  Give each topic one owner. Keep local implementation rationale beside its code.
- Maintain a concise README and only the supporting documents needed to explain
  architecture, contribution checks, limitations, and unfinished decisions.
