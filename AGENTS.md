# Working on Pomegranate

Pomegranate (POM) compiles a supported OpenAPI vocabulary into TypeScript, native
validators, request builders, and protocol helpers. It is an independent tool
used by personal projects and intended for a public GitHub repository.

Read [README.md](README.md) for an introduction,
[REFERENCE.md](REFERENCE.md) for supported contracts and usage,
[ARCHITECTURE.md](ARCHITECTURE.md) for boundaries and requirements, and
[CONTRIBUTING.md](CONTRIBUTING.md) for verification and publication guidance.

## Working agreement

- Prefer a complete, carefully verified milestone over broad unfinished work.
  Report the behavior delivered, evidence, and remaining scope accurately.
- Preserve concurrent work and avoid overwriting unrelated changes.
- Start additional agents only when the user requests them. Do not commit,
  publish, or deploy without an explicit request.
- The local agent coordination board is closed. Do not create or use a board
  unless the user explicitly reopens it.
- Keep proposals, sprint plans, and working notes in ignored `.local/` storage.
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
- Evaluate review findings by a realistic trigger and concrete user impact.
  Do not pursue impossible or contrived scenarios that offer no meaningful
  correctness, reliability, usability, or adoption benefit. Keep the maintenance
  cost of added machinery and tests proportional to that benefit.
- Keep non-obvious contract and boundary rationale beside the owning code. Use
  types and tests for routine facts; keep necessary lint exceptions local and
  explain the behavior they preserve.
- Keep public fixtures synthetic and exclude consumer contracts, private history,
  credentials, and environment files from distribution.
- Document current behavior separately from intended behavior and dated evidence.
  Give each topic one owner. Keep local implementation rationale beside its code.
- Maintain a concise README and only the supporting documents needed to explain
  architecture, contribution checks, limitations, and unfinished decisions.
