# Pomegranate

Pomegranate (POM) compiles a strict subset of OpenAPI 3.1.0 JSON into TypeScript
request builders, Zod validators, and response validation keyed by HTTP status.
Generated code performs no network I/O. Applications own the transport and the
meaning of their authentication, retry, and timeout policy.

POM supports JSON and multipart requests, declared bearer transport requirements, and selected
client surfaces, with a synthetic example and an isolated installed-package
check. It uses one explicit operation-policy format across the owner's projects.
The package is [MIT licensed](LICENSE).

## Run the example

Use Node.js 26.x and the Bun version pinned in `package.json`. From this repository's checkout:

```sh
bun ci
bun run build
bun run example:generate
bun run example:check
bun run example:run
```

The demo injects a synthetic response and makes no network request. It prints:

```text
POST /api/widgets/demo%2Fwidget/preparations → 202 synthetic-123
```

`examples/json/openapi.json` declares distinct `200` and `202` success bodies,
distinct error bodies, required headers, a `true` constant, and bodyless HEAD and
OPTIONS operations. It also demonstrates inherited bearer security, public
overrides, and separate consumer/staff surfaces. `demo.ts` and `transport.ts` show
application-owned token resolution with a synthetic token. The transport accepts
an explicit base URL so Node and browser Fetch can resolve generated relative
paths. It sends once; applications must implement their actual authentication,
deadlines, retries, cancellation, and error handling.

## Use POM in a project

In your TypeScript project, install the compiler as a development dependency and
Zod for runtime use:

```sh
npm install --save-dev pomegranate-compiler@0.1.0
npm install zod@4.6.7
```

For compiler development, `bun pm pack` builds a local tarball that can be
installed in place of the registry package.

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
declared surface identities directly. The package installs the `pom` executable.
Generate or check the complete output set:

```sh
npx --package=pomegranate-compiler pom generate --config pom.json
npx --package=pomegranate-compiler pom check --config pom.json
```

Generated sources use explicit relative `.ts` imports and erasable TypeScript
syntax. Node 26, Bun, and TypeScript-aware bundlers can consume them directly.
They use ES2022 runtime APIs; TypeScript targets must be ES2020 or newer for
bigint literals. The example uses ES2022 target and library declarations.
When emitting JavaScript with TypeScript 5.7 or newer, enable
`rewriteRelativeImportExtensions` to produce `.js` imports. For a bundler-only
`noEmit` typecheck, use `allowImportingTsExtensions`. Zod is the only external
runtime dependency; deployed applications do not need the compiler.

For programmatic use in development tooling, pass a parsed OpenAPI `document`:

```ts
import { compile, runProject } from 'pomegranate-compiler';

const files = await compile(document, { clients: ['consumer'] });
const result = await runProject('./pom.json', { check: true });
```

`compile` returns a map of generated filenames to source strings without writing
outputs. `runProject` reads the configuration and uses the same output ownership
checks as the CLI; omit `{ check: true }` to generate files. In check mode,
`result.clean` reports whether the output agrees with the inputs, and
`result.changes` describes any drift. Both APIs validate the complete input before
selecting clients.

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

Client entries export `RequestTypes` and `ResponseTypes`, indexed by their
reachable component names, for example `ResponseTypes['Widget']`.

For a non-HTTP payload, add an explicit root to configuration:

```json
{
  "standalone": {
    "message": { "schema": "#/components/schemas/Widget", "usage": "response" }
  }
}
```

This emits `standalone.message.ts` with `schema`, `Input`, and `Output` exports
and all transitive schema dependencies. Request roots reject unknown fields;
response roots strip them and forbid defaults. `clients` may be empty when at
least one standalone root is selected. The complete input still receives
validation, including operations excluded from output.

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
selected policy, and a validated body when declared. The application serializes
that body, adds transport headers, validates the merged headers with
`request.validateHeaders(headers)`, sends the request, and supplies response status,
headers, and raw body text to `parseResponse`.
Path placeholders use identifier names (`[A-Za-z_][A-Za-z0-9_]*`) and occupy an
entire segment. Path values cannot be empty, `.` or `..`.

Configuration may name declared request headers in `transportHeaders`, for
example `"transportHeaders": ["X-Origin"]`. These headers are absent from builder
options and supplied by the application. The merged-header validator enforces
all declared header schemas and requiredness, accepts other valid HTTP headers,
rejects duplicate names ignoring case, and returns normalized lowercase names.

Declared headers use a Fetch-compatible vocabulary across clients. Endpoint
contracts reject transport-owned request headers such as `Host`, `Origin`, and
`Proxy-*`/`Sec-*` names. Response declarations reject `Set-Cookie` and
`Set-Cookie2`, which browser Fetch hides.

