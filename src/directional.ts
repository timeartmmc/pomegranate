import { fail } from './diagnostics.js';
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
  let target = schema;
  // Source validation resolves references and rejects cycles before projection.
  // True annotations accumulate through aliases; a local false cannot undo one.
  while (!cache.has(target)) {
    path.push(target);
    if (target.kind !== 'ref') break;
    const next = schemas[target.name];
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
    if (schema.kind === 'object') {
      const forbidden: string[] = [];
      const properties = Object.fromEntries(
        Object.entries(schema.properties).flatMap(([name, value]) => {
          const access = schemaAccess(value, raw);
          const excluded =
            direction === 'request' ? access.readOnly : access.writeOnly;
          if (excluded) {
            if (direction === 'request') forbidden.push(name);
            return [];
          }
          return [[name, child(value)]];
        }),
      );
      // Preserve a fixed object's kind even when every field is excluded. Raw
      // JSON renormalization would reinterpret an empty declaration as a map.
      projected = {
        ...schema,
        properties,
        required: schema.required.filter((name) =>
          Object.hasOwn(properties, name),
        ),
        ...(forbidden.length ? { forbidden } : {}),
      };
    } else if (schema.kind === 'array')
      projected = { ...schema, items: child(schema.items) };
    else if (schema.kind === 'map')
      projected = {
        ...schema,
        values: schema.values === true ? true : child(schema.values),
      };
    else if (schema.kind === 'union')
      projected = { ...schema, branches: schema.branches.map(child) };
    else projected = { ...schema };
    // Distinct nodes keep reference/usage caches local to their directional
    // table; refs preserve names and resolve against that table at every use.
    cache.set(schema, projected);
    return projected;
  }
  const table = (direction: Direction): SchemaTable =>
    Object.fromEntries(
      Object.entries(raw).map(([name, schema]) => [
        name,
        project(schema, direction),
      ]),
    );
  return {
    schemas: { request: table('request'), response: table('response') },
    schema: project,
  };
}
