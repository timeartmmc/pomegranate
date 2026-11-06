import { fail, keys, record } from './diagnostics.js';
import { mapOpenApi } from './extensions.js';

const referenceContexts = new Set([
  'schema',
  'parameter',
  'response',
  'requestBody',
  'header',
  'example',
  'securityScheme',
]);

function defaultMatchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'string':
    case 'number':
    case 'boolean':
      return typeof value === type;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return (
        value !== null && typeof value === 'object' && !Array.isArray(value)
      );
    default:
      // Untyped defaults remain JSON annotations; invalid types fail in normalization.
      return true;
  }
}

function lowerSchema(
  value: Record<string, unknown>,
  location: string,
): Record<string, unknown> {
  if (Object.hasOwn(value, 'allOf'))
    fail(`${location}.allOf`, 'allOf is not supported in this version');
  for (const key of ['const', '$comment', 'examples', 'contentMediaType'])
    if (Object.hasOwn(value, key))
      fail(`${location}.${key}`, 'unsupported OpenAPI 3.0 schema keyword');
  if (Array.isArray(value.type) || value.type === 'null')
    fail(
      `${location}.type`,
      'OpenAPI 3.0 requires a single non-null type; use nullable: true with that type, or { type: "string", nullable: true, enum: [null] } for a null-only branch',
    );
  // Wright-00 §5.15 requires a nonempty required array; 3.1's dialect permits [].
  if (
    Object.hasOwn(value, 'required') &&
    Array.isArray(value.required) &&
    value.required.length === 0
  )
    fail(
      `${location}.required`,
      'OpenAPI 3.0 requires at least one required property name',
    );
  const result = { ...value };
  if (Object.hasOwn(value, 'nullable')) {
    if (typeof value.nullable !== 'boolean')
      fail(`${location}.nullable`, 'expected a boolean');
    // OAS 3.0.4 §4.7.24.2: nullable modifies only an explicitly declared type.
    // Enum and composition assertions still apply; the existing nullable-type
    // normalizer implements their intersection, including enums excluding null.
    if (value.nullable && typeof value.type !== 'string')
      fail(
        `${location}.nullable`,
        Object.hasOwn(value, 'anyOf') || Object.hasOwn(value, 'oneOf')
          ? 'nullable: true requires an explicit type in the same schema; for a composition, remove nullable and wrap the supported anyOf or discriminated oneOf in an outer anyOf with the null-only branch { type: "string", nullable: true, enum: [null] }'
          : 'nullable: true requires an explicit type in the same schema',
      );
    if (value.nullable && typeof value.type === 'string')
      result.type = [value.type, 'null'];
    delete result.nullable;
  }
  // OAS 3.0 requires defaults to match the same-object type, including nullable.
  // This source check never applies bounds, formats, or default insertion.
  if (
    Object.hasOwn(value, 'default') &&
    !(value.default === null && value.nullable === true) &&
    !defaultMatchesType(value.default, value.type)
  )
    fail(
      `${location}.default`,
      'OpenAPI 3.0 default must match its declared type',
    );
  for (const [exclusive, inclusive] of [
    ['exclusiveMinimum', 'minimum'],
    ['exclusiveMaximum', 'maximum'],
  ] as const) {
    if (!Object.hasOwn(value, exclusive)) continue;
    if (typeof value[exclusive] !== 'boolean')
      fail(`${location}.${exclusive}`, 'OpenAPI 3.0 requires a boolean');
    delete result[exclusive];
    // POM rejects active flags that cannot express a numeric constraint.
    // Exporter false flags normalize to omission, including without a bound.
    if (!value[exclusive]) continue;
    if (value.type !== 'number' && value.type !== 'integer')
      fail(
        `${location}.${exclusive}`,
        `POM requires type number or integer when ${exclusive} is true`,
      );
    if (!Object.hasOwn(value, inclusive))
      fail(
        `${location}.${exclusive}`,
        `POM requires ${inclusive} when ${exclusive} is true`,
      );
    // Keep malformed bounds at their source location instead of relabeling them.
    if (
      typeof value[inclusive] !== 'number' ||
      !Number.isFinite(value[inclusive])
    )
      fail(`${location}.${inclusive}`, 'expected a finite number');
    result[exclusive] = value[inclusive];
    delete result[inclusive];
  }
  return result;
}

export function normalizeOpenApi30(document: unknown): unknown {
  return mapOpenApi(document, (value, context, location) => {
    if (referenceContexts.has(context) && Object.hasOwn(value, '$ref')) {
      // In 3.0 this is a Reference Object, even at a schema location. Siblings
      // are ignored by the specification. Reject them rather than accidentally
      // enforcing 3.1 constraints or discarding an author's intended restriction.
      keys(value, ['$ref'], location);
      return value;
    }
    if (context === 'schema') return lowerSchema(value, location);
    if (context === 'info') {
      if (Object.hasOwn(value, 'summary'))
        fail(`${location}.summary`, 'unsupported OpenAPI 3.0 keyword');
      if (Object.hasOwn(value, 'license')) {
        const license = record(value.license, `${location}.license`);
        if (Object.hasOwn(license, 'identifier'))
          fail(
            `${location}.license.identifier`,
            'unsupported OpenAPI 3.0 keyword',
          );
      }
    }
    return value;
  });
}