Form query arrays use repeated keys (`tag=one&tag=two`); an optional empty array
adds no keys. Required empty arrays fail validation because this encoding cannot
represent their required presence. Other array serialization styles are rejected.
Optional nullable primitive query parameters omit `null` and `undefined`, while
preserving `0`, `false`, empty strings allowed by the schema, and literal `"null"`
text. Non-null values still satisfy the declared constraints and formats.
Required nullable query parameters, nullable query arrays, and nullable array
items are unsupported. Optional nullable string headers also omit `null` and
`undefined`; required nullable headers are unsupported.

Multipart clients require an explicit target, for example
`"targets": { "web": "browser", "mobile": "native" }` for those selected clients.
A required `multipart/form-data` body is a fixed object of strings, files, and
file arrays. Files use `type: "string"` with `format: "binary"` or
`contentMediaType: "application/octet-stream"`. Browser inputs require `File`;
native inputs use `{ uri: string, name?: string, mediaType?: string }`, with
nonempty strings. Every client requires its platform's `URLSearchParams` global
and TypeScript declaration. Browser upload modules also require `File`. A native
program can omit DOM libraries when its platform types supply `URLSearchParams`
(the verification suite uses Node types); compile only its client entry and
dependencies, excluding browser modules from a mixed-target output.

Prepared uploads have `bodyKind: "multipart"`, the complete validated `body`, and
a `multipart` field inventory (`name`, `kind`, `multiple`, `required`). Applications
resolve native references and serialize every field, repeating parts for file
arrays. Required file arrays cannot be empty; optional empty arrays omit parts.
The application owns file access, `FormData`, progress, and fresh retry bodies.
Let the transport set multipart Content-Type and its boundary. POM neither reads
files nor serializes uploads. Multipart names must be ASCII HTTP tokens; text
values must contain well-formed Unicode and use CRLF pairs for line breaks.
Builders reject isolated CR or LF instead of silently normalizing text: FormData
would expand those characters after schema validation, changing lengths, patterns,
or literal values. Already paired CRLF text is preserved. Nested objects, nullable files, custom
part encodings, and binary values in JSON or standalone validators are unsupported.

Requests reject unknown fields in fixed objects. Responses strip additive fields
from fixed objects while rejecting missing required fields, changed types, and
unknown enum values. Declared dynamic maps validate and preserve their entries.
Fixed objects validate structural fields, including fields supplied by class
instances or prototypes, and return fresh plain objects. Dynamic maps require
plain records.
Results discriminate on `kind` and the exact declared `status`:

- `success`: a declared 2xx response with validated `data`.
- `error`: a declared non-2xx response with validated `data`.
- `protocol`: an undeclared status or invalid headers, media type, or body, with
  `issues` and no `data`. The observed status and normalized headers remain
  available; `validatedHeaders` contains independently valid declared headers.

Schema failures include a validator message and a `path` relative to the body
or headers. Other protocol issues may omit `path`.

A body valid under `200` does not pass under `202` unless both declare it.
Bodyless responses require empty text and expose `data: undefined`.

## Supported vocabulary

| Surface     | Current support                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input       | Local JSON with `openapi: "3.1.0"`; version 2 JSON configuration and policy                                                                                                                                     |
| Operations  | GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS; ASCII operation identifiers; whole-segment path placeholders                                                                                                      |
| Parameters  | Primitive path/query parameters; optional nullable primitive queries; repeated-key primitive query arrays; string and optional nullable string request headers; simple path/header and form query serialization |
| Bodies      | Required JSON or multipart request bodies; exact numeric response statuses 200–599 with at least one 2xx; JSON or bodyless responses; declared string response headers                                          |
| Schemas     | Explicit object, array, string, number, integer, boolean, and null types; scalar `const`/`enum`; acyclic local component references; restricted unions and maps described below                                 |
| Constraints | String length in Unicode code points, Unicode ECMAScript patterns, array length, inclusive/exclusive numeric bounds, `multipleOf`, and required object fields                                                   |
| Formats     | String `date`, `date-time`, and `uuid`; values remain strings without coercion                                                                                                                                  |

Supported schema composition is deliberately limited:

- `anyOf` has two branches: a schema and `null`, or `string` and `integer`.
- `oneOf` uses component references with an explicit discriminator mapping.
  Each branch requires the discriminator field with a distinct string literal;
  the mapping must cover every branch exactly once.
- Objects with fixed properties use `additionalProperties: false` or omission.
  Pure maps set `additionalProperties` to a schema or `true` for arbitrary JSON
  values. Mixing fixed properties with dynamic entries is unsupported.
