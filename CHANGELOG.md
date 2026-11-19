# Release notes

## 0.7.0

### Breaking changes

`PreparedRequest` and `Executor` include a `binary` body kind. Exhaustive
transport switches must account for it.

The compiler reserves `uri-reference` for the RFC 3986 validator. If your
configuration registers that name, remove the registration to use standard
syntax or rename both the custom registration and its schema references.

`oneOf` checks directional source membership before request field policy or
response stripping. Closed branch objects now enforce their source closure
within `oneOf`, including nested schemas. An open `Basic`/`Full` overlap rejects
a full value in both directions; closing both branches permits the unique full
match. Ordinary response objects outside union source matching retain their
existing stripping behavior. Inside any `oneOf`, request property counts also
use the received object, so an explicit `undefined` field now counts there.

`PreparedRequest` and `Executor` add the `form` body kind. Transports that
exhaustively inspect body kinds must handle it or reject it explicitly, even
when no operation declares a form body.

### Features

Raw octet-stream requests validate size bounds in bytes and snapshot the supplied
`Uint8Array` view for transport. See [raw byte requests](REFERENCE.md#raw-byte-requests).

String schemas support `uri-reference` with absolute URIs and relative
references. Format diagnostics identify unknown names, matching
registrations, and required types. See [string formats](REFERENCE.md#string-validation-and-formats).

OpenAPI 3.0 flat parameter schemas keep their values and warn when
`readOnly` or `writeOnly` has no effect. Role-array diagnostics distinguish
invalid OpenAPI 3.0 exports from unsupported OpenAPI 3.1 role requirements.

Path and query parameters accept nonnullable scalar unions with their
existing validation and wire serialization rules.

Schema references and standalone roots accept schema-valued local JSON Pointers,
including escaped property names and fragments inside reusable HTTP components.
Referenced fragments survive exclusions and pruning independently of their
containers, support productive recursion, and keep their source diagnostics.
A fragment is an additional declaration; its container compiles exactly as it
would without the reference.

Audits distinguish dotted and overlapping source names using private structured
ownership, preserving readable diagnostic locations and the public error shape.

Untagged `oneOf` supports overlapping branches and validates exactly one match,
including literals, enums, objects and containers. Sibling types and constraints
use canonical composition. Proven overlap produces compile-time warnings with
an example and direction; ambiguous payloads still fail exact runtime matching.
The compile-time work bound counts the second parse of each nested match.

`allOf` composes compatible array items and map values with their container
bounds, uniqueness and required keys. Nullable intersections remove provably
disjoint type alternatives while preserving union cardinality; a nullable type
written in the composition warns only when the complete result rejects null. A member that
only restates types the other members imply adds nothing, whatever its position.
Mixed fixed objects/typed maps and contradictory child compositions retain
explicit limits.

`pom audit --config pom.json` and `audit(document, options)` report failing
operation IDs, shared blockers, and a suggested exclusion list without writing
files. Global blockers leave unassessed operations explicit. Audits use existing
contract validation and configuration; generation and drift checks stay separate.

Inactive type-specific schema keywords and OpenAPI 3.0 `nullable: true` without
a same-object type compile with grouped warnings; each distinct displayed
location counts once. Their syntax is still checked
and applicable validation remains unchanged. `compile` accepts `onWarning`;
project results and CLI checks also report these warnings.

Inactive constraint siblings of references now follow the same warning rule
when the target's JSON type is known through aliases, including constraints
folded through a single-reference `allOf`. Applicable bounds still validate;
union and unconstrained targets keep their explicit limitations.

Nullable object schemas with null-only `enum`, or 3.1 `const`, normalize to
`null` when no structural assertions are present. Other object enum forms
remain unsupported.

Empty `components.callbacks` maps are accepted without generated behavior;
callback definitions remain unsupported.

Flat form-urlencoded bodies validate typed fields and prepare an encoded string;
send it directly with the prepared Content-Type. Optional multipart bodies now
prepare no body when omitted and retain complete browser/native validation when
present. Multipart forms also validate number, integer, and boolean parts for
applications to serialize as text. See [multipart requests](REFERENCE.md#multipart-requests).
Headers support primitive and primitive array schemas while retaining string
HTTP evidence. See [wire serialization](REFERENCE.md#header-serialization).

Schema `xml` annotations are accepted as metadata in OpenAPI 3.0 and 3.1.
Their fields are checked without changing JSON property names or validation;
XML payloads remain unsupported.

Markdown, diff/patch, and calendar media types accept string bodies in requests
and responses, including response media ranges. String constraints remain
validated; text syntax is passed through unchanged.

Path placeholders accept hyphenated names such as `{set-id}`, including embedded
placeholders. Exact parameter matching and value-encoding rules still apply.

`pruneUnusedComponents: true` removes unreachable components before validation,
independently or alongside operation exclusions. Retained operations, global
security, and standalone roots keep their dependencies and validation. The
default remains strict; manifests record pruned component references.

Empty and metadata-only Path Items are accepted without generating operations.
Path metadata and unsupported HTTP methods remain checked.

`excludeOperations` removes exact operation IDs before contract interpretation.
Unknown, duplicate, or ambiguous IDs fail. Exclusive local component dependencies
are removed while retained and standalone dependencies stay validated. Project
manifests record exclusions, and drift checks remain read-only.

`oneOf` and `anyOf` support shared object fields and required lists beside the
alternatives, using the existing `allOf` rules. Branch constraints, directional
fields, property counts, closure, and union matching remain enforced.

Fixed object schemas accept `additionalProperties: true` or `{}`, including
through `allOf`. Declared fields remain validated; responses strip unknown
fields and requests reject them. Typed extra-value schemas beside fixed fields
remain unsupported.

Maps may list `required` keys. An object that declares `additionalProperties`
and no `properties` keeps every entry and checks that each required key is
present, directly or through `allOf` compositions of arbitrary-JSON maps.
Generated types name those keys beside the index signature.

OpenAPI interoperability now includes object schemas that omit `type` beside
`properties`, embedded path placeholders such as `/{id}.json`, DELETE/OPTIONS
bodies in both dialects, single-branch unions, and implicit discriminator
mappings. `pom.json` can register numeric formats with declarative constraints.
Media declarations accept charset parameters, which must be UTF-8 on request
bodies; `text/json` uses JSON decoding, and HTML/CSV/YAML media use string
validation. Response links and reusable link
components are accepted as validated metadata. See the [contract
reference](REFERENCE.md) for the supported forms and limits.

### Fixes

Composed nullable schemas retain enum and const narrowing through references,
including when only null remains. Redundant object-type assertions beside
recursive references preserve the reference instead of triggering recursive
object expansion. Constraints, directional fields and source closure remain
active.

Programmatic documents and options treat every own string key as a declaration
regardless of enumerability. Hidden keywords are enforced, hidden unsupported
keywords and extensions receive their usual diagnostics, and hidden map entries
such as properties, components and paths are included. Inherited properties
remain ignored.

## 0.6.0

### Breaking changes

Generated TypeScript now requires `strictNullChecks: true`. Projects that
disable null checks must enable them before upgrading. The other strict flags
remain optional; `strict: false` with `strictNullChecks: true` is supported.

Regenerate the complete output set after upgrading. Generated `runtime.ts`
reports `Pomegranate output requires strictNullChecks` when type checked with
null checks disabled. See [generated
TypeScript](REFERENCE.md#generated-typescript) for supported compiler settings.

Input values and object structure must stay stable during synchronous
validation, including getter results, property membership, prototypes, and
discriminators. Field-read order is unspecified. Ordinary objects and class
instances remain supported. See [schema
validation](REFERENCE.md#schema-validation).

Generation now warns before overwriting edited owned targets, without prompting.
Edited or uncertain stale outputs are preserved with warnings. Interrupted runs
regenerate from current inputs; missing or corrupt manifests recover ownership
only from the exact POM banner. See [generated
output](REFERENCE.md#generated-output).

### Fixes

Multipart builders normalize isolated CR and LF to CRLF before validating text
fields. Returned values match FormData serialization; caller inputs are
unchanged. JSON and plain-text bodies retain their existing behavior.
