# Release notes

## 0.6.0

### Breaking changes

Generated TypeScript now requires `strictNullChecks: true`. Projects that disable
null checks must enable them before upgrading. The other strict flags remain
optional; `strict: false` with `strictNullChecks: true` is supported.

Regenerate the complete output set after upgrading. Generated `runtime.ts`
reports `Pomegranate output requires strictNullChecks` when type checked with
null checks disabled. See [generated TypeScript](REFERENCE.md#generated-typescript)
for the requirement and guard's scope.

Object validation no longer promises field-read order or a snapshot of required
membership before reading fields. Ordinary objects and class instances remain
supported; inputs must keep their shape and discriminator values stable during
parsing. See [schema validation](REFERENCE.md#schema-validation).

Generation now warns before overwriting edited owned targets, without prompting.
Edited or uncertain stale outputs are preserved with warnings. Interrupted runs
regenerate from current inputs; missing or corrupt manifests recover ownership
only from the exact POM banner. See [generated output](REFERENCE.md#generated-output).

### Fixes

Multipart builders normalize isolated CR and LF to CRLF before validating text
fields. Returned values match FormData serialization; caller inputs are unchanged.
JSON and plain-text bodies retain their existing behavior.
