import type { Schema, SchemaTable } from './model.js';
import { resolveSchema } from './schema-graph.js';
import { scalarIntersectionBase } from './intersections.js';

export type FlatParameterShape = Readonly<{
  kind: 'string' | 'number' | 'integer' | 'boolean';
  array: boolean;
  nullable: boolean;
}>;

// Wire bindings need one scalar spelling, even when aliases or scalar
// intersections supply its constraints. Valid productive cycles can pass through
// array items: reject a second array before following its items, and unwrap
// aliases/nullability iteratively rather than consuming the JS stack.
export function flatParameterShape(
  schema: Schema,
  schemas: SchemaTable,
): FlatParameterShape | undefined {
  let current = schema;
  let array = false;
  let nullable = false;
  for (;;) {
    const value = resolveSchema(current, schemas);
    if (value.kind === 'intersection') {
      current = scalarIntersectionBase(value, schemas);
      continue;
    }
    if (value.kind === 'union') {
      const nonNull = value.branches.filter(
        (branch) => resolveSchema(branch, schemas).kind !== 'null',
      );
      if (nonNull.length !== 1) return undefined;
      const hasNull = nonNull.length !== value.branches.length;
      if (array && hasNull) return undefined;
      nullable ||= hasNull;
      current = nonNull[0]!;
      continue;
    }
    if (value.kind === 'array') {
      if (array) return undefined;
      array = true;
      current = value.items;
      continue;
    }
    if (
      value.kind === 'string' ||
      value.kind === 'number' ||
      value.kind === 'integer' ||
      value.kind === 'boolean'
    )
      return { kind: value.kind, array, nullable };
    return undefined;
  }
}
