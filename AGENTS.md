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
- Preserve unrelated changes.
- Delegate work only when explicitly requested.
- Do not commit, publish, or deploy without an explicit request.
- Local coordination tracking is disabled. Do not recreate its records.
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
- Add capabilities for demonstrated needs. Unsupported semantics must produce
  explicit diagnostics; no operation may disappear silently.
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
