import { assertNever, fail } from './diagnostics.js';
import type {
  Direction,
  DirectionalSchemas,
  Schema,
  SchemaTable,
} from './model.js';

type Access = Readonly<{ readOnly: boolean; writeOnly: boolean }>;
const accessByTable = new WeakMap<SchemaTable, WeakMap<Schema, Access>>();

export function schemaAccess(schema: Schema, schemas: SchemaTable): Access {
  let cache = accessByTable.get(schemas);
  if (!cache) {
    cache = new WeakMap();
    accessByTable.set(schemas, cache);
  }
  const path: Schema[] = [];
  let target: Schema = schema;
  // Same-value reference cycles are rejected before projection. Productive
  // recursion stops at its container; access flags do not flow through children.
  // True annotations accumulate through aliases; a local false cannot undo one.
  // Composition already owns effective access on its canonical node. Retained
  // scalar conjuncts still carry source flags that distribution may have moved
  // to an enclosing union, so traversing them here would restore excluded flags.
  while (!cache.has(target)) {
    path.push(target);
    if (target.kind !== 'ref') break;
    const next = schemas.get(target.name);
    if (!next) fail(target.location, `unresolved reference ${target.name}`);
    target = next;
  }
  let access = cache.get(target) ?? { readOnly: false, writeOnly: false };
  for (let index = path.length - 1; index >= 0; index--) {
    const current = path[index]!;
    access = {
      readOnly: current.readOnly === true || access.readOnly,
      writeOnly: current.writeOnly === true || access.writeOnly,
    };
    cache.set(current, access);
  }
  return cache.get(schema)!;
}

export function projectSchemas(raw: SchemaTable): {
  readonly schemas: DirectionalSchemas;
  readonly schema: (schema: Schema, direction: Direction) => Schema;
} {
  const memo: Record<Direction, WeakMap<Schema, Schema>> = {
    request: new WeakMap(),
    response: new WeakMap(),
  };
  function project(schema: Schema, direction: Direction): Schema {
    const cache = memo[direction];
    const known = cache.get(schema);
    if (known) return known;
    const child = (value: Schema): Schema => project(value, direction);
    let projected: Schema;
    switch (schema.kind) {
      case 'object': {
        const forbidden: string[] = [];
        const properties = new Map<string, Schema>();
        for (const [name, value] of schema.properties) {
          const access = schemaAccess(value, raw);
          const excluded =
            direction === 'request' ? access.readOnly : access.writeOnly;
          if (excluded) {
            if (direction === 'request') forbidden.push(name);
            continue;
          }
          properties.set(name, child(value));
        }
        // Preserve a fixed object's kind even when every field is excluded. Raw
        // JSON renormalization would reinterpret an empty declaration as a map.
        projected = {
          ...schema,
          properties,
          required: schema.required.filter((name) => properties.has(name)),
          ...(forbidden.length ? { forbidden } : {}),
        };
        break;
      }
      case 'array':
        projected = { ...schema, items: child(schema.items) };
        break;
      case 'map':
        projected = {
          ...schema,
          values: schema.values === true ? true : child(schema.values),
        };
        break;
      case 'intersection':
      case 'union':
        projected = { ...schema, branches: schema.branches.map(child) };
        break;
      case 'json':
      case 'binary':
      case 'ref':
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null':
        projected = { ...schema };
        break;
      default:
        assertNever(schema);
    }
    // Distinct nodes keep reference/usage caches local to their directional
    // table; refs preserve names and resolve against that table at every use.
    cache.set(schema, projected);
    return projected;
  }
  const table = (direction: Direction): SchemaTable =>
    new Map(
      [...raw].map(([name, schema]) => [name, project(schema, direction)]),
    );
  return {
    schemas: { request: table('request'), response: table('response') },
    schema: project,
  };
}