- Local `$ref` schemas may add string, numeric, or array constraints appropriate
  to the referenced type. Other semantic siblings are rejected.

Component schema names match `[A-Za-z0-9._-]+`, including hyphens, dots, and
leading digits. References, discriminator mappings, and generated schema maps
preserve the exact names. `__proto__`, `prototype`, and `constructor` remain
reserved names.

Request `default` values are annotations: they do not fill omitted fields,
change requiredness, or replace explicit `undefined`. Defaults in response
schemas are rejected, including through references, maps, and union branches.

Schemas support at most 128 structural levels, including structure behind
references. Pure aliases add no levels. Each inline schema is limited to 32
levels; use component references for deeper structures. Named types and typed
aggregate validators keep inference from expanding through every level.
Generated expressions have a separate 128-level complexity limit, including
constraint wrappers. Excess nesting receives a location-specific diagnostic
before formatting or writing. Deep default annotations do not count.

Numbers use finite JavaScript numeric values. Integer validation checks
integrality without adding an implicit safe-integer range; declare required
bounds in the schema. `multipleOf` uses their decimal spelling, including
scientific notation, without an epsilon tolerance.

`date-time` requires a calendar date, seconds, and a `Z` or `±HH:MM` timezone.
Fractional seconds and lowercase `t`/`z` are accepted without changing the input
text. Timestamps with leap seconds are unsupported.
`uuid` validates case-insensitive hexadecimal `8-4-4-4-12` syntax without adding
version or variant restrictions; braces and URN prefixes are rejected.

Array bounds use Zod's native checks, so oversized bounded arrays are rejected
before their items are validated.

Path and query names/values must contain well-formed Unicode. Header values use
HTTP byte characters, permit internal horizontal tabs, and reject other ASCII
controls or leading/trailing SP/HTAB so transport serialization preserves them.
Header names must be ASCII HTTP tokens; `__proto__`, `prototype`, and `constructor`
are reserved regardless of casing. JSON responses require a single
valid `application/json` Content-Type value; quoted parameters are supported.

Fixed schema property and parameter names that belong to `Object.prototype`,
such as `toString`, `valueOf`, or `hasOwnProperty`, are unsupported. These names are legal
in OpenAPI; POM rejects them explicitly to preserve request type inference and
runtime omission behavior. Dynamic maps preserve their own JSON keys, including
`__proto__` and `constructor`.

Unsupported semantics stop generation with a location-specific diagnostic before
outputs change. For example, adding `format: "email"` to the example's
`components.schemas.WidgetId` produces:

```text
POM: components.schemas.WidgetId.format: unsupported format; expected date, date-time or uuid
```

YAML, external or recursive references, general unions and type arrays, objects
mixing fixed properties with dynamic entries, other formats, response defaults,
optional request bodies, path-level parameters, status ranges/default responses,
non-bearer or referenced security schemes
remain unsupported. See
[architecture and next needs](ARCHITECTURE.md) for the adoption boundaries.

## Generated output

Generation uses the package's pinned formatter and writes a complete set of
modules with `.pom-manifest.json`. Exclude these files from application formatter
rewrites and use `pom check` to verify their canonical bytes.

The manifest records owned files and their content hashes. Generation updates
unchanged owned files, removes unchanged stale files, and preserves unrelated
files. An existing target without ownership or an edited generated file causes
a conflict. Keep the manifest with generated artifacts.
Inventory names must be distinct ignoring ASCII case, including on
case-sensitive filesystems; aliases are rejected before outputs change.
Changing the client selection uses this same inventory to remove unchanged
outputs for previously selected clients.

`check` is read-only, including when output is missing or invalid. CLI exit codes
are `0` for success, `1` for drift or an input/execution failure, and `2` for
invalid command usage. Bare `pom` and `pom --help` print usage and exit `0`.

Generation stages the complete output and records its prior and intended states
in `.pom-journal.json` before replacing files individually. It publishes the
manifest last, then removes the journal. A valid pending journal lets the next
`generate` finish the interrupted output set before applying the current inputs.
Recovery accepts only recorded prior or intended file states and preserves
conflicting edits. `check` reports interrupted output without recovering it.

An interruption can leave a `.pom-lock` directory. Confirm that the writer has
stopped before removing a leftover lock, then retry generation with the journal
intact. Generation checks lock ownership before publishing and cleaning up.
If recovery evidence is invalid or files conflict, preserve uncertain files and
generate into a fresh directory, or restore a known matching output set and
manifest before retrying. An absent manifest alone does not authorize replacing
existing target files.

[Contributing](CONTRIBUTING.md) owns development checks and publication guidance.
[Architecture](ARCHITECTURE.md) owns requirements and future application adoption.
