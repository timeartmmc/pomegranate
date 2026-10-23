import {
  annotations,
  contractField,
  fail,
  keys,
  record,
  safeKey,
  text,
} from './diagnostics.js';
import type { Scalar, Schema } from './model.js';

function bound(
  value: Record<string, unknown>,
  key: string,
  location: string,
  integer: boolean,
): number | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  const number = value[key];
  if (
    typeof number !== 'number' ||
    !Number.isFinite(number) ||
    (integer && (!Number.isSafeInteger(number) || number < 0))
  ) {
    fail(
      `${location}.${key}`,
      integer
        ? 'expected a nonnegative safe integer'
        : 'expected a finite number',
    );
  }
  return number;
}

function bounds(
  value: Record<string, unknown>,
  minimum: string,
  maximum: string,
  location: string,
  integer: boolean,
): Record<string, number> {
  const min = bound(value, minimum, location, integer);
  const max = bound(value, maximum, location, integer);
  if (min !== undefined && max !== undefined && min > max)
    fail(location, `${minimum} exceeds ${maximum}`);
  return {
    ...(min === undefined ? {} : { [minimum]: min }),
    ...(max === undefined ? {} : { [maximum]: max }),
  };
}

function literals(
  value: Record<string, unknown>,
  kind: string,
  location: string,
): readonly Scalar[] | undefined {
  if (Object.hasOwn(value, 'const') && Object.hasOwn(value, 'enum'))
    fail(location, 'const and enum together are unsupported');
  const raw = Object.hasOwn(value, 'const') ? [value.const] : value.enum;
  if (!Object.hasOwn(value, 'const') && !Object.hasOwn(value, 'enum'))
    return undefined;
  if (!Array.isArray(raw) || raw.length === 0)
    fail(`${location}.enum`, 'expected a nonempty array');
  const result: Scalar[] = [];
  for (const item of raw) {
    const matches =
      kind === 'null'
        ? item === null
        : kind === 'integer'
          ? typeof item === 'number' && Number.isInteger(item)
          : typeof item === kind;
    if (!matches || (typeof item === 'number' && !Number.isFinite(item)))
      fail(location, `literal must match type ${kind}`);
    if (result.includes(item as Scalar)) fail(location, 'duplicate literal');
    result.push(item as Scalar);
  }
  return result;
}

export function normalizeSchema(input: unknown, location: string): Schema {
  const value = record(input, location);
  annotations(value, location);
  if (Object.hasOwn(value, '$ref')) {
    keys(value, ['$ref', 'title', 'description'], location);
    const ref = text(value.$ref, `${location}.$ref`);
    if (!/^#\/components\/schemas\/[A-Za-z_][A-Za-z0-9_]*$/.test(ref))
      fail(
        `${location}.$ref`,
        'only local component schema references with identifier names are supported',
      );
    return {
      kind: 'ref',
      name: safeKey(
        ref.slice('#/components/schemas/'.length),
        `${location}.$ref`,
      ),
    };
  }
  const kind = value.type;
  const common = ['type', 'title', 'description'];
  if (kind === 'object') {
    keys(
      value,
      [...common, 'properties', 'required', 'additionalProperties'],
      location,
    );
    if (
      Object.hasOwn(value, 'additionalProperties') &&
      value.additionalProperties !== false
    )
      fail(
        `${location}.additionalProperties`,
        'only false or omission is supported; dynamic maps are pending',
      );
    const properties = record(
      Object.hasOwn(value, 'properties') ? value.properties : {},
      `${location}.properties`,
    );
    const normalized = Object.fromEntries(
      Object.keys(properties)
        .sort()
        .map((name) => [
          contractField(name, `${location}.properties.${name}`),
          normalizeSchema(properties[name], `${location}.properties.${name}`),
        ]),
    );
    const required = Object.hasOwn(value, 'required') ? value.required : [];
    if (
      !Array.isArray(required) ||
      required.some((name) => typeof name !== 'string')
    )
      fail(`${location}.required`, 'expected an array of property names');
    if (new Set(required).size !== required.length)
      fail(`${location}.required`, 'duplicate required property');
    for (const name of required as string[])
      if (!Object.hasOwn(normalized, name))
        fail(
          `${location}.required`,
          `unknown property ${JSON.stringify(name)}`,
        );
    return {
      kind,
      properties: normalized,
      required: [...(required as string[])].sort(),
    };
  }
  if (kind === 'array') {
    keys(value, [...common, 'items', 'minItems', 'maxItems'], location);
    return {
      kind,
      items: normalizeSchema(value.items, `${location}.items`),
      ...bounds(value, 'minItems', 'maxItems', location, true),
    };
  }
  if (
    kind === 'string' ||
    kind === 'number' ||
    kind === 'integer' ||
    kind === 'boolean' ||
    kind === 'null'
  ) {
    const constraints =
      kind === 'string'
        ? ['minLength', 'maxLength']
        : kind === 'number' || kind === 'integer'
          ? ['minimum', 'maximum']
          : [];
    keys(value, [...common, 'const', 'enum', ...constraints], location);
    const allowed = literals(value, kind, location);
    const limits =
      constraints.length === 0
        ? {}
        : bounds(
            value,
            constraints[0]!,
            constraints[1]!,
            location,
            kind === 'string',
          );
    if (allowed) {
      for (const item of allowed) {
        // oxlint-disable-next-line typescript/no-misused-spread -- JSON Schema counts code points, not grapheme clusters.
        const magnitude = typeof item === 'string' ? [...item].length : item;
        if (
          typeof magnitude === 'number' &&
          ((limits[constraints[0]!] !== undefined &&
            magnitude < limits[constraints[0]!]!) ||
            (limits[constraints[1]!] !== undefined &&
              magnitude > limits[constraints[1]!]!))
        )
          fail(location, 'literal violates declared bounds');
      }
    }
    return {
      kind,
      ...limits,
      ...(allowed ? { literals: allowed } : {}),
    };
  }
  fail(
    `${location}.type`,
    'supported types are object, array, string, number, integer, boolean and null; unions and implicit types are pending',
  );
}

export function schemaReferences(schema: Schema): readonly string[] {
  if (schema.kind === 'ref') return [schema.name];
  if (schema.kind === 'array') return schemaReferences(schema.items);
  if (schema.kind === 'object')
    return Object.values(schema.properties).flatMap(schemaReferences);
  return [];
}

export function orderSchemas(
  schemas: Readonly<Record<string, Schema>>,
): readonly string[] {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const pending = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (pending.has(name))
      fail(`components.schemas.${name}`, 'recursive schemas are unsupported');
    if (!Object.hasOwn(schemas, name))
      fail(`components.schemas.${name}`, 'unresolved reference');
    pending.add(name);
    for (const target of schemaReferences(schemas[name]!)) visit(target);
    pending.delete(name);
    visited.add(name);
    ordered.push(name);
  };
  for (const name of Object.keys(schemas).sort()) visit(name);
  return ordered;
}

export function resolveSchema(
  schema: Schema,
  schemas: Readonly<Record<string, Schema>>,
  location: string,
): Schema {
  if (schema.kind !== 'ref') return schema;
  const resolved = schemas[schema.name];
  if (!resolved) fail(location, `unresolved reference ${schema.name}`);
  return resolveSchema(resolved, schemas, location);
}
