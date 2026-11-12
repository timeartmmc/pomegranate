# Release notes

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
