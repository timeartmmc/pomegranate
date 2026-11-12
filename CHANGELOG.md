# Release notes

## Unreleased

Optional multipart bodies now prepare no body when omitted and retain complete
browser/native validation when present. Headers support primitive and primitive
array schemas while retaining string HTTP evidence. Flat form-urlencoded bodies
validate typed fields and prepare an encoded string. `PreparedRequest` and
`Executor` add the `form` body kind; transports that exhaustively inspect body
kinds must handle it or reject it explicitly. Send form bodies directly with the
prepared Content-Type. See [wire serialization](REFERENCE.md#header-serialization).

### Features

Empty and metadata-only Path Items are accepted without generating operations.
Path metadata and unsupported HTTP methods remain checked.

`excludeOperations` removes exact operation IDs before contract interpretation.
Unknown, duplicate, or ambiguous IDs fail. Exclusive local component dependencies
are removed while retained and standalone dependencies stay validated. Project
manifests record exclusions, and drift checks remain read-only.

`oneOf` and `anyOf` support shared object fields and required lists beside the
alternatives, using the existing `allOf` rules. Branch constraints, directional
fields, property counts, closure, and union matching remain enforced.

`oneOf` and `anyOf` accept a redundant `type: "object"` when every alternative
already requires an object. References and supported compositions are checked
before removing the repeated assertion; other sibling types remain unsupported.

Fixed object schemas accept `additionalProperties: true` or `{}`, including
through `allOf`. Declared fields remain validated; responses strip unknown
fields and requests reject them. Typed extra-value schemas beside fixed fields
remain unsupported.

OpenAPI interoperability now includes object schemas that omit `type` beside
`properties`, embedded path placeholders such as `/{id}.json`, DELETE/OPTIONS
bodies in both dialects, single-branch unions, and implicit discriminator
mappings. `pom.json` can register numeric formats with declarative constraints.
Media declarations accept charset parameters; `text/json` uses JSON decoding,
and HTML/CSV/YAML media use string validation. Response links and reusable link
components are accepted as validated metadata. See the [contract
reference](REFERENCE.md) for the supported forms and limits.

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
