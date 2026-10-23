# Pomegranate

Pomegranate (POM) compiles a strict subset of OpenAPI 3.1.0 JSON into TypeScript
request builders, Zod validators, and response validation keyed by HTTP status.
Generated code performs no network I/O. Applications own the transport and the
meaning of their authentication, retry, and timeout policy.

POM supports JSON contracts, declared bearer transport requirements, and selected
client surfaces, with a synthetic example and an isolated installed-package
check. Adoption by existing applications remains planned. The package is private
and unpublished.

## Run the example

Use Node.js 24.x and npm. From this repository's checkout:

```sh
npm ci
npm run build
npm run example:generate
npm run example:check
npm run example:run
```

The demo injects a synthetic response and makes no network request. It prints:

```text
POST /api/widgets/demo%2Fwidget/preparations → 202 synthetic-123
```

`examples/json/openapi.json` declares distinct `200` and `202` success bodies,
distinct error bodies, required headers, a `true` constant, and bodyless HEAD and
OPTIONS operations. It also demonstrates inherited bearer security, public
overrides, and separate consumer/staff surfaces. `demo.ts` and `transport.ts` show
application-owned token resolution with a synthetic token. The small transport
sends once; applications must implement their actual authentication, deadlines,
retries, cancellation, and error handling.

## Use POM in a project

Run `npm pack` in the POM checkout to build a local tarball. In your TypeScript
project, install it as a development dependency and install Zod for runtime use:

```sh
npm install --save-dev /path/to/pomegranate-compiler-0.1.0.tgz
npm install --save-exact zod@4.3.6
```

Create `pom.json` beside your exported `openapi.json`:

```json
{
  "version": 2,
  "openapi": "./openapi.json",
  "output": "./generated",
  "clients": ["consumer", "staff"]
}
```

Paths resolve from the real configuration file's directory. `clients` selects
declared surface identities directly. Generate or check the complete output set:

```sh
npx --no-install pom generate --config pom.json
npx --no-install pom check --config pom.json
```

Compile the generated `.ts` files with your application. Their imports are
relative, with `.js` specifiers for TypeScript's NodeNext resolution. Zod is their
only external runtime dependency; deployed applications do not need the compiler.
Programmatic generation uses `compile(document, { clients: ['consumer'] })` with
the same complete-input validation and explicit client selection.

The OpenAPI document declares a versioned vocabulary of application-owned labels:

```json
{
  "x-pom-policy": {
    "version": 2,
    "auth": {
      "public": { "transport": "none" },
      "session": { "transport": "bearer" },
      "partnerStaff": { "transport": "bearer" }
    },
    "retry": ["never"],
    "timeout": ["interactive"],
    "surfaces": ["consumer", "staff"]
  }
}
```

Each operation selects labels and nonempty surface membership, for example
`"x-pom": { "auth": "session", "retry": "never", "timeout": "interactive", "surfaces": ["consumer"] }`.
The auth binding must agree with the operation's effective OpenAPI security.
Generated requests expose `policy.auth` as `{ label, transport }`; applications
resolve tokens and enforce the label's meaning. Retry and timeout labels remain
opaque. No label authorizes a request, enables retries, or sets a numeric deadline.

## Security and client boundaries

POM recognizes inline `type: "http"`, `scheme: "bearer"` security schemes by their
semantics. Scheme names are arbitrary, scheme comparison ignores case, and
`bearerFormat` is only an annotation. A supported bearer requirement names one
declared scheme with an empty role array, such as `security: [{ WidgetSession: [] }]`.

An operation inherits document security when its own `security` field is absent.
Its own `[]` or `[{}]` declares public access; absence at both levels also means
no security requirement. Alternatives, combined schemes, optional bearer access,
and nonempty role requirements are rejected explicitly. The generated code never
obtains credentials or sends Authorization headers.

Every operation must name at least one declared surface. Surface names match
`[a-z][a-z0-9_-]{0,62}`. Unknown or duplicate names and selected surfaces without
operations fail generation. An internal-only operation can belong to a declared
surface omitted from `clients`.

Each selected surface gets a `client.<surface>.ts` entry and its own operation
and schema modules, with one shared runtime. There is no all-operations entry.
Client modules contain only schemas reachable from that client's request and
response contracts, including transitive references. All operations, schemas,
and security declarations are validated before selection, so an unsupported
unselected operation still fails generation. Surfaces control generated imports;
the server remains responsible for authorization.

## Build and validate a request

For the synthetic contract, generated usage looks like this:

