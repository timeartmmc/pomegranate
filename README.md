# Pomegranate

Pomegranate (POM) compiles supported OpenAPI 3.0 and 3.1 contracts in JSON or YAML
into TypeScript request builders, native validators, and response parsers.
Optional clients and TanStack Query factories call a transport you provide.
Your application owns authentication, retries, and deadlines.

Core modules and executable clients have no package runtime dependencies.
Generated modules use local runtime helpers; query modules also require Query
Core. Install the compiler as a development dependency.

## Quick start

Use Node.js 22.18+ on the 22.x line, or Node.js 24 or newer. Install with npm or
Bun:

```sh
npm install --save-dev pomegranate-compiler
```

Create `pom.json` beside your exported contract:

```json
{
  "version": 2,
  "openapi": "./openapi.json",
  "output": "./generated",
  "clients": ["consumer"]
}
```

Declare [surface membership](REFERENCE.md#client-surfaces-and-security) in the
contract or configuration. [Operation policy](REFERENCE.md#operation-policy) is
optional.
Use a `.yaml` or `.yml` input path for YAML; configuration stays JSON. Paths
resolve from the configuration file's real directory.

```sh
npx --package=pomegranate-compiler pom generate --config pom.json
npx --package=pomegranate-compiler pom check --config pom.json
```

Generate the complete output set with one compiler version. `check` reports drift
without writing files. Keep `.pom-manifest.json` with generated artifacts and
exclude generated files from application formatter rewrites. This guide describes
the source checkout; use a [local tarball](CONTRIBUTING.md#before-publication) to
try changes that have not been released.

Generated sources use ES modules, explicit `.ts` imports, and erasable TypeScript.
Supported Node versions and Bun can run them directly in a package with
`"type": "module"`; TypeScript-aware bundlers can also consume them. See
[generated TypeScript](REFERENCE.md#generated-typescript) for compilation and
platform requirements.

## Use the generated API

Request builders validate inputs and prepare the relative URL, headers, security,
policy, and body. For the example:

```ts
import { operations } from './generated/client.consumer.ts';

const request = operations.getWidget.build({
  path: { widgetId: 'demo/widget' },
});
```

The application sends the request and passes observed status, headers, and raw
body text to `request.parseResponse`. The result distinguishes validated success,
declared HTTP failure, and protocol failure. See the
[request and response API](REFERENCE.md#build-and-validate-a-request) for a complete
example, transport headers, uploads, and validation behavior.

Choose the integration needed by the application:

- [Executable clients](EXECUTION.md) add typed `call` methods and error guards,
  using one application executor for reads, writes, and uploads.
- [Query integration](QUERIES.md) adds typed keys, filters, cache options, and
  forward cursor or offset pagination. It is selected independently of direct
  calls and requires an explicit cache migration in an existing application.
- [Standalone validators](REFERENCE.md#standalone-validators) validate selected
  component schemas outside HTTP operations.

## Supported contracts

POM supports JSON, plain text, and multipart requests; exact, range, and default
response statuses;
API keys, HTTP basic/bearer, OAuth2 scopes, and public or optional access;
security alternatives and combinations; selected client surfaces; and a
restricted schema vocabulary that includes unconstrained JSON, `anyOf` and
`oneOf` unions, [recursive local schemas](REFERENCE.md#recursive-schemas), and staged
[`allOf` composition](REFERENCE.md#allof-composition). Unrelated
extensions require an explicit ignore list.

Unsupported features fail with a location-specific diagnostic before outputs
change. Overlapping `oneOf` alternatives without a discriminator, external
schema references, optional
multipart uploads, OpenID Connect, and mutual TLS are unsupported. The
[contract reference](REFERENCE.md#supported-vocabulary) defines the complete
supported vocabulary and limits.

Formats must be built in or explicitly defined in `pom.json`. A registered
string format supplies a pattern that POM validates in generated code; unknown
or misspelled names stop compilation. See
[registered formats](REFERENCE.md#registered-formats).

## Run the example

From a checkout, use a supported Node.js version and the Bun version pinned in
`package.json`:

```sh
bun ci
bun run build
bun run example:generate
bun run example:check
bun run example:run
```

The example uses synthetic data and an injected response, with no network
requests. Direct calls and a query share one executor. It prints:

```text
POST /api/widgets/demo%2Fwidget/preparations → 202 synthetic-123
```

`examples/json/transport.ts` demonstrates serialization and token resolution;
applications supply their own policy, recovery, deadlines, session checks, and
server overrides, which the example refuses.

## Further reading

- [Contract and configuration](REFERENCE.md): input vocabulary, validation,
  generated TypeScript, programmatic compilation, and output recovery.
- [Architecture](ARCHITECTURE.md): ownership, compiler boundaries, and design constraints.
- [Contributing](CONTRIBUTING.md): verification, measurements, dependencies, and publication.

Pomegranate is [MIT licensed](LICENSE).
