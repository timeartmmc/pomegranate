import { assertNever, fail } from './diagnostics.js';
import type { Schema, SchemaTable } from './model.js';

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
