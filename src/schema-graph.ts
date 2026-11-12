import { assertNever, fail } from './diagnostics.js';
import type { Schema, SchemaTable } from './model.js';
import { scalarIntersectionBase } from './intersections.js';

// Inline structural children; named references are separate graph edges.
export function schemaChildren(schema: Schema): readonly Schema[] {
  switch (schema.kind) {
    case 'object':
      return [...schema.properties.values()];
    case 'array':
      return [schema.items];
    case 'map':
      return schema.values === true ? [] : [schema.values];
    case 'intersection':
    case 'union':
      return schema.branches;
    case 'ref':
    case 'binary':
    case 'json':
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      return [];
    default:
      return assertNever(schema);
  }
}
function children(schema: Schema, schemas: SchemaTable): readonly Schema[] {
  if (schema.kind !== 'ref') return schemaChildren(schema);
  const target = schemas.get(schema.name);
  if (!target) fail(schema.location, `unresolved reference ${schema.name}`);
  return [target];
}

// Components are returned in dependency order. Work follows distinct schema
// nodes and edges, so aliases and productive cycles never consume the JS stack.
export function schemaGraph(
  roots: readonly Schema[],
  schemas: SchemaTable,
  terminal: (schema: Schema) => boolean = () => false,
): {
  nodes: readonly Schema[];
  edges: readonly (readonly number[])[];
  groups: readonly (readonly number[])[];
  groupFor: ReadonlyMap<Schema, number>;
} {
  const nodes: Schema[] = [];
  const indexes = new Map<Schema, number>();
  const edges: number[][] = [];
  const reverse: number[][] = [];
  const add = (schema: Schema): number => {
    const known = indexes.get(schema);
    if (known !== undefined) return known;
    const index = nodes.length;
    indexes.set(schema, index);
    nodes.push(schema);
    reverse.push([]);
    return index;
  };
  for (const root of roots) add(root);
  for (let index = 0; index < nodes.length; index++) {
    const schema = nodes[index]!;
    const targets: number[] = [];
    if (!terminal(schema))
      for (const child of children(schema, schemas)) {
        const target = add(child);
        targets.push(target);
        reverse[target]!.push(index);
      }
    edges.push(targets);
  }

  const visited = new Set<number>();
  const finished: number[] = [];
  const stack: { node: number; next: number }[] = [];
  for (let index = 0; index < nodes.length; index++) {
    if (visited.has(index)) continue;
    visited.add(index);
    stack.push({ node: index, next: 0 });
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const target = edges[frame.node]![frame.next++];
      if (target === undefined) {
        finished.push(frame.node);
        stack.pop();
      } else if (!visited.has(target)) {
        visited.add(target);
        stack.push({ node: target, next: 0 });
      }
    }
  }

  const groups: number[][] = [];
  const groupFor = new Map<Schema, number>();
  const pending: number[] = [];
  for (let index = finished.length - 1; index >= 0; index--) {
    const root = finished[index]!;
    if (groupFor.has(nodes[root]!)) continue;
    const group: number[] = [];
    const number = groups.length;
    groupFor.set(nodes[root]!, number);
    pending.push(root);
    while (pending.length > 0) {
      const node = pending.pop()!;
      group.push(node);
      for (const parent of reverse[node]!) {
        const schema = nodes[parent]!;
        if (groupFor.has(schema)) continue;
        groupFor.set(schema, number);
        pending.push(parent);
      }
    }
    groups.push(group);
  }
  // Kosaraju's second pass finds users before dependencies. Reverse that order
  // once so callers can calculate summaries without another graph traversal.
  groups.reverse();
  for (let index = 0; index < groups.length; index++)
    for (const node of groups[index]!) groupFor.set(nodes[node]!, index);
  return { nodes, edges, groups, groupFor };
}

export function schemaReferences(
  schema: Schema,
): readonly Extract<Schema, { kind: 'ref' }>[] {
  const found: Extract<Schema, { kind: 'ref' }>[] = [];
  const visited = new Set<Schema>();
  const pending = [schema];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    if (current.kind === 'ref') found.push(current);
    else {
      const children = schemaChildren(current);
      for (let index = children.length - 1; index >= 0; index--)
        pending.push(children[index]!);
    }
  }
  return found;
}

function sameValueReferences(
  schema: Schema,
): readonly Extract<Schema, { kind: 'ref' }>[] {
  if (schema.kind === 'ref') return [schema];
  if (schema.kind === 'intersection' || schema.kind === 'union')
    return schema.branches.flatMap(sameValueReferences);
  return [];
}

