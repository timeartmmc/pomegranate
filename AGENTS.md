# Working on Pomegranate

Pomegranate (POM) compiles a supported OpenAPI vocabulary into TypeScript, Zod
validators, request builders, and protocol helpers. It is an independent tool
used by personal projects and intended for a public GitHub repository.

Read [README.md](README.md) for current usage and limitations,
[ARCHITECTURE.md](ARCHITECTURE.md) for boundaries and requirements, and
[CONTRIBUTING.md](CONTRIBUTING.md) for verification and publication guidance.

## Working agreement

- Prefer a complete, carefully verified milestone over broad unfinished work.
  Report the behavior delivered, evidence, and remaining scope accurately.
- Use the installed implementer, checker, librarian, and agent-coordination
  skills for their respective work. Keep coordination state in Git metadata.
- Preserve concurrent work. Coordinate intersecting behavior and file edits;
  coordinate shared generation, validation, and Git operations through the board.
- Start additional agents only when the user requests them. Do not commit,
  publish, or deploy without an explicit request.

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
- Keep non-obvious contract and boundary rationale beside the owning code. Use
  types and tests for routine facts; keep necessary lint exceptions local and
  explain the behavior they preserve.
- Keep public fixtures synthetic and exclude consumer contracts, private history,
  credentials, environment files, and local coordination data from distribution.
- Document current behavior separately from intended behavior and dated evidence.
  Give each topic one owner. Keep local implementation rationale beside its code.
- Maintain a concise README and only the supporting documents needed to explain
  architecture, contribution checks, limitations, and unfinished decisions.
- The active librarian owns human-authored documentation. Implementers communicate
  behavior changes to the librarian and avoid simultaneous documentation edits.
