# Contract and configuration

This reference covers supported inputs, generated request and validation APIs,
and generated files. Start with the [README](README.md) for installation,
[executable clients](EXECUTION.md) for calls, or [query integration](QUERIES.md)
for cache factories.

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
declared surfaces. The package installs the `pom` executable. A symlinked output
parent, such as macOS `/tmp`, is supported. The output directory itself and
generated target files cannot be symlinks. For a YAML export, set `openapi` to a
`.yaml` or `.yml` file; configuration stays JSON. OpenAPI filenames with other
extensions are read as JSON. Input and configuration must be regular UTF-8 files
of at most 32 MiB each. Devices and named pipes are rejected. Malformed byte
sequences fail before outputs change.

These selection keys are shared with programmatic compilation:

| Key                  | Purpose                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `surfaces`           | Optional complete map of surface names to operation IDs for contracts without inline membership; see [surfaces](#client-surfaces-and-security). |
| `formats`            | Optional named string-pattern validators; see [registered formats](#registered-formats).                                                        |
| `clients`            | Required array of declared surfaces; may be empty when `standalone` selects at least one root.                                                  |
| `ignoreExtensions`   | Exact unrelated `x-…` annotation keywords to ignore; POM metadata remains validated.                                                            |
| `standalone`         | Named component roots with `schema` and `usage: "request"` or `"response"`; see [standalone validators](#standalone-validators).                |
| `recursiveWorkLimit` | Positive safe integer setting the generated recursive traversal visit cap; defaults to 100,000. See [recursive schemas](#recursive-schemas).    |
| `transportHeaders`   | Declared request headers supplied by the transport; see [requests](#build-and-validate-a-request).                                              |
| `targets`            | Map selected clients to `"browser"` or `"native"`; required for [multipart](#multipart-requests).                                               |
| `executionClients`   | Surfaces that get [executable clients](EXECUTION.md#selection-and-calls).                                                                       |
| `queries`            | Operation selections for [ordinary queries](QUERIES.md#ordinary-queries).                                                                       |
| `infiniteQueries`    | Operation bindings for [cursor](QUERIES.md#cursor-pagination) or [offset](QUERIES.md#numeric-offsets) queries.                                  |

Unknown configuration keys fail validation. Optional output selections are
disabled when omitted. `CompileOptions` accepts these keys without `version`,
`openapi`, or `output`.

Unrelated `x-…` extension keywords require an explicit `ignoreExtensions` list,
for example `"ignoreExtensions": ["x-generator-note"]`. Unlisted extensions
fail, including in unselected operations and unused components. The list accepts
exact, unique names; wildcards and reserved POM names are rejected. Empty or
omitted lists ignore nothing. POM metadata (`x-pom`, `x-pom-policy`) remains
validated. The known semantic extension `x-multi-segment` changes path behavior
and always receives a diagnostic, even when listed.

Filtering removes extension keywords only at supported OpenAPI locations. It
preserves property, component, header, example and server-variable names, plus
example/default values, discriminator mappings, security requirements and POM
policy metadata.

### Registered formats

Define reusable string validators in `pom.json`, or the same `formats` option
when using `compile`:

```json
{
  "formats": {
    "booking-code": {
      "type": "string",
      "pattern": "^RES-[0-9]{6}$"
    }
  }
}
```

Use `"type": "string", "format": "booking-code"` in the OpenAPI schema. POM
checks the named pattern on requests, responses, and standalone validators.
Format names match exactly, including case. Undefined names fail compilation,
and built-in names cannot be overridden. Every definition is checked, including
unused ones, before outputs change. Only definitions reachable from a selected
schema enter generated code. Use an application-specific prefix to avoid name
collisions with future built-in formats. A collision fails compilation before
files change.

Definitions accept exactly `type: "string"` and a string `pattern`, using the
same Unicode regular-expression syntax and limits as schema patterns. Registered
patterns must match the whole value: `[A-Z]{3}` accepts `USD` and rejects
`xxUSDxx` or a trailing newline. This differs from a schema `pattern`, which
keeps its standard search behavior. No custom flags, JavaScript callbacks,
imports, or executable configuration are accepted. A format does not infer a
type or coerce values. Nullable string schemas apply the rule to non-null
values. An enum or a schema's own `pattern` adds independent constraints; both
patterns must match. References inherit their target's format, with existing
restrictions on semantic reference siblings.

Generated code performs these checks without the compiler or application source
modules. Use a built-in format or application validation for rules a pattern
cannot express.

## Operation policy

Policy metadata is optional. OpenAPI security determines the credential
requirements, exposed separately as `request.security`. Its `transport` is
`"none"`, `"apiKey"`, `"basic"`, `"bearer"`, `"oauth2"`, or `"alternatives"`.
Each credential requirement preserves the exact component name as `scheme`.
Applications use these identities and the declared policy to select credentials
and decide readiness, retry and deadline behavior.

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
and each supplied label's transport must agree with effective OpenAPI security.
Several labels may share a transport while describing different application
readiness requirements. An OR or AND expression uses `"alternatives"`, including
optional access; it cannot use a `"none"` or single-scheme label even when one
of its alternatives is anonymous or every requirement uses bearer credentials.
Labels never select an alternative or authorize a request; credential identity
comes from each requirement's `scheme`.

`fields` declares application metadata using only `type` and optional `enum`.
Types are `string`, `number`, `integer`, `boolean`, and `null`; numbers must be
finite. Enums are nonempty, unique, and match the field type. `auth` and
`surfaces` are reserved field names. Nested values, references, defaults,
constraints and other schema keywords fail explicitly. `required` names declared
fields, including `auth` when bindings exist. Unknown keys, invalid values and
missing required fields fail on every operation before selection or writes.

Omitted fields stay absent. `x-pom-policy` may be omitted entirely when no
metadata is needed; omitted operation `x-pom` becomes an empty metadata object
when requiredness and configured membership permit it. Explicit `null` or
`undefined` is invalid. Surface membership remains explicit as described below.

Generated requests expose flat values such as `policy.auth`, `policy.retry` and
`policy.timeout`. The shared `Policy` type preserves declared enums and optional
fields in builders, direct executors and query executors. It describes the whole
document's vocabulary, rather than narrowing to one operation's values.
`policy-types.ts` accompanies the runtime even for standalone-only output.
Policy and security objects are copied and frozen, including nested security
requirements, alternatives, and scope arrays. Metadata records have null
prototypes, so absent metadata stays absent when `Object.prototype` changes; use
`Object.hasOwn` to check presence. No policy field enables retries or sets a
numeric deadline automatically.

`Executor` and `QueryExecutor` default to this document's `Policy`. A transport
shared across different generated documents can declare `Executor<SharedPolicy>`
or `QueryExecutor<SharedPolicy>`, where `SharedPolicy` accepts the vocabularies
it supports. Use `Readonly<Record<string, unknown>>` if the transport ignores
policy; use an explicit field/enum type when it interprets labels. Narrow
transports cannot serve incompatible policies. The fourth `PreparedRequest` type
parameter accepts the same override for explicitly annotated transport helpers.

This replaces policy version 2; configuration remains version 2. To migrate,
move root `retry` and `timeout` arrays into `fields` with string enums, add
`required: ["auth", "retry", "timeout"]`, and set policy `version` to 3.
Operation metadata stays flat. Update transports from `policy.auth.transport` to
`security.transport` and from `policy.auth.label` to `policy.auth`, then
regenerate the complete output set and run application integration checks.

## Client surfaces and security

POM supports these security schemes directly or through local aliases:

| OpenAPI declaration                                                    | Generated credential requirement            |
| ---------------------------------------------------------------------- | ------------------------------------------- |
| `type: "apiKey"`, `in: "header"`, `"query"`, or `"cookie"`, and `name` | `{ transport: "apiKey", scheme, in, name }` |
| `type: "http"`, `scheme: "basic"`                                      | `{ transport: "basic", scheme }`            |
| `type: "http"`, `scheme: "bearer"`                                     | `{ transport: "bearer", scheme }`           |
| `type: "oauth2"`, with declared `flows`                                | `{ transport: "oauth2", scheme, scopes }`   |

HTTP scheme comparison ignores case; `bearerFormat` is only an annotation. Every
requirement preserves its exact declared component name as `scheme`, including
an alias. API keys also preserve their declared location and name. Key names
must be nonempty, with well-formed Unicode; header and cookie names must use
HTTP token characters. Changing credential identity, key location/name, or
required scopes changes generated output and is detected by `pom check`.

OAuth2 supports `implicit`, `password`, `clientCredentials`, and
`authorizationCode` flow declarations. Each flow must supply its applicable
authorization/token URLs and a scope-description map; `refreshUrl` is optional.
Relative URL references are accepted. Required scopes must appear in at least
one of the scheme's flows. An empty requirement array means no scopes are
required. Flow URLs and available scope descriptions are validated but are not
emitted: the application owns provider configuration and token acquisition.
Non-OAuth requirements must use empty arrays; nonempty role requirements remain
explicitly unsupported, including in OpenAPI 3.1.

An operation inherits document security when its own `security` field is absent.
Its own `[]` or `[{}]` declares public access; absence at both levels also means
no security requirement. Public requests expose `{ transport: "none" }`. A
single requirement for a single scheme is exposed directly, for example
`{ transport: "bearer", scheme: "WidgetSession" }`.

Multiple requirement objects mean OR; multiple schemes in one object mean AND.
POM retains these as `{ transport: "alternatives", alternatives }`, where the
outer array contains alternatives and each inner array contains all credentials
required for that alternative. An empty inner array represents anonymous access.
For example:

```json
{
  "security": [
    { "WidgetKey": [], "WidgetOAuth": ["widgets:read"] },
    { "WidgetSession": [] },
    {}
  ]
}
```

The resulting `request.security` is:

```ts
{
  transport: 'alternatives',
  alternatives: [
    [
      { transport: 'apiKey', scheme: 'WidgetKey', in: 'header', name: 'X-Widget-Key' },
      { transport: 'oauth2', scheme: 'WidgetOAuth', scopes: ['widgets:read'] },
    ],
    [{ transport: 'bearer', scheme: 'WidgetSession' }],
    [],
  ],
}
```

This permits a key **and** an OAuth token, **or** a bearer token, **or**
anonymous access. The application chooses an alternative and supplies every
credential in it. Requirement and scope order is retained; it does not establish
a credential-selection preference. Generated clients export `Security` and
`SecurityRequirement` for application transports.

Security-scheme aliases use `$ref: "#/components/securitySchemes/<name>"`.
Component names match `[A-Za-z0-9._-]+`. In 3.1, references may add string
`summary` and `description` annotations; these do not change credential
requirements. Every chain must end at a supported security declaration. Missing
targets, cycles, malformed references and semantic siblings fail at their
declaration, including unused schemes. External references and encoded or
escaped component names are unsupported; the compiler never fetches security
definitions.

The generated code never obtains tokens, encodes passwords, inserts API keys, or
sends credential headers, query parameters, or cookies. OpenID Connect, mutual
TLS, HTTP schemes other than basic/bearer, and external security-scheme
references remain unsupported with explicit diagnostics.

Every operation must belong to at least one surface. Choose one membership
owner: document `x-pom-policy.surfaces` with per-operation `x-pom.surfaces`, or
a complete configuration map:

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
missing from every entry fail. The same operation may belong to several
surfaces. Unselected internal surfaces still classify and validate their
operations.

Surface names match `[a-z][a-z0-9_-]{0,62}`. Unknown or duplicate names and
selected surfaces without operations fail generation. An internal-only operation
can belong to a declared surface omitted from `clients`.

Each selected surface gets a `client.<surface>.ts` entry and its own operation
and schema modules, with one shared runtime. There is no all-operations entry.
The selection name `d` uses `_d` in filenames to avoid TypeScript
declaration-file interpretation; its policy and cache identity stays `d`. The
same filename rule applies to standalone roots. Client modules contain only
schemas reachable from that client's request and response contracts, including
transitive references. All operations, schemas, and security declarations are
validated before selection, so an unsupported unselected operation still fails
generation. Surfaces control generated imports; the server remains responsible
for authorization.

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

This emits `standalone.message.ts` with `schema`, `Input`, `Output` and the
required schema dependencies. It follows the same [request and response
validation rules](#schema-validation) as an operation. `clients` may be empty
when at least one standalone root is selected. The complete contract is still
validated, including operations excluded from output.

## Supported vocabulary

| Surface     | Current support                                                                                                                                                                                                                                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input       | Local OpenAPI 3.0.x or 3.1.x JSON or YAML 1.2 with any patch version; version 2 JSON configuration; optional version 3 policy                                                                                                                                                                                                          |
| Operations  | GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS; unique explicit or generated operation IDs; whole-segment path placeholders                                                                                                                                                                                                              |
| Parameters  | Path-item inheritance and operation overrides; local component references and aliases; primitive path/query parameters; optional nullable primitive queries; primitive query arrays with repeated keys or comma-separated values; string and optional nullable string request headers; simple path/header and form query serialization |
| Bodies      | Required or optional JSON/text bodies; required multipart bodies; response statuses 200–599, ranges `2XX`–`5XX`, and `default`, with at least one possible success; JSON, text, or bodyless responses; string response headers; local component references and aliases                                                                 |
| Schemas     | Unconstrained JSON; explicit object, array, string, number, integer, and boolean types; 3.1 also supports null types and scalar `const`; scalar `enum`; directional fixed-object properties; productive local component references; restricted unions and maps described below                                                         |
| Constraints | String length in Unicode code points, Unicode ECMAScript patterns, array length and `uniqueItems`, object property counts, inclusive/exclusive numeric bounds, `multipleOf`, and required object fields                                                                                                                                |
| Formats     | String `date`, `date-time`, `uuid`, `email`, `uri`, `ipv4`, `ipv6`, and `byte`; string `password` hint; integer `int32` and safe numeric `int64`; string `int64`; number `float` and `double`; no coercion                                                                                                                             |

### OpenAPI versions

Schema syntax follows the declared OpenAPI version. OpenAPI 3.0 schemas use
`nullable: true` alongside a single explicit `type`, and boolean
`exclusiveMinimum` / `exclusiveMaximum` alongside `minimum` / `maximum`. A
nullable enum accepts null only when its enum lists null. Without a same-object
`type`, `nullable: true` has no effect under OpenAPI; POM diagnoses that active
flag instead of silently discarding it. `nullable: false` may be omitted. Use a
single-value `enum` for 3.0 literals. POM accepts and ignores `false` exclusive
flags, including without a bound. As a stricter POM policy, `true` requires a
same-object `type: number` or `type: integer` and its matching finite `minimum`
or `maximum`. Incomplete or inapplicable active flags receive a diagnostic
instead of silently doing nothing.

For fixed objects in 3.0, omit `required` when no properties are required; an
explicit empty array is rejected. In 3.1, `required: []` is also accepted.

`required` may name a member that `properties` does not declare, including after
`allOf` composition. In an open object the member becomes a required field
holding any JSON value, exactly as if it were declared with the empty schema
`{}`. An object that lists only `required` names is therefore a fixed object of
those fields. Under `additionalProperties: false` the same name is forbidden and
required at once, and receives a diagnostic. A required name is a fixed member,
so beside an explicit dynamic `additionalProperties` it is the unsupported
mixture of fixed and dynamic members, directly or through `allOf`.

OpenAPI 3.1 uses null types/type arrays and numeric exclusive bounds. Schema
`const`, `$comment`, `examples`, and `contentMediaType`, plus `info.summary` and
`info.license.identifier`, are accepted only in 3.1. `nullable` is accepted only
in 3.0. Parameter/media-type named `examples` and schema `example` work in both.

OpenAPI 3.0 ignores every sibling of `$ref`. POM follows that for the
annotations `title`, `description`, `example`, `deprecated`, and `externalDocs`:
they are dropped without being interpreted, for every kind of reference. Any
other sibling receives a diagnostic, because POM must not silently lose an
intended constraint or apply 3.1 reference semantics. In 3.1, supported schema
constraint siblings and non-schema reference `summary` / `description`
annotations remain accepted. DELETE and OPTIONS request body declarations are
rejected in 3.0: OpenAPI 3.0 tells consumers to ignore bodies whose semantics
HTTP does not define, and POM reports an error rather than silently discarding a
declaration. Bodyless DELETE/OPTIONS operations remain supported, and 3.1
permits their bodies. Both dialects lower into the same generated API and
validators; equivalent contracts produce identical output. See the [3.0 schema
specification](https://spec.openapis.org/oas/v3.0.4.html#schema-object) and [3.1
migration guide](https://learn.openapis.org/upgrading/v3.0-to-v3.1.html).
OpenAPI 2.0 and 3.2 are unsupported.

### Content types

Request and response content supports `application/json`, concrete media types
with a `+json` suffix, and `text/plain`; requests also support multipart as
below, and responses also support media ranges. One representation is selected
for each request. Request preference is `application/json`, then other `+json`
types sorted by their lowercase names, then `text/plain`, then multipart.
Request selection is independent of declaration order. All declarations still
receive validation, including nonpreferred request entries; unsupported media
types and schemas still fail compilation. The multipart requiredness restriction
applies only when multipart is selected; an optional JSON or text request may
also declare a valid multipart alternative.

Content-map keys are media types without parameters. Request keys must be
concrete; wildcard request media is rejected. Response keys may also be the
ranges `type/*` and `*/*`. Other wildcard spellings, such as `*/json` or
`application/*+json`, are rejected. Case-insensitive duplicates fail. JSON
suffixes select JSON decoding, but do not make different media types
interchangeable. Responses retain every supported declaration for each status,
range, and `default`. The observed Content-Type selects its declared schema and
one JSON or text decoder. Valid parameters such as `charset=utf-8` are accepted
when matching that media type. Missing, malformed, duplicate or undeclared
Content-Type produces a protocol failure without decoding or trying another
schema; there is no body sniffing or fallback. Applications own Accept
negotiation. Unsupported media declarations still fail compilation.

Only the most specific response key applies to an observed type: the concrete
type, then its `type/*` range, then `*/*`. Under a range, the observed
Content-Type selects the decoder: JSON for `application/json` and `+json` types,
text for `text/plain`. The range's schema validates the decoded value, so an
object schema under `*/*` accepts a JSON object and rejects plain text. Any
other observed type, such as `image/png` or `text/html`, is a protocol failure,
even when a wider range is also declared. A range is only ever a declaration: an
observed Content-Type that itself contains a wildcard, such as
`application/*+json`, is invalid and fails before matching a range or decoding.

A media entry may omit `schema`. JSON media then accepts any JSON value, exactly
like the [empty schema](#supported-vocabulary) `{}`, and `text/plain` accepts
any string, in requests and responses. An explicit empty schema, or an alias to
one, also accepts any string under `text/plain` and generates a string type for
that media use. Other JSON uses of the same component stay unconstrained. A
range without a schema accepts whatever its decoder produces. Multipart bodies
require a schema.

Successful and declared-error results expose `contentType`, the validated
lowercase media type without parameters. It is a literal discriminator tied to
`data`; checking it narrows the corresponding generated body type. A range
reports the observed type, typed as a pattern such as `` `text/${string}` ``. A
concrete `contentType` check cannot exclude a range that covers that type, so
the narrowed `data` keeps both declarations' types when their schemas differ.
Bodyless results have `contentType: undefined` and `data: undefined`. Original
observed header values remain available in `headers`. All representation schemas
enter the selected client's transitive projection.

`text/plain` requires a nonnullable string schema, including supported
constraints and local references. Text is passed through without JSON quoting or
parsing; empty strings and line breaks remain data. Transports own byte
encoding/decoding. POM receives already-decoded JavaScript text; matching a
Content-Type parameter does not decode bytes or validate the declared charset.
Decode response bytes according to the endpoint's charset before calling
`parseResponse`. [Fetch
`Response.text()`](https://fetch.spec.whatwg.org/#dom-body-text) always decodes
as UTF-8; other encodings need `arrayBuffer()` and an appropriate decoder. For
text requests, send a Content-Type charset consistent with the encoded bytes.
Text requests reject isolated UTF-16 surrogates because transport encoding would
replace them after validation. Form-encoded bodies and binary downloads remain
unsupported.

### JSON and YAML

JSON inputs and configuration accept one leading UTF-8 byte-order mark and
reject duplicate decoded object keys. YAML files use a single YAML 1.2 core
document with JSON-compatible values. Mapping keys are strings, including
unquoted numeric response statuses. Scalar values keep their YAML types: quote
string values such as `version: "1"`. In 3.1 type arrays, quote the null type
name as in `type: [string, "null"]`.

YAML anchors and aliases support shared values with at most 1,000,000 expanded
nodes, counting mapping keys, values and collections. Cycles, forward aliases,
duplicate keys, unsupported tags or directives, non-finite numbers and bare
merge keys fail. Quote `"<<"` when it is a literal mapping key. YAML
collections, including through aliases, are limited to 256 nested levels. Schema
nesting limits also apply. YAML and JSON inputs produce the same generated
format.

### Operation IDs

When `operationId` is absent, POM generates the exact uppercase method, one
space, and the declared path: `GET /widgets/{id}`. Use that name in configured
surface membership, query selections, and generated member access such as
`operations['GET /widgets/{id}']`. Names depend only on method and path;
reordering or adding unrelated operations never changes them. A collision with
an explicit ID receives the existing duplicate-ID diagnostic. Explicit IDs must
still be nonempty strings; null and empty values do not request a generated
name.

Operation IDs preserve their exact, case-sensitive strings in operation maps,
executable clients, query selections and cache keys. Use bracket access for IDs
such as `operations['repos/get']` or `client['get-stations']`. Private generated
symbols escape punctuation without renaming public IDs. `__proto__`, `prototype`
and `constructor` remain reserved operation IDs.

### Servers

`servers` at the document, Path Item, and Operation levels accepts an array of
objects with required string `url`, optional string `description`, and optional
`variables`. Each variable has a required string `default`, optional string
`description`, and optional nonempty string `enum` containing the default. Empty
server arrays are accepted. POM checks these shapes without parsing URLs or
resolving template variables.

The application chooses and expands a server URL, then appends the generated
contract path, including any server base path. Builders keep returning the path
declared in `paths`; POM never builds an absolute URL. For example, server
`https://example.invalid/v1` and generated path `/widgets` need
`https://example.invalid/v1/widgets`. `new URL('/widgets', server)` would
discard `/v1`.

The document's servers are application configuration and are not included in
generated output. A Path Item or Operation list overrides them for its
operations, so those requests expose it as `request.servers`: the Operation's
list when it declares one, else its Path Item's. An explicit empty list is still
the nearest declaration: `request.servers` is then `[]`, and the operation must
not be sent to a parent's or the document's server. OpenAPI defines the default
server `/` only for the document, so the application decides how to address an
operation whose override names no server. Each entry is a frozen
`{ url, variables }` record in declaration order, where `variables` maps each
name to its `default` and `enum`; `enum` is `undefined` when the variable
declares none, and descriptions are omitted. Without a declared override,
`request.servers` is an own `undefined` field. The transport selects and expands
an override exactly as it does the document's servers. Client entries export the
`Server` type.

### Annotations

Descriptive metadata is checked for location and structure and does not change
generated files:

| Location                                                               | Accepted metadata                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `info.license`                                                         | Required string `name`; optional string `url`, or 3.1-only `identifier`, mutually exclusive |
| `info.contact`, `info.termsOfService`                                  | Contact has optional string `name`, `url` and `email`; terms of service is a string         |
| Document, tags, operations, schemas (3.1 also permits `$ref` siblings) | `externalDocs` with required string `url` and optional string `description`                 |
| Schemas (3.1 also permits `$ref` siblings)                             | `example` as a JSON value; 3.1 also accepts string `$comment` and an `examples` array       |
| Parameters, response headers, supported media types                    | A single JSON `example` or an `examples` map of named Example Objects, mutually exclusive   |
| Operations, parameters, response headers, schemas                      | Boolean `deprecated`; deprecated declarations remain generated                              |

Example Objects accept string `summary` and `description`, and a JSON `value` or
string `externalValue`, mutually exclusive. Named examples may reference
`#/components/examples/<name>`; component examples and aliases are validated,
including unused entries, with missing targets and cycles rejected. Component
example names match `[A-Za-z0-9._-]+`. In 3.1, example references may add string
`summary` and `description` annotations.

Example values are documentation data, not schema rules, and are not checked
against their associated schemas. POM checks metadata shapes rather than SPDX
expressions, URI syntax or contact email syntax, and never fetches
documentation, server or license URLs or external example values. Unsupported
standard keywords remain rejected. Unrelated `x-…` extension keywords require an
explicit [`ignoreExtensions`](#configuration) entry.

### Schema forms

Supported schema composition:

- [`allOf`](#allof-composition) supports single-branch wrappers and fixed-object
  or scalar compositions, including constrained overlapping fields, under the
  limits below.
- `anyOf` accepts two or more supported schemas. A value is valid when any
  branch accepts it, and POM returns the first matching branch's parsed value
  in declaration order. Fixed-object branches keep their direction rules:
  requests reject fields unknown to a branch and responses strip them, so the
  first matching response branch decides which fields remain. Nested
  alternatives that accept the same JSON type may validate one value again in
  each branch; POM rejects contracts where that could exceed 1,024 evaluations
  of one value, outside recursive regions, which keep their runtime budgets. A
  `type: "null"` branch requires 3.1; 3.0 nullable schemas use
  `nullable: true` as described above.
- `oneOf` without a discriminator requires branches that accept disjoint JSON
  types: null, boolean, string, number (including integer), array, and object.
  Exactly one branch can then match. Use a discriminator for object
  alternatives, or `anyOf` when the first matching branch is acceptable.
- In 3.1, nullable schemas accept `"type": ["string", "null"]` with any supported
  non-null type and `"null"` in either order. Exactly two distinct type names
  are required. Scalar `enum` and `const` still restrict accepted values,
  including whether `null` is accepted. Existing parameter and multipart
  restrictions still apply.
- A discriminated `oneOf` uses component references without sibling
  constraints and requires an explicit discriminator mapping. Each branch requires the
  discriminator field with a distinct string literal; the mapping must cover
  every branch exactly once.
- Objects with fixed properties use `additionalProperties: false` or omission.
  Pure maps set `additionalProperties` to a schema or `true` for arbitrary JSON
  values. Mixing fixed properties with dynamic entries is unsupported.
- In 3.1, local `$ref` schemas may add string, numeric, or array constraints, or
  `minProperties` and `maxProperties`, appropriate to the referenced type.
  Other semantic siblings are rejected.

In 3.0, make a component reference nullable with an `anyOf` null-only branch:

```json
{
  "anyOf": [
    { "$ref": "#/components/schemas/Widget" },
    { "type": "string", "nullable": true, "enum": [null] }
  ]
}
```

The second branch accepts only null. The referenced schema still validates every
non-null value.

Component schema names match `[A-Za-z0-9._-]+`, including hyphens, dots, and
leading digits. References, discriminator mappings, and generated schema maps
preserve the exact names. `__proto__`, `prototype`, and `constructor` remain
reserved names.

Request and response `default` values are annotations: they do not fill omitted
fields, change requiredness, replace explicit `undefined` or rescue invalid
values. Their values must be JSON; in 3.0, a default must also match the
explicit `type` at the same schema location (including null when
`nullable: true`). Defaults are not checked against bounds, formats, enum, or
required properties. In 3.1, they are not checked against type either. These
rules also apply through references, maps, arrays and union branches.

### Schema limits

Component schemas, HTTP schemas, and policy field declarations share a
per-document normalization budget of 1,000,000 work units. Each source schema
visit consumes one unit, as does each literal value (`enum` or `const`),
property name, required name, composition branch-list entry, nullable type-array
entry and discriminator mapping entry. A branch counts both its list entry and
its schema visits. Shared inline values count at every occurrence. Annotations
such as `default` and `example` are validated separately. Unused declarations
count before output selection. Reduce or split a contract that exceeds the
budget; component references reduce repeated inline work. This budget applies to
JSON, YAML, and programmatic inputs. The YAML parser's whole-document expansion
limit remains separate.

`allOf` composition also bounds merged-field and scalar-assertion preprocessing
to 1,000,000 work units per schema table, and resolves at most 256 nested
schemas at a time, including members of recursive component groups. These limits
also apply to shared references. Excessive composition fails before generation.

Schema validation also permits at most 1,000,000 enum-candidate visits per
validation pass. Constrained references reserve their candidate scan before
filtering, including in unused declarations. Reduce repeated constrained
references to wide enums, or split the contract, when this limit is exceeded.

Finite schemas support at most 128 structural levels, including referenced
schemas. Aliases add no levels. Within a recursive group, a reference back to
that group starts another iteration; each member's own structure and references
outside the group still count. The group's size does not count as nesting.
[Runtime limits](#recursive-schemas) bound the depth of actual input values.

Inline schemas are limited to 32 levels; use component references for deeper
structures. Nullable wrappers count: a nullable array or object uses one level
for nullability and one for the container before its children. Generated
expressions have a separate 128-level complexity limit. Excess nesting fails
before formatting or writing. Defaults add no schema or expression levels, but
their values remain subject to YAML document limits.

### Numeric types and formats

Numbers use finite JavaScript numeric values. Plain integer validation checks
integrality without adding an implicit safe-integer range; declare required
bounds or select the `int64` profile described below. `multipleOf` uses their
decimal spelling, including scientific notation, without an epsilon tolerance.

`type: "integer", format: "int32"` restricts values to −2,147,483,648 through
2,147,483,647 inclusive. Explicit bounds and reference constraints intersect
that range and cannot widen it. Types remain `number`, with runtime integer and
range checks and no coercion. Nullable integer schemas support the same format.
Known formats require a supported matching type; format siblings on references
are unsupported.

`type: "integer", format: "int64"` uses JavaScript's safe-integer range,
−9,007,199,254,740,991 through 9,007,199,254,740,991 inclusive. It retains the
`number` type and intersects explicit or referenced bounds just like `int32`.
Unsafe integers, fractions, strings, and bigints fail validation without
coercion. For the full signed 64-bit range, use
`type: "string", format: "int64"`. Validation observes JavaScript numbers, so it
cannot recover or detect every rounding that occurred while parsing a JSON token
or computing a value.

`type: "string", format: "int64"` validates the complete signed 64-bit range,
−9,223,372,036,854,775,808 through 9,223,372,036,854,775,807. It accepts ASCII
decimal digits with an optional minus sign, including leading zeroes, and
preserves the exact string. Whitespace, plus signs, exponents, fractions and
hexadecimal spellings are rejected. Validation never converts the string to a JS
number.

`type: "number", format: "double"` uses the existing finite JavaScript number
validation. `format: "float"` additionally rejects values whose conversion to
32-bit floating point would overflow. This admits shortest serialized decimal
spellings such as `3.4028235e38`, which round to the finite float32 maximum even
though they exceed its exact mathematical value. Neither profile changes the
input number or guarantees that it is exactly representable without rounding;
float32 underflow/rounding is not coercion performed by POM. Explicit numeric
bounds and `multipleOf` still apply to the original value.

### JSON values and literals

An empty schema `{}`, or a schema containing only supported annotations, accepts
any JSON value. Generated types use the recursive `JsonValue` type. Validation
returns detached JSON copies and rejects undefined, non-finite numbers, bigints,
functions, sparse arrays, class instances, and cycles. An explicit
`type: "object"` still requires an object; untyped assertions such as
`{ "minimum": 1 }` remain unsupported. References to unconstrained JSON cannot
add constraints that POM cannot represent.

`enum` and `const` need no `type`: the listed values are the only accepted
values, so they also fix the type. `{ "enum": ["ready", "done"] }` is a string
enum and `{ "enum": [1, 2] }` an integer enum, exactly as with the type
declared. Values of several JSON types generate one literal alternative per
type, such as `'a' | 1 | null`. Members must be strings, finite numbers,
booleans, or null. Other assertions beside an untyped `enum` or `const`,
including `format` and length or numeric bounds, need a declared `type`. In 3.0,
`nullable: true` still requires a `type`, and `const` remains a 3.1 keyword.

### String validation and formats

An exceeded string `maxLength` stops validation before pattern or format
predicates run and reports only the length failure. Lengths count Unicode code
points, including surrogate pairs as one code point.

Patterns use ECMAScript 2024 syntax in Unicode (`u`) mode with Unicode 16.0
property names, matching the supported Node minimums. Newer syntax, including
inline flag modifiers and duplicate named capture groups, and newer Unicode
property names fail compilation even when the compiler's host accepts them.
Patterns support at most 128 nested capturing groups, noncapturing groups, and
lookaround assertions, counted together. Escaped parentheses, class characters,
and sequential groups do not add nesting. Excess nesting fails before parsing
can exhaust the stack. Generated code uses its runtime's regular expression
engine; Unicode character classification can change between runtime Unicode
versions. Browser and native engines must support the pattern features used by
their contracts. If an engine throws `RangeError` while matching a schema
pattern or registered format, that rule fails through the normal validation
issue path. Other errors propagate. This does not bound regex execution time;
use `maxLength` to reject oversized input before matching, or `format: "byte"`
for standard base64.

Inline scalar `enum` members and `const` values must satisfy applicable bounds,
formats, `multipleOf`, and patterns without Unicode property escapes during
compilation. Matching against `\p{…}` and `\P{…}` patterns is deferred to
generated runtime validation because Unicode classification varies by engine.
These patterns also do not remove candidates from compiler
reference-intersection proofs. Null-only literals remove the non-null branch
after sibling syntax checks. Other numeric branches reject empty finite-number
and integer intervals. Reference constraints may narrow an existing enum; empty
literal intersections and contradictory bounds also fail across reference
chains. These checks diagnose supported contradictions without attempting
general schema satisfiability analysis. Constrained references keep the
referenced component's declared TypeScript identity, so its literal type can be
wider than the values that validation accepts. An `allOf` scalar composition can
expose its narrowed literal type. After a composed scalar's base type and bounds
pass, independent assertion failures are collected within the [issue
budget](#schema-validation).

`type: "string", format: "password"` is a presentation hint, as defined in
[OpenAPI's format registry](https://spec.openapis.org/registry/format/password).
POM applies the string's constraints without masking, transformation, or
additional password validation.

`type: "string", format: "byte"` validates standard [RFC 4648
base64](https://www.rfc-editor.org/rfc/rfc4648.html#section-4). Empty strings
are valid. Padding is required when needed; whitespace, misplaced or excess
padding, and the base64url alphabet are rejected. Validation preserves the
encoded string without decoding bytes, and does not require unused padding bits
to be zero. String lengths and patterns still constrain the encoded text.

`date-time` requires a calendar date, seconds, and a `Z` or `±HH:MM` timezone.
Fractional seconds and lowercase `t`/`z` are accepted without changing the input
text. Timestamps with leap seconds are unsupported. `uuid` validates
case-insensitive hexadecimal `8-4-4-4-12` syntax without adding version or
variant restrictions; braces and URN prefixes are rejected.

`ipv4` accepts four decimal octets from 0 through 255, each with one to three
digits; leading zeroes are allowed. `ipv6` accepts full or compressed
hexadecimal forms and embedded IPv4 without leading zeroes. Brackets, zone
identifiers, and network prefixes are unsupported. Both formats preserve the
input text. URL parsers can interpret leading-zero IPv4 octets as octal:
`010.000.000.001` becomes `8.0.0.1`. Applications using these values as network
destinations must apply their destination policy to the parsed address; format
validation checks syntax only.

`email` checks ASCII [RFC 5321 Mailbox
syntax](https://www.rfc-editor.org/rfc/rfc5321.html#section-4.1.2):
dot-separated atoms or a quoted local part, followed by a domain or IPv4/IPv6
address literal. Quoted spaces and escapes, single-label domains, and ASCII
Punycode spelling are accepted. Display names, comments, raw non-ASCII text,
controls and surrounding whitespace are rejected. IPv6 literals follow the SMTP
grammar, including its requirement that `::` replace at least two groups. This
is a syntax check: DNS, delivery and SMTP transport length limits are not
checked. Declare field lengths explicitly when required.

`uri` checks ASCII [RFC 3986 generic
syntax](https://www.rfc-editor.org/rfc/rfc3986.html#appendix-A), requiring a
scheme. It accepts non-HTTP schemes, IPv6 and IPvFuture hosts, and well-formed
percent escapes. Relative references, raw non-ASCII text, malformed escapes,
backslashes, controls and IPv6 zone identifiers are rejected. Empty hierarchical
components and ports are permitted; numeric ports have no implicit range limit.
Scheme-specific rules and host existence are application concerns. Use `pattern`
to restrict schemes or impose a narrower application profile.

Both formats preserve the original string, including case and percent spelling;
neither resolves, decodes or normalizes values. `idn-email`, `iri`, and
`uri-reference` have no built-in validator and require an explicit definition to
be used. Documentation URLs and contact emails remain shape-checked annotations,
independent of schema format assertions.

Format mismatches fail request validation and produce protocol failures for
responses. For example, a bare hostname does not satisfy `format: "uri"`; use a
string without that format for hostname fields.

### Arrays

Arrays observe their length once and check all effective bounds, including
reference constraints, before reading items. Parsing visits exactly that many
positions and returns a fresh dense array. Missing slots cannot be filled by
inherited numeric properties. Arbitrary JSON arrays follow the same rule.

`uniqueItems: true` rejects an array with equal items, reporting the later
position. Items compare as JSON values: strings exactly, numbers by value (`1`
equals `1.0` and `0` equals `-0`), arrays by position, and objects by members
regardless of order. Requests compare the validated items POM sends, so
undefined optional fields are ignored. Responses compare the received items, as
JSON Schema specifies: items that differ only in fields POM strips stay
distinct, so the returned array can hold items that look equal. Only when parsed
items coincide does POM read those received items in full, including stripped
fields. Shared acyclic children compare by value. Cyclic or non-JSON values that
must be compared produce a validation error. Each item comparison allows at most
100,000 visited values, including expansion of shared children. Excessive
comparison work or a detected input cycle aborts the complete value; a later
union alternative cannot select a different projection. An actual duplicate is a
constraint mismatch and allows another alternative to be tried.
`uniqueItems: false` adds no rule. Constrained references and allOf siblings may
add `uniqueItems`; multipart file arrays cannot declare it.

### Object property counts

`minProperties` and `maxProperties` are nonnegative integer bounds for fixed
objects and maps. Fixed request objects count validated fields, excluding
`undefined`; inherited or non-enumerable structural fields count after parsing
copies them into the snapshot. Fixed response objects count original own
enumerable string keys, including extra fields and fields later omitted by
directional parsing, so a parsed response can have fewer keys than the declared
minimum. Maps check bounds against original own enumerable string keys before
parsing values; successful parsing retains every map entry. Reference
constraints intersect with the target's bounds. For multipart inputs, see the
[file array restriction](#multipart-requests).

### Property and parameter names

Path and query names/values must contain well-formed Unicode. Header values use
HTTP byte characters, permit internal horizontal tabs, and reject other ASCII
controls or leading/trailing SP/HTAB so transport serialization preserves them.
Header names must be ASCII HTTP tokens. Declarations reserve `__proto__`,
`prototype`, and `constructor` regardless of casing. Responses with content
require a single valid Content-Type matching a declared media type for that
status; quoted parameters are supported.

Built-in `Object.prototype` names, such as `toString`, `valueOf`, or
`hasOwnProperty`, are unsupported as fixed schema property and parameter names.
These names are legal in OpenAPI; POM rejects them explicitly to preserve
request type inference and runtime omission behavior. Dynamic maps preserve
their own JSON keys, including `__proto__` and `constructor`.

### Diagnostics

Unsupported declarations produce an error naming their location before files
change. For example, adding `format: 17` to the example's
`components.schemas.WidgetId` produces:

```text
POM: components.schemas.WidgetId.format: expected a string
```

### allOf composition

`allOf` requires a nonempty array of supported schemas. A single branch may wrap
any existing supported shape; a wrapper around one component reference retains
that reference's identity. Fixed-object compositions may combine inline schemas,
local references, and nested compositions. Sibling object `properties` and
`required` declarations participate in the same composition. Repeated references
to the same component without use-site constraints are idempotent, including
when an inherited property is redeclared. Constraints on that component or its
aliases remain active. This does not add general array or map intersection
support or compare separately written inline schemas for equality. Object
fragments may omit `type` only when the composition also includes an explicit
`type: "object"` assertion, directly or through a reference. Without that
assertion, object keywords alone also admit primitives under OpenAPI; POM
diagnoses that unsupported form instead of changing its meaning. Multiple scalar
branches must have the same kind, except that `number` and `integer` may
intersect. Other branches and sibling keywords need an explicit `type`, with one
exception: string, numeric, and array constraints beside a single referenced
branch restrict that reference, as 3.1 reference siblings do. For example,
`{ "allOf": [{ "$ref": "#/components/schemas/Codes" }], "maxItems": 2 }` limits
the referenced array, including in 3.0. Sibling or branch `enum` and `const`
restrict the composition without a type. A mixed-type enum narrows to the types
admitted by the other conjuncts; for example, a string conjunct with
`enum: ["active", null]` permits only `"active"`. If no literal can remain,
compilation reports the contradiction. Declare a type beside `format`, and in
branches such as `{ "maxLength": 3 }`.

For example, a reusable base may declare shared fields and an operation-specific
schema may add fields:

```json
{
  "allOf": [
    { "$ref": "#/components/schemas/WidgetBase" },
    {
      "type": "object",
      "required": ["label"],
      "properties": { "label": { "type": "string", "minLength": 1 } }
    }
  ]
}
```

Every branch applies to the same value. Required fields accumulate, and a field
declared by several branches must satisfy every declaration. Overlapping fixed
objects compose recursively. Overlapping scalar constraints keep every rule,
including independent patterns, formats, and `multipleOf` constraints; `number`
with `integer` still requires an integer. Composition never uses the last branch
as an override. Comparable bounds combine to their strongest restriction. Each
distinct scalar assertion is checked once, including when several aliases or
composition paths share the same ancestor; repeated assertions do not multiply
diagnostics. Object `minProperties` and `maxProperties` bounds intersect over
the full composed object, using the [request/response counting
rules](#object-property-counts).

Composition happens before request/response projection, so [directional field
rules](#directional-object-fields) also apply. Requests reject unknown fields
against the combined field set, while responses strip additive fields. Parsed
values remain detached, including nested composed objects.

When the combined source declares no fields or required names and no closed
branch, it remains an open object of JSON values. For example,
`allOf: [{ type: "object" }, { minProperties: 1 }]` preserves arbitrary valid
JSON members while requiring at least one member. Explicitly closed empty
objects remain empty. This source decision precedes directional projection: a
fixed object whose fields are later excluded by `readOnly` or `writeOnly` keeps
its fixed shape and does not become an open map.

`additionalProperties: false` belongs to the schema object where it is declared.
POM accepts a closed branch only when that branch locally declares every field
in the combined object. Extending a closed branch with another field receives an
actionable unsupported diagnostic, even if the added field is optional. Omit
`additionalProperties: false` from a base intended for extension; closing one
branch does not close the union of all branches' fields. Responses still strip
unrelated fields from supported closed compositions.

Explicit dynamic `additionalProperties: true` or a schema, including `{}`,
cannot be combined with fixed fields. The same restriction applies through local
aliases and nested compositions. A bare `{ "type": "object" }` remains neutral
beside fixed fields. Pure `additionalProperties: true` maps may combine with
property-count bounds and retain all their valid members. Schema-valued maps,
including `additionalProperties: {}`, work alone or in a single-branch wrapper;
intersecting them with additional assertions is unsupported.

`allOf` distributes over `anyOf` and `oneOf` branches: composing `A` with
`oneOf: [B, C]` produces `oneOf: [allOf(A, B), allOf(A, C)]`. Each alternative
keeps its position, so the union's matching rule and any discriminator tags
still apply to the composed objects; shared fields therefore reach every mapped
branch. `readOnly` and `writeOnly` from other conjuncts apply to the whole
union; annotations on the alternatives themselves remain unsupported. An
alternative that cannot combine with the other branches, such as `integer` with
a `string` conjunct, fails compilation rather than disappearing. Constraints
beside a referenced union are unsupported.

An intersection supports at most one discriminated `oneOf` factor, including
through aliases and nested compositions. Combining several receives an explicit
unsupported diagnostic. A factor whose branches require distinct literal tags
can instead use `anyOf` without its discriminator: the tags make its branches
disjoint, so `anyOf` and `oneOf` accept the same values. Keep those tags
required and present after request/response projection in every direction that
uses the schema.

POM does not support intersections involving typed dynamic maps, multiple array
schemas, or binary schemas. A nullable type beside or within a multi-branch
composition is a union with null, and every branch would also need to accept
null. A finite scalar literal assertion may narrow such a nullable declaration.
For other conjuncts, wrap the composition in an outer `anyOf` with a null-only
branch instead. An empty schema `{}` adds no constraints. Unsupported
compositions fail before selection or writes, including in unused components.
Recursion through a composed object's properties is supported; recursive object
merging at the same value is unsupported.

### Recursive schemas

Local component references may form self-referential or mutually recursive
schemas when each cycle descends through an object property, array item, or map
value. For example, a tree may contain an optional parent or an array of
children referring to the same tree component. Nullable wrappers, tagged unions,
aliases and directional properties follow their usual rules. Recursive maps keep
their declared value types.

A cycle made only of aliases, union alternatives, or `allOf` branches never
moves to a child value. POM rejects these nonproductive cycles before output
selection, including in unused components. External references remain
unsupported.

Recursive validation accepts finite data and returns detached values. Reusing
one input child in separate positions is allowed; each position receives its own
parsed copy. A JavaScript object or array referring to an active ancestor fails
validation instead of producing a cyclic output. The same checks apply to
standalone validators, request builders, and response parsing.

Each recursive traversal permits at most 128 descent levels, 512 active parser
entries, and, by default, 100,000 visits across child values and attempted union
branches. Set `recursiveWorkLimit` in `pom.json` or `CompileOptions` to a
positive safe integer to change the visit cap:

```json
{
  "version": 2,
  "openapi": "./openapi.json",
  "output": "./generated",
  "clients": ["consumer"],
  "recursiveWorkLimit": 1000000
}
```

Regenerate the complete output set after changing this setting. It applies to
recursive validation in every client, builder, response parser and standalone
validator in that set. Nonrecursive validators, compiler budgets and other
runtime limits are unchanged, including the separate `uniqueItems` comparison
budget. Higher caps permit more work and can increase peak memory, especially
when shared children expand into separate output copies. Visits do not measure
input bytes or memory use.

Nullable and union parsers count as entries even when they validate the same
value without descending. Each object property, array item or map value adds one
descent level; an object inside an array property is two levels below its
parent. One work allowance covers the whole value, including outer containers,
sibling recursive children and expansion of shared acyclic inputs.

Exceeding a limit or finding an input cycle aborts the recursive value. A later
union branch cannot recover by choosing a different projection. Type or
constraint mismatches can still try another branch. An abort produces a
validation error, or a protocol failure for a response. It reports the cause
first at the recursive value's path and preserves earlier issues from other
fields or request parts within the [issue budget](#schema-validation).

The work allowance covers every item in a recursive batch even when the data
omits all optional recursive members. For example, 20,000 flat records with
seven supplied scalar fields already contain 140,000 child field values before
array items are counted, so they exceed the default allowance. The number of
records that fits depends on the schema and supplied values. Measure larger
workloads before choosing a higher `recursiveWorkLimit`, or use smaller batches
when the API permits them. If an operation always returns flat data, declaring a
nonrecursive schema avoids recursive traversal accounting.

Untagged unions cache branch choices and failures for objects and scalar values
during each call. Parsed values are reused only for the same union at the same
input position. Shared children at different positions produce separate copies
and undergo depth and cycle checks at each position. Caches are cleared after
each call, including when a getter throws, and are separate for different
request/response projections. The [input stability
requirements](#schema-validation) apply throughout each synchronous validation
call.

Untagged object branches check required keys and required scalar fields before
recursive children to reject impossible matches early. Tagged unions select
their branch directly. These caches are created only for untagged unions and can
increase peak memory for large documents.

### Reusable components

The following declarations accept inline objects or local component references:

| Declaration                      | Reference target                        |
| -------------------------------- | --------------------------------------- |
| Path-item or operation parameter | `#/components/parameters/WidgetId`      |
| Operation `requestBody`          | `#/components/requestBodies/WidgetBody` |
| Operation response               | `#/components/responses/WidgetResult`   |
| Response header                  | `#/components/headers/TraceId`          |

`{ "$ref": "<target>" }` selects the target in its corresponding `components`
map. Component entries may alias another entry of the same kind.

Component names match `[A-Za-z0-9._-]+`; `__proto__`, `prototype`, and
`constructor` are reserved. In 3.1, references may add string `summary` and
`description` annotations. Semantic siblings such as `required`, `schema`,
`content`, and `headers` are rejected. Every declaration in these component maps
is validated, including unused entries. Missing targets, cycles, and external
references fail with diagnostics.

Request body components keep the declared `required` flag, media type, and
schema. [Optional JSON and text bodies](#build-and-validate-a-request) and
[multipart bodies](#multipart-requests) follow the same rules as inline bodies.
GET and HEAD request bodies remain unsupported, including through references.

Response components require a string `description` and may declare JSON or text
content and response headers using the same rules as inline responses. Each
operation binds the resolved body and headers to its declared status, range, or
`default`. HEAD responses and the exact statuses 204, 205, and 304 must be
bodyless, including through references. [Response evidence](#response-evidence)
describes how ranges and `default` treat those statuses.

Header components describe response headers; each response header map supplies
the wire name. Every use rejects invalid names, case-insensitive duplicates, and
transport-owned response headers.

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
`Object.prototype`. Rejection checks presence without reading the excluded
value. Request types declare excluded read-only fields as optional `never`
properties so assignments and spreads cannot supply them. Enable TypeScript's
`exactOptionalPropertyTypes` to reject explicit `undefined` in those types too.
The response requires `id` and `label`; it strips `secret` without validating or
reading its value, except when a response `uniqueItems` check compares received
items whose parsed values coincide. Generated types and standalone validators
use the same projection, including nested objects, arrays and typed maps. An
object with all properties excluded stays a fixed empty object. Returned
response data remains mutable; these flags describe wire direction rather than
TypeScript `readonly`.

Both flags must be booleans. A true flag inherited through a local reference or
alias remains true, including when a 3.1 reference sibling says false. POM
rejects both flags being true at the same schema, including through aliases.
Entire source declarations, including excluded fields, still receive syntax,
reference and constraint checks. Usage checks then inspect visible fields: an
excluded write-only field may have a binary schema without affecting response
validation. Visible binary values retain their multipart-only restriction.
Defaults remain documentation in both directions.

Projection operates at fixed object property boundaries. If an active flag would
exclude an entire body, parameter/header, standalone root, array item or map
value, generation fails; POM does not silently omit those values. Inactive flags
are permitted, such as a read-only response root. True flags on `anyOf` or
`oneOf` branch roots are unsupported because their applicability can depend on
which branch succeeds; place a shared flag on the containing property or union
instead. A discriminator field must remain present and required in the direction
using its `oneOf`. Servers must still enforce authorization.

## Build and validate a request

For the example contract:

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
application serializes that body, adds transport headers, validates the merged
headers with `request.validateHeaders(headers)`, sends the request, and supplies
response status, headers, and raw body text to `parseResponse`.

JSON and text request bodies are optional when `requestBody.required` is omitted
or `false`. The generated `body` input is optional; the whole options argument
is optional only when no other generated input is required. Omitting `body` or
supplying `undefined` prepares `bodyKind: 'none'` without a `body` property.
Explicit `null` is JSON data and is accepted only when the schema allows it;
valid `false`, `0`, empty strings and empty objects also remain JSON data.
Optional bodies retain their schemas, constraints and directional validation
when present. Defaults remain annotations and never create an omitted body.

An optional JSON operation returns `bodyKind: 'none' | 'json'`; optional text
returns `'none' | 'text'`. Narrow by `bodyKind` before reading `body` or
`contentType`. Present JSON/text requests expose the selected `contentType`.
Applications JSON-encode the `json` branch, send the `text` branch as its raw
string, and set Content-Type from `request.contentType`. Omitted bodies expose
neither field. Required JSON/text bodies and multipart bodies retain their
required inputs. Optional multipart and all GET/HEAD request bodies remain
unsupported. Response validation is independent of whether a request body was
sent.

Path placeholders use identifier names (`[A-Za-z_][A-Za-z0-9_]*`) and occupy an
entire segment. Path values cannot be empty, `.` or `..`. Paths that differ only
in placeholder names are rejected, even when their HTTP methods or surfaces
differ. Concrete paths may coexist with templated paths.

Path-item and operation parameter lists accept [reusable component
references](#reusable-components) as well as inline declarations.

Path-item `parameters` apply to every operation under that path. An operation
replaces a declaration with the same case-sensitive `name` and `in`; other
inherited parameters remain, including when the operation declares an empty
`parameters` array. Both declaration lists are validated before merging, so
overrides cannot hide unsupported schemas or serialization. Duplicates within
either list fail. Header names must also remain unique ignoring case in the
effective operation; changing only a header's casing does not count as an
override. Path placeholders must match the effective path parameters exactly.
References resolve before inheritance and duplicate checks, using the target's
`name` and `in`. Errors identify the invalid component declaration or list
entry.

Configuration may name declared request headers in `transportHeaders`, for
example `"transportHeaders": ["X-Origin"]`. These headers are absent from
builder options and supplied by the application. The merged-header validator
enforces all declared header schemas and requiredness, accepts other valid HTTP
headers, rejects duplicate names ignoring case, and returns normalized lowercase
names.

Declared headers use a Fetch-compatible vocabulary across clients. Endpoint
contracts reject transport-owned request headers such as `Host`, `Origin`, and
`Proxy-*`/`Sec-*` names. Response declarations reject `Set-Cookie` and
`Set-Cookie2`, which browser Fetch hides.

Header parameters named `Accept`, `Content-Type`, or `Authorization`, in any
letter case, are ignored, as OpenAPI requires. Their declarations are still
validated, but they are absent from builder inputs, generated header checks, and
`transportHeaders`; the transport sends those headers. An ignored
`Authorization` parameter must not be the only description of a credential. The
operation's effective security has to send the Authorization header: HTTP basic
or bearer, OAuth2, or a header API key named `Authorization`, in at least one
alternative. Otherwise POM reports the parameter; declare the credential as a
security scheme.

Form query arrays use repeated keys (`tag=one&tag=two`) when `explode` is
omitted or `true`. With `explode: false` and `style: "form"` (or an omitted
`style`), an array uses comma-separated values under one key. Items are
percent-encoded individually before joining: `["a,b", "c d"]` becomes
`tag=a%2Cb,c%20d`. Server decoders must split raw comma separators before
percent-decoding each item. Both modes omit optional empty arrays and reject
required empty arrays because an empty collection cannot represent its required
presence. Other array serialization styles remain unsupported.

Optional nullable primitive query parameters omit `null` and `undefined`, while
preserving `0`, `false`, empty strings allowed by the schema, and literal
`"null"` text. Non-null values still satisfy the declared constraints and
formats. Required nullable query parameters, nullable query arrays, and nullable
array items are unsupported. Optional nullable string headers also omit `null`
and `undefined`; required nullable headers are unsupported.

### Multipart requests

Multipart clients require an explicit target, for example
`"targets": { "web": "browser", "mobile": "native" }` for those selected
clients. A required `multipart/form-data` body is a fixed object of strings,
files, and file arrays. Files use `type: "string"` with `format: "binary"` in
both dialects. In 3.1, `contentMediaType: "application/octet-stream"` is also
supported. Browser inputs require `File`; native inputs use
`{ uri: string, name?: string, mediaType?: string }`, with nonempty strings.
Browser files must be instances of the environment's current `File` constructor,
with valid File metadata and Blob backing. Their identity is preserved. Native
browser, jsdom, and Happy DOM Files are supported when the same environment's
`File` and `Blob` constructors are installed together; checks follow the current
constructors when the environment changes. Direct foreign-realm Files are
unsupported. Browser transfers such as `postMessage` remain supported when they
produce a receiving-realm File. Proxy support follows the platform's File
implementation.

Every client requires its platform's `URLSearchParams` global and TypeScript
declaration. Browser upload modules also require `File` and `Blob`. Native
programs can omit DOM libraries when their platform types supply
`URLSearchParams` (the verification suite uses Node types). Compile only the
native client entry and its dependencies, excluding browser modules from a
mixed-target output.

Prepared uploads have `bodyKind: "multipart"`, the complete validated `body`,
and a `multipart` field inventory (`name`, `kind`, `multiple`, `required`).
Applications resolve native references and serialize present fields, repeating
parts for file arrays. Builders omit optional fields whose value is `undefined`.
Serializers skip absent or `undefined` values and optional empty arrays;
required file arrays cannot be empty.

Multipart objects with `minProperties` or `maxProperties` require each optional
file array to have an effective `minItems` of at least 1; local reference
constraints can supply that minimum.

The application owns file access, `FormData`, progress, and fresh retry bodies.
Let the transport set multipart Content-Type and its boundary. POM neither reads
files nor serializes uploads. Multipart names must be ASCII HTTP tokens; text
values must contain well-formed Unicode. Builders normalize isolated CR and LF
to CRLF in detached text values before schema validation, preserving existing
CRLF pairs and leaving caller inputs unchanged. Length, pattern, literal and
format constraints apply to the normalized value returned in the prepared body,
so FormData serialization preserves the validated text. Nested objects, nullable
files, custom part encodings, and binary values in JSON or standalone validators
are unsupported.

### Schema validation

Requests reject unknown fields in fixed objects. Responses strip additive fields
from fixed objects while rejecting missing required fields, changed types, and
unknown enum values. Declared dynamic maps validate and preserve their entries.
An object schema without `properties` entries, `required` names, or
`additionalProperties`, such as `{ "type": "object" }`, accepts and preserves
any JSON members, as in JSON Schema. Declare `additionalProperties: false` for
an object that must be empty. Fixed objects read fields from objects, class
instances and prototypes, and return fresh plain objects. Each visited field is
read once per parser attempt; that value is validated and copied to the result.
Required fields must be present.

All observed input values, including object and array identities, field
membership, prototypes, and discriminator values, must remain stable throughout
each synchronous validation call. Stable getters and class or prototype fields
are supported. Getters or proxies that change values or mutate other input data
during the call are outside the supported input contract. Field-read order is
unspecified. Unions can retry parsers or reuse earlier results, so getter call
counts across alternatives are also unspecified. Inputs may change between
separate validation calls.

`Object.prototype` never supplies a field or an unknown request key, so
prototype pollution through data, such as an unsafe merge, cannot fill a missing
value. Dynamic maps require plain records and read each enumerable value once as
it is validated.

Schema registries and standalone `schema` exports expose `parse(unknown)` and
`safeParse(unknown)`. `parse` returns the named output type or throws
`ValidationError`; `safeParse` returns `{ success: true, data }` or
`{ success: false, error }`. Errors expose `issues` with `path` and `message`.
Validation reports at most 100 detailed issues and one omission marker. Further
schema traversal stops when that budget is exhausted. Individual issue messages
are limited to 1,024 UTF-16 code units; thrown error messages are limited to
8,192. Paths retain their original keys, and unknown-key messages show a bounded
sample. Nested union errors limit branch context to keep the underlying mismatch
visible. Successful validation checks the whole value. These limits do not cap
response-body size or JSON decoding memory.

Generated `RequestTypes`, `ResponseTypes`, and standalone `Input`/`Output` are
plain contract types. The validator API is limited to `parse` and `safeParse`;
it does not implement schema-library methods or the Standard Schema interface.

### Response evidence

Pass `parseResponse` numeric `status`, raw text `body`, and a plain `headers`
record with string values. Incorrect argument types throw `TypeError` before
protocol validation. Response header values normalize leading and trailing
spaces and tabs before validation; request header values reject that boundary
whitespace. Results distinguish `kind` and the observed `status`:

- `success`: a declared response with a 2xx status and validated `data`.
- `error`: a declared response with any other status and validated `data`.
- `protocol`: an undeclared status or invalid headers, media type, or body, with
  `issues` and no `data`. The observed status and normalized headers remain
  available; `validatedHeaders` contains independently valid declared headers.

Schema failures include a validator message and a `path` relative to the body or
headers. Other protocol issues may omit `path`.

A body valid under `200` does not pass under `202` unless both declare it.
Bodyless responses require empty text and expose `data: undefined`.

Responses declare exact statuses 200–599, the ranges `2XX`, `3XX`, `4XX`, and
`5XX`, and `default`. An exact status takes precedence over its range, and a
range over `default`. Only the matching declaration validates a response: a
`200` body that fails its own schema does not fall through to `2XX` or
`default`. `default` matches the remaining statuses 200–599. Any other value,
including an interim 1xx status, is an undeclared status. Range keys use an
uppercase `X`; `1XX` and lowercase spellings receive diagnostics.

A range or `default` match is classified by the observed status, like an exact
status of the same class. With only `200` and `default` declared, a 201 response
that `default` validates is a `success` carrying the `default` body. Declare
`2XX` to keep `default` for errors. Every operation needs a response that can
succeed: a 2xx status, `2XX`, or `default`.

Generated result types describe each declaration's status coverage. A range or
`default` with content can include 204, 205 or 304 in its type, although a
response matching that declaration at those statuses is a protocol failure.
After excluding protocol failures, checking `result.status === 200` narrows to
an explicit `200` declaration; a status without its own declaration narrows to
the range or `default` that receives it.

A 204, 205, or 304 response has no content. Declaring content for one of these
exact statuses fails compilation. A range or `default` may declare content for
the other statuses it covers; when one of these three matches it, the result is
a protocol failure. Declare the status itself without content to accept it.

## Generated TypeScript

Generated sources use explicit relative `.ts` imports and erasable TypeScript
syntax. Supported Node versions, Bun, and TypeScript-aware bundlers can consume
them directly. For direct Node execution, place them in an ES module package
with `"type": "module"`. CommonJS packages need a separate ES module boundary or
a compilation/bundling step; Node does not convert these sources to CommonJS.
Use ES2022 runtime APIs and library declarations, plus declarations for the
target platform. The emit `target` may be ES2020 or newer for bigint syntax;
lowering it does not supply missing runtime APIs. The example uses ES2022 for
both. When emitting JavaScript with TypeScript 5.7 or newer, enable
`rewriteRelativeImportExtensions` to produce `.js` imports. For a bundler-only
`noEmit` typecheck, use `allowImportingTsExtensions`. Core and execution-only
generated modules have no package runtime dependencies; optional query modules
need Query Core. Deployed applications do not need the compiler. Generated
modules support `isolatedDeclarations`. Application exports inferred from them
still need the annotations required by that TypeScript option. Generated output
requires `strictNullChecks: true` so required and nullable values retain their
contract types. Enable it directly or through `strict: true`; the other strict
flags are optional. Generated `runtime.ts` reports
`Pomegranate output requires strictNullChecks` when checked with null checks
disabled. The guard applies when checking generated sources; emitted
declarations and execution without type checking cannot enforce the compiler
setting. Generated modules also support `noUnusedLocals` and
`noUnusedParameters`. Compiler settings do not change runtime validation.

Generated `schema-types.<digest>.ts` modules share component type identities
across standalone validators and clients, including identical request and
response shapes. Modules contain only types reachable by every output that uses
them; browser and native upload types remain distinct. Keep these type-only
modules with the complete generated output set, including when publishing
declarations.

Distinct request and response shapes use separate named types. TypeScript can
exceed its structural comparison limits when assigning between very deep
directional types, even when each type compiles and its validators support the
schema. The limit depends on the type shapes and TypeScript version; the schema
depth limit does not guarantee request/response assignability at that depth.

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
`result.changes` describes any drift. Both APIs validate the complete input
before selecting clients. The same [schema-normalization limits](#schema-limits)
apply to programmatic inputs.

`result.warnings` contains structured `{ code, path, message }` warnings. Pass
`onWarning(warning)` to `runProject` for synchronous warnings before generated
files are replaced. The CLI writes warnings to stderr without prompting. Codes
are `modified-output`, `preserved-stale-output`, `recovered-manifest`, and
`recovered-output`. Check mode reports the same ownership warnings without
changing files.

## Generated output

Generated modules import shared local runtime helpers, including
`endpoint-runtime.ts` for client operations and response parsing. Keep all
helpers with the generated output, including execution and query helpers when
selected.

Generation uses the package's pinned formatter and writes a complete set of
modules with `.pom-manifest.json`. Exclude these files from application
formatter rewrites and use `pom check` to detect changes. Generated source is
limited to 32 MiB before formatting; larger selections fail before writing.
Errors identify the schema or generated-code location that exceeds the limit.
YAML anchors can make a small input produce much larger output. Select fewer
clients or standalone roots when a selection exceeds the limit.

Generated bytes use LF line endings. Preserve them in Git, including on Windows;
for an output directory named `generated`, add `generated/** text eol=lf` to the
consumer's `.gitattributes`. Line-ending conversion causes drift on checkout.

The manifest records generated filenames and their SHA-256 hashes. Generation
warns before overwriting edited generated files and preserves unrelated files.
It deletes stale generated files only if their recorded hashes still match,
including files for clients no longer selected. Edited stale files are preserved
with a warning, and their original hashes stay in the manifest so later runs
also preserve them. Keep the manifest with the generated files.

A target without recorded ownership or the exact POM banner blocks the whole
batch before files change. Filenames must be distinct ignoring ASCII case,
including on case-sensitive filesystems.

`check` is read-only, including when output is missing or invalid. CLI exit
codes are `0` for success, `1` for drift or an input/execution failure, and `2`
for invalid command usage. Bare `pom` and `pom --help` print usage and exit `0`.

Generation prepares all output before writing, replaces individual files
atomically, and writes the manifest last. The directory as a whole is not
replaced atomically. After interruption, rerun generation with current inputs.
POM checks existing files against the manifest or recovers them by their banner;
it does not restore an earlier output set.

If the manifest is missing or corrupt, POM recognizes existing targets only when
their content starts with the exact line
`// Generated by Pomegranate. Do not edit.` followed by LF. Recovery warns
before replacing such targets because their prior hashes are unavailable.
Banner-marked files outside the new output set are preserved with warnings, even
on later runs. Unsafe filenames, case collisions, input overlaps and symlinks
are errors. Preserved stale files count as drift in `check`; move or remove
them, or restore an edited stale file to its recorded bytes to allow normal
cleanup.

An interruption can leave a `.pom-lock` directory. Confirm that the writer has
stopped before removing a leftover lock, then retry generation. Generation
checks the lock before writing and cleaning up, and preserves a replacement
writer's lock. If a file changes after inspection, generation stops before
overwriting it. Keep files with uncertain ownership, or generate into a fresh
directory.