function dependencyOrder(
  schemas: SchemaTable,
  sameValue: boolean,
): readonly string[] {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const pending = new Set<string>();
  const stack: {
    name: string;
    targets: Iterator<Extract<Schema, { kind: 'ref' }>>;
  }[] = [];
  const enter = (name: string, location: string): void => {
    if (visited.has(name)) return;
    if (pending.has(name)) {
      if (sameValue)
        fail(
          location,
          `recursive schemas must descend through an object property, array item or map value (${name}); same-value reference and composition cycles are unsupported`,
        );
      return;
    }
    if (!schemas.has(name)) fail(location, `unresolved reference ${name}`);
    pending.add(name);
    stack.push({
      name,
      targets: (sameValue
        ? sameValueReferences(schemas.get(name)!)
        : schemaReferences(schemas.get(name)!)
      ).values(),
    });
  };
  // Component aliases add no value nesting, so their graph can be much deeper
  // than an inline schema. Preserve depth-first order without the JS call stack.
  for (const name of [...schemas.keys()].sort()) {
    enter(name, `components.schemas.${name}`);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const next = frame.targets.next();
      if (next.done) {
        pending.delete(frame.name);
        visited.add(frame.name);
        ordered.push(frame.name);
        stack.pop();
      } else enter(next.value.name, next.value.location);
    }
  }
  return ordered;
}

export function orderSchemas(schemas: SchemaTable): readonly string[] {
  // Same-value applicators cannot make progress through a recursive instance.
  // Productive cycles are permitted in the full graph; DAG order stays stable.
  dependencyOrder(schemas, true);
  return dependencyOrder(schemas, false);
}

// Renderers share immutable normalized tables across clients and standalone
// roots. Retain one graph analysis per table without retaining old descriptors.
type RecursiveSchemas = Readonly<{
  members: ReadonlySet<string>;
  reachable: ReadonlySet<string>;
}>;
const recursionByTable = new WeakMap<SchemaTable, RecursiveSchemas>();

export function recursiveSchemas(schemas: SchemaTable): RecursiveSchemas {
  const known = recursionByTable.get(schemas);
  if (known) return known;
  const graph = schemaGraph([...schemas.values()], schemas);
  const recursiveGroups = new Set<number>();
  const reachableGroups = new Set<number>();
  for (let index = 0; index < graph.groups.length; index++) {
    const group = graph.groups[index]!;
    if (group.length > 1 || graph.edges[group[0]!]!.includes(group[0]!))
      recursiveGroups.add(index);
    // Groups are dependency-ordered. An acyclic wrapper must own the same
    // traversal budget as the recursive values reachable beneath it.
    if (
      recursiveGroups.has(index) ||
      group.some((node) =>
        graph.edges[node]!.some((target) =>
          reachableGroups.has(graph.groupFor.get(graph.nodes[target]!)!),
        ),
      )
    )
      reachableGroups.add(index);
  }
  const members = new Set<string>();
  const reachable = new Set<string>();
  for (const [name, schema] of schemas) {
    const group = graph.groupFor.get(schema)!;
    if (recursiveGroups.has(group)) members.add(name);
    if (reachableGroups.has(group)) reachable.add(name);
  }
  const result = { members, reachable };
  recursionByTable.set(schemas, result);
  return result;
}

// A normalized schema table belongs to one descriptor and is never mutated.
// Cache terminal declarations, not folded constraints: usage checks must still
// visit intermediate siblings, and scalar intersections retain their own name.
// Weak keys release the cache with its table when a descriptor is discarded.
type Terminal = Readonly<{ name: string; schema: Schema }>;
const terminals = new WeakMap<SchemaTable, Map<string, Terminal>>();

function terminal(
  name: string,
  schemas: SchemaTable,
  location: string,
): Terminal {
  let cache = terminals.get(schemas);
  if (!cache) {
    cache = new Map();
    terminals.set(schemas, cache);
  }
  const path: string[] = [];
  let current = name;
  let result: Terminal;
  // Same-value reference cycles are rejected before terminal resolution.
  for (;;) {
    const known = cache.get(current);
    if (known) {
      result = known;
      break;
    }
    const schema = schemas.get(current);
    if (!schema) fail(location, `unresolved reference ${current}`);
    path.push(current);
    if (schema.kind !== 'ref') {
      result = { name: current, schema };
      break;
    }
    location = schema.location;
    current = schema.name;
  }
  // Include the concrete terminal so later direct references need no table read.
  for (const name of path) cache.set(name, result);
  return result;
}

export function resolveSchema(schema: Schema, schemas: SchemaTable): Schema {
  const resolved =
    schema.kind === 'ref'
      ? terminal(schema.name, schemas, schema.location).schema
      : schema;
  return resolved.kind === 'intersection'
    ? scalarIntersectionBase(resolved, schemas)
    : resolved;
}

// Constraint siblings never change a reference's declaration identity. Types
// and container refinements share the terminal declaration of a whole chain.
export function terminalName(name: string, schemas: SchemaTable): string {
  return terminal(name, schemas, `components.schemas.${name}`).name;
}
