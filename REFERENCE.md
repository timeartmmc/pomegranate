# Contract and configuration

This reference describes the supported input vocabulary, generated request and
validation APIs, and output ownership. Start with the [README](README.md) for
installation, [executable clients](EXECUTION.md) for calls, or
[query integration](QUERIES.md) for cache factories.

## Configuration

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
A symlinked output parent, such as macOS `/tmp`, is supported. The output
directory itself and generated target files cannot be symlinks.
For a YAML export, set `openapi` to a `.yaml` or `.yml` file; configuration stays
JSON. OpenAPI filenames with other extensions are read as JSON.
Input and configuration must be regular UTF-8 files of at most 32 MiB each.
Devices and named pipes are rejected. Malformed byte sequences fail before
outputs change.

These selection keys are shared with programmatic compilation:

| Key                | Purpose                                                                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `surfaces`         | Optional complete map of surface names to operation IDs for contracts without inline membership; see [surfaces](#client-surfaces-and-security). |
| `clients`          | Required array of declared surfaces; may be empty when `standalone` selects at least one root.                                                  |
| `standalone`       | Named component roots with `schema` and `usage: "request"` or `"response"`; see [standalone validators](#standalone-validators).                |
| `transportHeaders` | Declared request headers supplied by the transport; see [requests](#build-and-validate-a-request).                                              |
| `targets`          | Map selected clients to `"browser"` or `"native"`; required for [multipart](#multipart-requests).                                               |
| `executionClients` | Surfaces that get [executable clients](EXECUTION.md#selection-and-calls).                                                                       |
| `queries`          | Operation selections for [ordinary queries](QUERIES.md#ordinary-queries).                                                                       |
| `infiniteQueries`  | Operation bindings for [cursor](QUERIES.md#cursor-pagination) or [offset](QUERIES.md#numeric-offsets) queries.                                  |

Unknown configuration keys fail validation. Optional output selections are
disabled when omitted. `CompileOptions` accepts these keys without `version`,
`openapi`, or `output`.

## Operation policy

Policy metadata is optional. OpenAPI security always determines the credential
transport, exposed separately as `request.security.transport` (`"none"` or
`"bearer"`). Applications supply credentials and decide readiness, retry and
deadline behavior.

To require application metadata, declare its fields and requiredness:

```json
{
  "x-pom-policy": {
    "version": 3,
    "auth": {
      "public": { "transport": "none" },
      "session": { "transport": "bearer" },
      "partnerStaff": { "transport": "bearer" }
    },
    "fields": {
      "retry": { "type": "string", "enum": ["never"] },
      "timeout": { "type": "string", "enum": ["interactive"] },
      "audit": { "type": "boolean" }
    },
    "required": ["auth", "retry", "timeout"],
    "surfaces": ["consumer", "staff"]
  }
}
```

Operations select flat field values alongside inline membership:

```json
{
  "x-pom": {
    "auth": "session",
    "retry": "never",
    "timeout": "interactive",
    "surfaces": ["consumer"]
  }
}
```

`auth` bindings are optional. When declared, they define the allowed auth labels
and each supplied label must agree with effective OpenAPI security. Several
labels may share bearer transport while describing different application
readiness requirements. Labels never authorize a request.

`fields` declares application-owned values using only `type` and optional `enum`.
Types are `string`, `number`, `integer`, `boolean`, and `null`; numbers must be
finite. Enums are nonempty, unique, and match the field type. `auth` and `surfaces`
are reserved field names. Nested values, references, defaults, constraints and
other schema keywords fail explicitly. `required` names declared fields,
including `auth` when bindings exist. Unknown keys, invalid values and missing
required fields fail on every operation before selection or writes.

Omitted fields stay absent. `x-pom-policy` may be omitted entirely when no
metadata is needed; omitted operation `x-pom` becomes an empty metadata object
when requiredness and configured membership permit it. Explicit `null` or
`undefined` is invalid. Surface membership remains explicit as described below.

Generated requests expose flat values such as `policy.auth`, `policy.retry` and
`policy.timeout`. The shared `Policy` type preserves declared enums and optional
fields in builders, direct executors and query executors. It describes the
whole document's vocabulary, rather than narrowing to one operation's values.
`policy-types.ts` accompanies the runtime even for standalone-only output.
Policy and security objects are detached and frozen. No policy field enables
retries or sets a numeric deadline automatically.

`Executor` and `QueryExecutor` default to this document's `Policy`. A transport
shared across different generated documents can declare `Executor<SharedPolicy>`
or `QueryExecutor<SharedPolicy>`, where `SharedPolicy` accepts the vocabularies it
supports. Use `Readonly<Record<string, unknown>>` if the transport ignores policy;
use an explicit field/enum type when it interprets labels. Narrow transports
cannot serve incompatible policies. The fourth `PreparedRequest` type parameter
accepts the same override for explicitly annotated transport helpers.

This replaces policy version 2; configuration remains version 2. To migrate,
move root `retry` and `timeout` arrays into `fields` with string enums, add
`required: ["auth", "retry", "timeout"]`, and set policy `version` to 3.
Operation metadata stays flat. Update transports from `policy.auth.transport`
to `security.transport` and from `policy.auth.label` to `policy.auth`, then
regenerate the complete output set and run application integration checks.

## Client surfaces and security

POM recognizes `type: "http"`, `scheme: "bearer"` security schemes by their
semantics, directly or through local aliases. Scheme comparison ignores case;
`bearerFormat` is only an annotation. A supported bearer requirement names one
declared scheme with an empty role array, such as `security: [{ WidgetSession: [] }]`.

Security-scheme aliases use `$ref: "#/components/securitySchemes/<name>"`.
Component names match `[A-Za-z0-9._-]+`. References may add string `summary`
and `description` annotations; these do not change credential requirements.
Every chain must end at a supported bearer declaration. Missing targets,
cycles, malformed references and semantic siblings fail at their declaration,
including unused schemes. External references and encoded or escaped component
names are unsupported; the compiler never fetches security definitions.

An operation inherits document security when its own `security` field is absent.
Its own `[]` or `[{}]` declares public access; absence at both levels also means
no security requirement. Alternatives, combined schemes, optional bearer access,
and nonempty role requirements are rejected explicitly. The generated code never
obtains credentials or sends Authorization headers.

Every operation must belong to at least one surface. Choose one membership
owner: document `x-pom-policy.surfaces` with per-operation `x-pom.surfaces`, or a
complete configuration map:

```json
{
  "version": 2,
  "openapi": "./openapi.json",
  "output": "./generated",
  "clients": ["consumer"],
  "surfaces": {
    "consumer": ["getWidget", "prepareWidget"],
    "internal": ["getInternalReport"]
  }
}
```

This allows a supported plain OpenAPI document without POM extensions.
Configuration membership rejects inline surface declarations, even when empty.
It may coexist with inline policy fields. Every map entry has a nonempty array
of operation IDs; duplicate IDs within an entry, unknown IDs, and operations
missing from every entry fail. The same operation may belong to several surfaces.
Unselected internal surfaces still classify and validate their operations.

Surface names match
`[a-z][a-z0-9_-]{0,62}`. Unknown or duplicate names and selected surfaces without
operations fail generation. An internal-only operation can belong to a declared
surface omitted from `clients`.

Each selected surface gets a `client.<surface>.ts` entry and its own operation
and schema modules, with one shared runtime. There is no all-operations entry.
The selection name `d` uses `_d` in filenames to avoid TypeScript declaration-file
interpretation; its policy and cache identity stays `d`. The same filename rule
applies to standalone roots.
Client modules contain only schemas reachable from that client's request and
response contracts, including transitive references. All operations, schemas,
and security declarations are validated before selection, so an unsupported
unselected operation still fails generation. Surfaces control generated imports;
the server remains responsible for authorization.

Client entries export `RequestTypes` and `ResponseTypes`, indexed by their
reachable component names, for example `ResponseTypes['Widget']`.

### Standalone validators

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

## Supported vocabulary

| Surface     | Current support                                                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input       | Local OpenAPI 3.1 JSON or YAML 1.2 with any OpenAPI patch version; version 2 JSON configuration; optional version 3 policy                                                                                                                                     |
| Operations  | GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS; unique nonempty operation IDs; whole-segment path placeholders                                                                                                                                                   |
| Parameters  | Path-item inheritance and operation overrides; primitive path/query parameters; optional nullable primitive queries; repeated-key primitive query arrays; string and optional nullable string request headers; simple path/header and form query serialization |
| Bodies      | Required or optional JSON bodies; required multipart bodies; exact numeric response statuses 200–599 with at least one 2xx; JSON or bodyless responses; declared string response headers                                                                       |
| Schemas     | Explicit object, array, string, number, integer, boolean, and null types; directional fixed-object properties; scalar `const`/`enum`; acyclic local component references; restricted unions and maps described below                                           |
| Constraints | String length in Unicode code points, Unicode ECMAScript patterns, array length, inclusive/exclusive numeric bounds, `multipleOf`, and required object fields                                                                                                  |
| Formats     | String `date`, `date-time`, `uuid`, `email`, and `uri`; integer `int32`; no coercion                                                                                                                                                                           |

JSON inputs and configuration accept one leading UTF-8 byte-order mark and
reject duplicate decoded object keys. YAML files use a single YAML 1.2 core
document with JSON-compatible values. Mapping keys are strings, including
unquoted numeric response statuses. Scalar values keep their YAML types:
quote string values such as `version: "1"` and the type name in
`type: [string, "null"]`.

Operation IDs preserve their exact, case-sensitive strings in operation maps,
executable clients, query selections and cache keys. Use bracket access for IDs
such as `operations['repos/get']` or `client['get-stations']`. Private generated
symbols escape punctuation without renaming public IDs. `__proto__`, `prototype`
and `constructor` remain reserved operation IDs.

Document-level `servers` accepts an array of objects with required string `url`,
optional string `description`, and optional `variables`. Each variable has a
required string `default`, optional string `description`, and optional nonempty
string `enum` containing the default. Empty server arrays are accepted. POM checks
these shapes without parsing URLs or resolving template variables.

The application chooses and expands a server URL, then appends the generated
contract path, including any server base path. Builders keep returning the path
declared in `paths`; server configuration is not included in generated output.
For example, server `https://example.invalid/v1` and generated path `/widgets`
need `https://example.invalid/v1/widgets`. `new URL('/widgets', server)` would
discard `/v1`. Path-item and operation-level server overrides remain unsupported
and receive diagnostics.

YAML anchors and aliases support shared values with at most 1,000,000 expanded
nodes, counting mapping keys, values, and collections. Repeated small anchors
are allowed within that budget. Cycles, forward aliases, duplicate keys,
unsupported tags or directives, non-finite numbers, and bare merge keys fail
with diagnostics. Quote `"<<"` when it is a literal mapping key. YAML collections,
including through aliases, are limited to 256 nested levels; the existing schema
nesting limits also apply. YAML input uses the same contract validation and
generated format as JSON input.

Descriptive metadata is checked for location and structure and does not change
generated files:

| Location                                                 | Accepted metadata                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `info.license`                                           | Required string `name`; optional string `identifier` or `url`, mutually exclusive         |
| `info.contact`, `info.termsOfService`                    | Contact has optional string `name`, `url` and `email`; terms of service is a string       |
| Document, tags, operations, schemas (including `$ref`)   | `externalDocs` with required string `url` and optional string `description`               |
| Schemas, including `$ref` siblings                       | `example` as a JSON value; `examples` as an array of JSON values; both may coexist        |
| Parameters, response headers, JSON/multipart media types | A single JSON `example` or an `examples` map of named Example Objects, mutually exclusive |
| Operations, parameters, response headers, schemas        | Boolean `deprecated`; deprecated declarations remain generated                            |

Example Objects accept string `summary` and `description`, and a JSON `value` or
string `externalValue`, mutually exclusive. Named examples may reference
`#/components/examples/<name>`; component examples and aliases are validated,
including unused entries, with missing targets and cycles rejected. Component
example names match `[A-Za-z0-9._-]+`. Example references may add string `summary`
and `description` annotations.

Example values are documentation data, not schema rules, and are not checked
against their associated schemas. POM checks metadata shapes rather than SPDX
expressions, URI syntax or contact email syntax, and never fetches documentation,
server or license URLs or external example values. Unknown keywords and unrelated
`x-…` extensions remain rejected.

Supported schema composition is deliberately limited:

- `anyOf` has two branches: a schema and `null`, or `string` and `integer`.
- Nullable schemas accept `"type": ["string", "null"]` with any supported
  non-null type and `"null"` in either order. Exactly two distinct type names
  are required. Scalar `enum` and `const` still restrict accepted values,
  including whether `null` is accepted. Existing parameter and multipart
  restrictions still apply.
- `oneOf` uses component references without sibling constraints or defaults and
  requires an explicit discriminator mapping. Each branch requires the
  discriminator field with a distinct string literal; the mapping must cover
  every branch exactly once.
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
change requiredness, or replace explicit `undefined`. Their values must be JSON;
they are not checked against the schema's type, bounds or enum. Defaults in response
schemas are rejected, including through references, maps, and union branches.

Schemas support at most 128 structural levels, including structure behind
references. Pure aliases add no levels. Each inline schema is limited to 32
levels; use component references for deeper structures. Named types and typed
aggregate validators keep inference from expanding through every level.
Generated expressions have a separate 128-level complexity limit. Excess
nesting receives a location-specific diagnostic before formatting or writing.
Default annotations do not add schema or expression levels; YAML document
limits still apply to their values.

Numbers use finite JavaScript numeric values. Integer validation checks
integrality without adding an implicit safe-integer range; declare required
bounds in the schema. `multipleOf` uses their decimal spelling, including
scientific notation, without an epsilon tolerance.

`type: "integer", format: "int32"` restricts values to −2,147,483,648 through
2,147,483,647 inclusive. Explicit bounds and reference constraints intersect
that range and cannot widen it. Types remain `number`, with runtime integer
and range checks and no coercion. Nullable integer schemas support the same
format. `int32` on other types, format siblings on references, and `int64`
remain unsupported. Request defaults keep the annotation behavior above.

Patterns use ECMAScript 2024 syntax in Unicode (`u`) mode with Unicode 16.0
property names, matching the supported Node minimums. Newer syntax, including
inline flag modifiers and duplicate named capture groups, and newer Unicode
property names fail compilation even when the compiler's host accepts them.
Patterns support at most 128 nested capturing groups, noncapturing groups, and
lookaround assertions, counted together. Escaped parentheses, class characters,
and sequential groups do not add nesting. Excess nesting receives a dedicated
diagnostic before the parser can exhaust its ordinary stack budget.
Generated code uses its runtime's regular expression engine; Unicode character
classification can change between runtime Unicode versions. Browser and native
engines must support the pattern features used by their contracts.

Inline scalar `enum` members and `const` values must satisfy applicable bounds,
formats, `multipleOf`, and patterns without Unicode property escapes during
compilation. Matching against `\p{…}` and `\P{…}` patterns is deferred to generated
runtime validation because Unicode classification varies by engine. These
patterns also do not remove candidates from compiler reference-intersection
proofs. Null-only literals remove the non-null branch after sibling syntax
checks. Other numeric branches reject empty finite-number and integer intervals.
Reference constraints may narrow an existing enum; empty literal intersections
and contradictory bounds also fail across reference chains. These checks
diagnose supported contradictions without attempting general schema
satisfiability analysis.

`date-time` requires a calendar date, seconds, and a `Z` or `±HH:MM` timezone.
Fractional seconds and lowercase `t`/`z` are accepted without changing the input
text. Timestamps with leap seconds are unsupported.
`uuid` validates case-insensitive hexadecimal `8-4-4-4-12` syntax without adding
version or variant restrictions; braces and URN prefixes are rejected.

`email` checks ASCII [RFC 5321 Mailbox syntax](https://www.rfc-editor.org/rfc/rfc5321.html#section-4.1.2):
dot-separated atoms or a quoted local part, followed by a domain or IPv4/IPv6
address literal. Quoted spaces and escapes, single-label domains, and ASCII
Punycode spelling are accepted. Display names, comments, raw non-ASCII text,
controls and surrounding whitespace are rejected. IPv6 literals follow the SMTP
grammar, including its requirement that `::` replace at least two groups. This
is a syntax check: DNS, delivery and SMTP transport length limits are not checked.
Declare field lengths explicitly when required.

`uri` checks ASCII [RFC 3986 generic syntax](https://www.rfc-editor.org/rfc/rfc3986.html#appendix-A),
requiring a scheme. It accepts non-HTTP schemes, IPv6 and IPvFuture hosts, and
well-formed percent escapes. Relative references, raw non-ASCII text, malformed
escapes, backslashes, controls and IPv6 zone identifiers are rejected. Empty
hierarchical components and ports are permitted; numeric ports have no implicit
range limit. Scheme-specific rules and host existence are application concerns.
Use `pattern` to restrict schemes or impose a narrower application profile.

Both formats preserve the original string, including case and percent spelling;
neither resolves, decodes or normalizes values. `idn-email`, `iri`, and
`uri-reference` remain unsupported. Documentation URLs and contact emails remain
shape-checked annotations, independent of schema format assertions.

Declared formats are enforced on requests and responses. A response string that
violates its format produces a protocol failure, just like a wrong type or an
invalid date. For example, a bare hostname does not satisfy `format: "uri"`;
schemas for such values should use a string without that format assertion.

Arrays observe their length once and check all effective bounds, including
reference constraints, before reading items. Parsing visits exactly that many
positions and returns a fresh dense array. Later growth is ignored; positions
removed during parsing still undergo item validation. Missing slots cannot be
filled by inherited numeric properties. Arbitrary JSON arrays use the same policy.

Path and query names/values must contain well-formed Unicode. Header values use
HTTP byte characters, permit internal horizontal tabs, and reject other ASCII
controls or leading/trailing SP/HTAB so transport serialization preserves them.
Header names must be ASCII HTTP tokens. Declarations reserve `__proto__`,
`prototype`, and `constructor` regardless of casing. JSON responses require a single
valid `application/json` Content-Type value; quoted parameters are supported.

Fixed schema property and parameter names that belong to `Object.prototype`,
such as `toString`, `valueOf`, or `hasOwnProperty`, are unsupported. These names are legal
in OpenAPI; POM rejects them explicitly to preserve request type inference and
runtime omission behavior. Dynamic maps preserve their own JSON keys, including
`__proto__` and `constructor`.

Unsupported semantics stop generation with a location-specific diagnostic before
outputs change. For example, adding `format: "idn-email"` to the example's
`components.schemas.WidgetId` produces:

```text
POM: components.schemas.WidgetId.format: unsupported format; expected date, date-time, uuid, email or uri
```

External or recursive references, general unions and other type arrays, objects
mixing fixed properties with dynamic entries, other formats, response defaults,
optional multipart request bodies, parameter reference objects, status ranges/default
responses, non-bearer security schemes and external security-scheme references
remain unsupported.

### Directional object fields

A fixed object can share one schema across requests and responses:

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "string", "readOnly": true },
    "secret": { "type": "string", "writeOnly": true },
    "label": { "type": "string" }
  },
  "required": ["id", "secret", "label"]
}
```

The request requires `secret` and `label`; it rejects a supplied `id`, including
explicit `undefined`, non-enumerable properties and inherited properties before
`Object.prototype`. Rejection checks presence without reading the excluded value.
The response requires `id` and `label`; it strips `secret` without validating or
reading its value. Generated types and standalone validators use the same
projection, including nested objects, arrays and typed maps. An object with all
properties excluded stays a fixed empty object. Returned response data remains
mutable; these flags describe wire direction rather than TypeScript `readonly`.

Both flags must be booleans. A true flag inherited through a local reference or
alias remains true even when a sibling says false. POM rejects both flags being
true at the same schema, including through aliases. Entire source declarations,
including excluded fields, still receive syntax, reference and constraint checks.
Usage checks then inspect visible fields: an excluded write-only field may have
a request default or binary schema without affecting response validation.
Visible response defaults and binary values retain their existing restrictions.

Projection operates at fixed object property boundaries. If an active flag would
exclude an entire body, parameter/header, standalone root, array item or map
value, generation fails; POM does not silently omit those values. Inactive flags
are permitted, such as a read-only response root. True flags on `anyOf` or
`oneOf` branch roots are unsupported because their applicability can depend on
which branch succeeds; place a shared flag on the containing property or union
instead. A discriminator field must remain present and required in the direction
using its `oneOf`. These are POM's explicit projection rules; application and
server authorization remain application-owned.

## Build and validate a request

For the synthetic contract, generated usage looks like this:

```ts
import { operations } from './generated/client.consumer.ts';

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
inferred security, selected policy, and a validated body when present. The
application serializes that body, adds transport headers, validates the merged headers with
`request.validateHeaders(headers)`, sends the request, and supplies response status,
headers, and raw body text to `parseResponse`.

JSON request bodies are optional when `requestBody.required` is omitted or
`false`. The generated `body` input is optional; the whole options argument is
optional only when no other generated input is required. Omitting `body` or
supplying `undefined` prepares `bodyKind: 'none'` without a `body` property.
Explicit `null` is JSON data and is accepted only when the schema allows it;
valid `false`, `0`, empty strings and empty objects also remain JSON data.
Optional bodies retain their schemas, constraints and directional validation
when present. Defaults remain annotations and never create an omitted body.

An optional JSON operation returns a request with `bodyKind: 'none' | 'json'`.
Narrow by `bodyKind` before reading `body`. Applications serialize JSON and add
its Content-Type only for the `json` branch; the example transport already does
this. Required JSON bodies and multipart bodies retain their required inputs.
Optional multipart and all GET/HEAD request bodies remain unsupported. Response
validation is independent of whether a request body was sent.

Path placeholders use identifier names (`[A-Za-z_][A-Za-z0-9_]*`) and occupy an
entire segment. Path values cannot be empty, `.` or `..`.

Path-item `parameters` apply to every operation under that path. An operation
replaces a declaration with the same case-sensitive `name` and `in`; other
inherited parameters remain, including when the operation declares an empty
`parameters` array. Both declaration lists are validated before merging, so
overrides cannot hide unsupported schemas or serialization. Duplicates within
either list fail. Header names must also remain unique ignoring case in the
effective operation; changing only a header's casing does not count as an
override. Path placeholders must match the effective path parameters exactly.
Declaration errors retain the path-item or operation source location. Parameter
reference objects remain unsupported.

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

### Multipart requests

Multipart clients require an explicit target, for example
`"targets": { "web": "browser", "mobile": "native" }` for those selected clients.
A required `multipart/form-data` body is a fixed object of strings, files, and
file arrays. Files use `type: "string"` with `format: "binary"` or
`contentMediaType: "application/octet-stream"`. Browser inputs require `File`;
native inputs use `{ uri: string, name?: string, mediaType?: string }`, with
nonempty strings. Browser files must be instances of the environment's current
`File` constructor, with valid File metadata and Blob backing. Their identity is
preserved. Native browser, jsdom, and Happy DOM Files are supported when the same
environment's `File` and `Blob` constructors are installed together; checks follow
the current constructors when the environment changes. Direct foreign-realm
Files are unsupported. Browser transfers such as `postMessage` remain supported
when they produce a receiving-realm File. Proxy support follows the platform's
File implementation.

Every client requires its platform's `URLSearchParams` global and TypeScript
declaration. Browser upload modules also require `File` and `Blob`. Native
programs can omit DOM libraries when their platform types supply `URLSearchParams`
(the verification suite uses Node types). Compile only the native client entry
and its dependencies, excluding browser modules from a mixed-target output.

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
or literal values. Already paired CRLF text is preserved. Nested objects, nullable
files, custom part encodings, and binary values in JSON or standalone validators
are unsupported.

### Schema validation

Requests reject unknown fields in fixed objects. Responses strip additive fields
from fixed objects while rejecting missing required fields, changed types, and
unknown enum values. Declared dynamic maps validate and preserve their entries.
An object schema without `properties` entries or `additionalProperties`, such as
`{ "type": "object" }`, accepts and preserves any JSON members, as in JSON Schema.
Declare `additionalProperties: false` for an object that must be empty.
Fixed objects validate structural fields, including fields supplied by class
instances or prototypes, and return fresh plain objects. Discriminator values in
tagged unions must remain stable during parsing. Data on `Object.prototype`
never supplies a field or an unknown request key, so prototype pollution through
data, such as an unsafe merge, cannot fill a missing value. Accessors installed
there run application code and are not covered.
Dynamic maps require plain records.
Schema registries and standalone `schema` exports expose `parse(unknown)` and
`safeParse(unknown)`. `parse` returns the named output type or throws
`ValidationError`; `safeParse` returns `{ success: true, data }` or
`{ success: false, error }`. Errors expose `issues` with `path` and `message`.
Generated `RequestTypes`, `ResponseTypes`, and standalone `Input`/`Output` are
plain contract types. The validator API is limited to `parse` and `safeParse`;
it does not implement schema-library methods or the Standard Schema interface.

### Response evidence

Pass `parseResponse` numeric `status`, raw text `body`, and a plain `headers`
record with string values. Incorrect JavaScript evidence types throw `TypeError`
before protocol validation.
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

## Generated TypeScript

Generated sources use explicit relative `.ts` imports and erasable TypeScript
syntax. Supported Node versions, Bun, and TypeScript-aware bundlers can consume
them directly. For direct Node execution, place them in an ES module package
with `"type": "module"`. CommonJS packages need a separate ES module boundary or
a compilation/bundling step; Node does not convert these sources to CommonJS.
Use ES2022 runtime APIs and library declarations, plus declarations for the target
platform. The emit `target` may be ES2020 or newer for bigint syntax; lowering it
does not supply missing runtime APIs. The example uses ES2022 for both.
When emitting JavaScript with TypeScript 5.7 or newer, enable
`rewriteRelativeImportExtensions` to produce `.js` imports. For a bundler-only
`noEmit` typecheck, use `allowImportingTsExtensions`. Core and execution-only
generated modules have no package runtime dependencies; optional query modules
need Query Core. Deployed applications do not need the compiler.
Generated modules support `isolatedDeclarations`. Application exports inferred
from them still need the annotations required by that TypeScript option.

## Programmatic compiler API

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

## Generated output

Shared runtime helpers are authored in POM and copied once into each output set;
they are not customized for every operation. Generated definitions import those
local helpers. Execution and cache helpers use the same delivery model.

Generation uses the package's pinned formatter and writes a complete set of
modules with `.pom-manifest.json`. Exclude these files from application formatter
rewrites and use `pom check` to verify their canonical bytes.
Generated source is limited to 32 MiB before formatting; larger selections fail
before writing. YAML anchors can make a small input describe a much larger output.
Select fewer clients or standalone roots when a selection exceeds the limit.

Generated bytes use LF line endings. Preserve them in Git, including on Windows;
for an output directory named `generated`, add `generated/** text eol=lf` to the
consumer's `.gitattributes`. Line-ending conversion causes drift on checkout.

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