```ts
import { operations } from './generated/client.consumer.js';

const request = operations.prepareWidget.build({
  path: { widgetId: 'demo/widget' },
  headers: { 'Idempotency-Key': 'demo-attempt-1' },
  body: { acknowledged: true, label: 'Example widget' },
});

const result = request.parseResponse({
  status: 202,
  headers: {
    'Content-Type': 'application/json',
    'X-Request-ID': 'example-request',
  },
  body: JSON.stringify({ state: 'pending', reference: 'synthetic-123' }),
});

if (result.kind === 'success' && result.status === 202) {
  console.log(result.data.reference); // Inferred as string.
}
```

Builders validate immediately and return a relative URL, endpoint headers,
selected policy, and a parsed JSON body when declared. The application serializes
that body, adds transport headers, sends the request, and supplies response status,
headers, and raw body text to `parseResponse`.

Requests reject unknown fields. Responses strip additive object fields while
rejecting missing required fields, changed types, and unknown enum values.
Results discriminate on `kind` and the exact declared `status`:

- `success`: a declared 2xx response with validated `data`.
- `error`: a declared non-2xx response with validated `data`.
- `protocol`: an undeclared status or invalid headers, media type, or body, with
  `issues` and no `data`. The observed status and normalized headers remain
  available; `validatedHeaders` contains independently valid declared headers.

A body valid under `200` does not pass under `202` unless both declare it.
Bodyless responses require empty text and expose `data: undefined`.

## Supported vocabulary

| Surface     | Current support                                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input       | Local JSON with `openapi: "3.1.0"`; version 2 JSON configuration and policy                                                                                             |
| Operations  | GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS; ASCII operation identifiers; whole-segment path placeholders                                                              |
| Parameters  | Operation-local nonnullable string, number, integer, or boolean path/query parameters; string headers; simple path/header and form query serialization                  |
| Bodies      | Required `application/json` request bodies; exact numeric response statuses 200–599 with at least one 2xx; JSON or bodyless responses; declared string response headers |
| Schemas     | Explicit object, array, string, number, integer, boolean, and null types; scalar `const`/`enum`; acyclic local component references and inline schemas                  |
| Constraints | String length in Unicode code points, array length, inclusive numeric bounds, and required object fields; `additionalProperties` omitted or `false`                     |

Numbers use finite JavaScript numeric values. Integer validation checks
integrality without adding an implicit safe-integer range; declare required
bounds in the schema.

Path and query names/values must contain well-formed Unicode. Header values use
HTTP byte characters, permit internal horizontal tabs, and reject other ASCII
controls or leading/trailing SP/HTAB so transport serialization preserves them.

Schema property and parameter names that belong to `Object.prototype`, such as
`toString`, `valueOf`, or `hasOwnProperty`, are unsupported. These names are legal
in OpenAPI; POM rejects them explicitly to preserve request type inference and
runtime omission behavior.

Unsupported semantics stop generation with a location-specific diagnostic before
outputs change. For example, adding `format: "uuid"` to the example widget ID
produces:

```text
POM: components.schemas.Widget.properties.id.format: unsupported keyword
```

YAML, external or recursive references, unions, formats, patterns, dynamic maps,
defaults, optional request bodies, multipart uploads, path-level parameters,
status ranges/default responses, non-bearer or referenced security schemes, and
standalone non-HTTP validators are pending. See
[architecture and next needs](ARCHITECTURE.md) for the adoption boundaries.

## Generated output

Generation uses the package's pinned formatter and writes a complete set of
modules with `.pom-manifest.json`. Exclude these files from application formatter
rewrites and use `pom check` to verify their canonical bytes.

The manifest records owned files and their content hashes. Generation updates
unchanged owned files, removes unchanged stale files, and preserves unrelated
files. An existing target without ownership or an edited generated file causes
a conflict. Keep the manifest with generated artifacts.
Changing the client selection uses this same inventory to remove unchanged
outputs for previously selected clients.

`check` is read-only, including when output is missing or invalid. CLI exit codes
are `0` for success, `1` for drift or an input/execution failure, and `2` for
invalid command usage.

Generation replaces files individually and publishes the manifest last. An
interruption can leave mismatched output or a `.pom-lock` directory. Confirm that
the writer has stopped before removing a leftover lock. Preserve uncertain files
and generate into a fresh directory, or restore a known matching output set and
manifest before retrying. An absent or invalid manifest does not authorize
replacing existing target files.

[Contributing](CONTRIBUTING.md) owns development checks and publication guidance.
[Architecture](ARCHITECTURE.md) owns requirements and future application adoption.
