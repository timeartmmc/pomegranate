# Pomegranate

Pomegranate (POM) compiles a supported subset of OpenAPI 3.0 and 3.1 JSON or YAML into
TypeScript request builders, native validators, and response parsers keyed by
HTTP status. Optional executable clients and TanStack Query factories use an
application-supplied executor. Applications own transport, authentication,
retries, and deadlines.

Generated core and execution modules have no package runtime dependencies.
Validators use local runtime files copied into the output. Query modules also
require Query Core. The compiler is a development dependency.

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

Declare [surface membership](REFERENCE.md#client-surfaces-and-security) in the contract
or configuration. [Typed operation policy](REFERENCE.md#operation-policy) is optional.
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

Request builders validate inputs and prepare a relative URL, headers, security, policy,
and body. For the synthetic example:

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

POM supports JSON and multipart requests, exact response statuses, bearer or
public security, selected client surfaces, and a restricted schema vocabulary.
Unsupported features fail with a location-specific diagnostic before outputs
change. General unions, recursive or external schema references, optional multipart
bodies, and non-bearer authentication schemes are unsupported. The
[contract reference](REFERENCE.md#supported-vocabulary) defines the complete
supported vocabulary and limits.

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

The example makes no network request. It uses an injected response, synthetic
credentials, direct calls, and a selected query with one executor. It prints:

```text
POST /api/widgets/demo%2Fwidget/preparations → 202 synthetic-123
```

`examples/json/transport.ts` demonstrates serialization and token resolution;
applications supply their own policy, recovery, deadlines, and session checks.

## Further reading

- [Contract and configuration](REFERENCE.md): input vocabulary, validation,
  generated TypeScript, programmatic compilation, and output recovery.
- [Architecture](ARCHITECTURE.md): ownership, compiler boundaries, and design constraints.
- [Contributing](CONTRIBUTING.md): verification, measurements, dependencies, and publication.

Pomegranate is [MIT licensed](LICENSE).
