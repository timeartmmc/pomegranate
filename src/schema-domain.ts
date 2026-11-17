import { assertNever, fail } from './diagnostics.js';
import type { Schema, SchemaTable } from './model.js';
import type { WorkCounter } from './schema-constraints.js';

export const jsonTypes = [
  'null',
  'boolean',
  'string',
  'number',
  'array',
  'object',
] as const;
type JsonType = (typeof jsonTypes)[number];

// These are conservative domains, not a satisfiability test: number includes
// integer, and bounds, literals and patterns can further narrow each type.
// Composition may replace table entries while this analysis is alive, so source
// fragments must overapproximate their composed meaning too. In particular,
// untyped object keywords also admit every non-object JSON value.
export function createJsonTypeAnalysis(
  schemas: SchemaTable,
  work?: WorkCounter,
): (schema: Schema, location?: string) => readonly JsonType[] {
  const cache = new WeakMap<Schema, readonly JsonType[]>();
  const children = (schema: Schema): readonly Schema[] => {
    if (schema.kind === 'union' || schema.kind === 'intersection')
      return schema.branches;
    if (schema.kind !== 'ref') return [];
    const target = schemas.get(schema.name);
    if (!target) fail(schema.location, `unresolved reference ${schema.name}`);
    return [target];
  };
  return (schema, location = 'schema') => {
    const known = cache.get(schema);
    if (known) return known;
    // Same-value reference cycles are rejected before composition/validation.
    // Containers stop this traversal, so productive recursion and long aliases
    // need neither recursive JS calls nor a fixed-point approximation.
    const frame = (value: Schema) => {
      const values = children(value);
      work?.(values.length + 1, location);
      return { schema: value, children: values, next: 0 };
    };
    const pending = [frame(schema)];
    while (pending.length > 0) {
      const current = pending[pending.length - 1]!;
      const child = current.children[current.next++];
      if (child) {
        if (!cache.has(child)) pending.push(frame(child));
        continue;
      }
      const value = current.schema;
      let types: readonly JsonType[];
      switch (value.kind) {
        case 'ref':
          types = cache.get(current.children[0]!)!;
          break;
        case 'union':
          types = jsonTypes.filter((type) =>
            current.children.some((child) => cache.get(child)!.includes(type)),
          );
          break;
        case 'intersection':
          types = jsonTypes.filter((type) =>
            current.children.every((child) => cache.get(child)!.includes(type)),
          );
          break;
        case 'object':
          types = value.typeExplicit ? ['object'] : jsonTypes;
          break;
        case 'map':
          types = ['object'];
          break;
        case 'number':
        case 'integer':
          types = ['number'];
          break;
        case 'null':
        case 'boolean':
        case 'string':
        case 'array':
          types = [value.kind];
          break;
        case 'json':
        case 'binary':
          types = jsonTypes;
          break;
        default:
          return assertNever(value);
      }
      cache.set(value, types);
      pending.pop();
    }
    return cache.get(schema)!;
  };
}
