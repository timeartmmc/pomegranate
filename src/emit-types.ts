import { createHash } from 'node:crypto';
import { fail } from './diagnostics.js';
import type {
  Client,
  Descriptor,
  Direction,
  Schema,
  Standalone,
} from './model.js';
import { schemaType, typeSymbol } from './schema-types.js';
import { recursiveSchemas, schemaReferences, terminalName } from './schemas.js';
import { schemaChildren, schemaGraph } from './schema-graph.js';
import { operationSchemas } from './projection.js';
import { byteBudget, sourceBudget } from './source-budget.js';

type Variant = {
  name: string;
  direction: Direction;
  target: Client['target'];
  owners: Set<string>;
};
type TypeNode = Omit<Variant, 'name'> & {
  schema: Schema;
  recursive: boolean;
  location: string;
  symbol: string;
  file: string | undefined;
};
export type SchemaTypes = Readonly<{
  component: (
    name: string,
    direction: Direction,
    target?: Client['target'],
  ) => string;
  schema: (
    schema: Schema,
    direction: Direction,
    target?: Client['target'],
  ) => string;
}>;

// Describe one node using child identities, not their expanded source text. The
// schemaType visitor remains the owner of TypeScript shapes in both this plan
// and declaration emission. Distinct graph paths cannot multiply signature work.
function schemaShapes(
  reference: (
    name: string,
    direction: Direction,
    target: Client['target'],
  ) => string,
) {
  const shapes = new Map<string, number>();
  const caches = new Map<string, WeakMap<Schema, number>>();
  const account = sourceBudget();
  function shape(
    schema: Schema,
    direction: Direction,
    target: Client['target'],
    recursive: boolean,
  ): number {
    const context = JSON.stringify([direction, target, recursive]);
    let cache = caches.get(context);
    if (!cache) {
      cache = new WeakMap();
      caches.set(context, cache);
    }
    const known = cache.get(schema);
    if (known !== undefined) return known;
    const value = schemaType(
      schema,
      direction,
      target,
      (name, usage) => reference(name, usage, target),
      recursive,
      (child) => `shape_${shape(child, direction, target, recursive)}`,
    );
    let identity = shapes.get(value);
    if (identity === undefined) {
      account(value, 'generated type graph');
      identity = shapes.size;
      shapes.set(value, identity);
    }
    cache.set(schema, identity);
    return identity;
  }
  return shape;
}

// Public component types and private shared inline types use the same ownership
// grouping. Inline names never enter the public schema inventories or normalized
// source tables; they only give shared type graphs stable emission identities.
export function renderTypes(
  descriptor: Descriptor,
  clients: readonly Client[],
  standalone: readonly Standalone[],
  addOutput: (name: string, source: string) => void,
): SchemaTypes {
  const binary: Record<Direction, Map<string, boolean>> = {
    request: new Map(),
    response: new Map(),
  };
  const parents: Record<Direction, Map<string, Set<string>>> = {
    request: new Map(),
    response: new Map(),
  };
  const recursive = {
    request: recursiveSchemas(descriptor.schemas.request).members,
    response: recursiveSchemas(descriptor.schemas.response).members,
  };
  const shared: Record<Direction, Set<Schema>> = {
    request: new Set(),
    response: new Set(),
  };
  const recursiveNodes: Record<Direction, Set<Schema>> = {
    request: new Set(),
    response: new Set(),
  };
  const binaryCache = new WeakMap<Schema, boolean>();
  function hasBinary(schema: Schema): boolean {
    const known = binaryCache.get(schema);
    if (known !== undefined) return known;
    const value =
      schema.kind === 'binary' || schemaChildren(schema).some(hasBinary);
    binaryCache.set(schema, value);
    return value;
  }
  function propagate(
    seeds: Iterable<string>,
    edges: readonly ReadonlyMap<string, ReadonlySet<string>>[],
  ): ReadonlySet<string> {
    const found = new Set(seeds);
    for (const name of found)
      for (const graph of edges)
        for (const parent of graph.get(name) ?? []) found.add(parent);
    return found;
  }
  for (const direction of ['request', 'response'] as const) {
    const direct: string[] = [];
    for (const name of descriptor.schemaOrder) {
      const schema = descriptor.schemas[direction].get(name)!;
      if (hasBinary(schema)) direct.push(name);
      for (const reference of schemaReferences(schema)) {
        const entries =
          parents[direction].get(reference.name) ?? new Set<string>();
        entries.add(name);
        parents[direction].set(reference.name, entries);
      }
    }
    const reachable = propagate(direct, [parents[direction]]);
    for (const name of descriptor.schemaOrder)
      binary[direction].set(name, reachable.has(name));
  }
  const key = (name: string, direction: Direction, target?: Client['target']) =>
    JSON.stringify([
      name,
      direction,
      binary[direction].get(name) ? target : null,
    ]);
  const variants = new Map<string, Variant>();
  const byName = new Map<string, Variant[]>();
  function select(
    names: readonly string[],
    direction: Direction,
    owner: string,
    target?: Client['target'],
  ): void {
    for (const name of names) {
      const identity = key(name, direction, target);
      let variant = variants.get(identity);
      if (!variant) {
        variant = { name, direction, target, owners: new Set() };
        variants.set(identity, variant);
        const entries = byName.get(name) ?? [];
        entries.push(variant);
        byName.set(name, entries);
      }
      variant.owners.add(owner);
    }
  }
  for (const client of clients) {
    select(
      client.requestSchemas,
      'request',
      `client:${client.name}`,
      client.target,
    );
    select(
      client.responseSchemas,
      'response',
      `client:${client.name}`,
      client.target,
    );
  }
  for (const root of standalone)
    select(root.schemaOrder, root.direction, `standalone:${root.name}`);
  // Sharing follows the selected graphs. An unused composition may share
  // normalized nodes with these roots but must not alter their representation.
  const operations = new Set(clients.flatMap((client) => client.operations));
  for (const direction of ['request', 'response'] as const) {
    const names = new Set(
      [...variants.values()]
        .filter((variant) => variant.direction === direction)
        .map((variant) => variant.name),
    );
    const roots = [...names].map((name) =>
      descriptor.schemas[direction].get(name)!,
    );
    for (const operation of operations)
      for (const schema of operationSchemas(operation, direction))
        roots.push(schema);
    for (const root of standalone)
      if (root.direction === direction) roots.push(root.schema);
    const graph = schemaGraph(roots, descriptor.schemas[direction]);
    const incoming = new Map<Schema, number>();
    // Repeated entry points can arise from inherited parameters. Only inline
    // graph edges require aliases to prevent expansion; root reuse must not
    // change output compared with explicitly repeated declarations.
    for (const schema of graph.nodes)
      for (const child of schemaChildren(schema))
        incoming.set(child, (incoming.get(child) ?? 0) + 1);
    for (const [schema, count] of incoming)
      if (count > 1 && schemaChildren(schema).length > 0)
        shared[direction].add(schema);
    for (const group of graph.groups)
      if (group.length > 1 || graph.edges[group[0]!]!.includes(group[0]!))
        for (const index of group)
          recursiveNodes[direction].add(graph.nodes[index]!);
  }
  const localShape = schemaShapes(
    (name) => `reference_${JSON.stringify(name)}`,
  );
  const different = propagate(
    [...byName.keys()].filter(
      (name) =>
        localShape(
          descriptor.schemas.request.get(name)!,
          'request',
          'browser',
          false,
        ) !==
        localShape(
          descriptor.schemas.response.get(name)!,
          'response',
          'browser',
          false,
        ),
    ),
    [parents.request, parents.response],
  );
  const identities = new Map<string, number>();
  function identity(
    name: string,
    direction: Direction,
    target: Client['target'],
  ): number {
    const terminal = terminalName(name, descriptor.schemas[direction]);
    const value = JSON.stringify([
      terminal,
      different.has(terminal) ? direction : null,
      binary[direction].get(terminal) ? target : null,
    ]);
    let found = identities.get(value);
    if (found === undefined) {
      found = identities.size;
      identities.set(value, found);
    }
    return found;
  }
  const shape = schemaShapes(
    (name, direction, target) =>
      `reference_${identity(name, direction, target)}`,
  );
  const nodes = new Map<string, TypeNode>();
  const canonical: TypeNode[] = [];
  function node(
    name: string,
    direction: Direction,
    target: Client['target'],
  ): TypeNode {
    const found = nodes.get(key(name, direction, target));
    if (!found) fail('generated types', `missing selected type ${name}`);
    return found;
  }
  for (const name of descriptor.schemaOrder) {
    const shapes = new Map<number, TypeNode>();
    for (const variant of byName.get(name) ?? []) {
      const schema = descriptor.schemas[variant.direction].get(name)!;
      if (schema.kind === 'ref') continue;
      const cyclic = recursive[variant.direction].has(name);
      const signature = shape(
        schema,
        variant.direction,
        variant.target,
        cyclic,
      );
      let entry = shapes.get(signature);
      if (!entry) {
        entry = {
          direction: variant.direction,
          target: variant.target,
          schema,
          recursive: cyclic,
          owners: new Set(),
          symbol: typeSymbol(name, variant.direction),
          file: undefined,
          location: `components.schemas.${name}`,
        };
        canonical.push(entry);
        shapes.set(signature, entry);
      }
      for (const owner of variant.owners) entry.owners.add(owner);
      nodes.set(key(name, variant.direction, variant.target), entry);
    }
  }
  for (const variant of variants.values()) {
    const terminal = terminalName(
      variant.name,
      descriptor.schemas[variant.direction],
    );
    if (terminal === variant.name) continue;
    // Constraint siblings preserve a component's public TypeScript identity.
    // Flatten aliases to the productive declaration before emitting bodies.
    const entry = node(terminal, variant.direction, variant.target);
    for (const owner of variant.owners) entry.owners.add(owner);
    nodes.set(key(variant.name, variant.direction, variant.target), entry);
  }
  // A selected component can itself be a shared inline node. Reuse its type
  // only for that node: structural equality must not expose an unrelated public
  // component name through another surface's declaration closure.
  const namedTypes = new WeakMap<Schema, Map<number, TypeNode>>();
  for (const variant of variants.values()) {
    const schema = descriptor.schemas[variant.direction].get(variant.name)!;
    if (schema.kind === 'ref') continue;
    const entries = namedTypes.get(schema) ?? new Map<number, TypeNode>();
    entries.set(
      shape(
        schema,
        variant.direction,
        variant.target,
        recursive[variant.direction].has(variant.name),
      ),
      node(variant.name, variant.direction, variant.target),
    );
    namedTypes.set(schema, entries);
  }
  const privateTypes = new Map<number, TypeNode>();
  const visitedOwners = new Map<string, WeakSet<Schema>>();
  function assignOwners(
    root: Schema,
    direction: Direction,
    target: Client['target'],
    owner: string,
    location: string,
  ): void {
    const context = JSON.stringify([direction, target, owner]);
    let visited = visitedOwners.get(context);
    if (!visited) {
      visited = new WeakSet();
      visitedOwners.set(context, visited);
    }
    const pending = [root];
    while (pending.length > 0) {
      const schema = pending.pop()!;
      if (visited.has(schema)) continue;
      visited.add(schema);
      if (shared[direction].has(schema)) {
        const cyclic = recursiveNodes[direction].has(schema);
        const signature = shape(schema, direction, target, cyclic);
        let entry =
          namedTypes.get(schema)?.get(signature) ?? privateTypes.get(signature);
        if (!entry) {
          // '$' cannot occur in a source component name, so these symbols cannot
          // collide with the independent public component symbols.
          entry = {
            direction,
            target,
            schema,
            recursive: cyclic,
            owners: new Set(),
            symbol: `type_$inline${privateTypes.size}`,
            file: undefined,
            location,
          };
          canonical.push(entry);
          privateTypes.set(signature, entry);
        }
        entry.owners.add(owner);
      }
      for (const child of schemaChildren(schema)) pending.push(child);
    }
  }
  for (const variant of variants.values())
    for (const owner of variant.owners)
      assignOwners(
        descriptor.schemas[variant.direction].get(variant.name)!,
        variant.direction,
        variant.target,
        owner,
        `components.schemas.${variant.name}`,
      );
  for (const client of clients)
    for (const direction of ['request', 'response'] as const)
      for (const operation of client.operations)
        for (const root of operationSchemas(operation, direction))
          assignOwners(
            root,
            direction,
            client.target,
            `client:${client.name}`,
            `paths.${operation.path}.${operation.method.toLowerCase()}`,
          );
  for (const root of standalone)
    assignOwners(
      root.schema,
      root.direction,
      undefined,
      `standalone:${root.name}`,
      `standalone.${root.name}`,
    );
  const groups = new Map<string, TypeNode[]>();
  for (const entry of canonical) {
    const owners = JSON.stringify([...entry.owners].sort());
    // Dependency owner sets only grow. Grouping by ownership preserves each
    // surface's type closure without introducing imports between client APIs.
    // Digests avoid case-folding collisions in file inventories.
    entry.file = `schema-types.${createHash('sha256').update(owners).digest('hex')}.ts`;
    const members = groups.get(owners) ?? [];
    members.push(entry);
    groups.set(owners, members);
  }
  const reference = (entry: TypeNode) =>
    `import('./${entry.file!}').${entry.symbol}`;
  function privateType(
    schema: Schema,
    direction: Direction,
    target: Client['target'],
  ): TypeNode | undefined {
    if (!shared[direction].has(schema)) return undefined;
    const signature = shape(
      schema,
      direction,
      target,
      recursiveNodes[direction].has(schema),
    );
    return (
      namedTypes.get(schema)?.get(signature) ?? privateTypes.get(signature)
    );
  }

  function render(
    schema: Schema,
    direction: Direction,
    target: Client['target'],
    cyclic: boolean,
    ref: (entry: TypeNode) => string,
    accountPart: (source: string) => void = () => {},
  ): string {
    const link = (entry: TypeNode) => {
      const source = ref(entry);
      accountPart(source);
      return source;
    };
    return schemaType(
      schema,
      direction,
      target,
      (name, usage) => link(node(name, usage, target)),
      cyclic,
      (child) => {
        const entry = privateType(child, direction, target);
        return entry
          ? link(entry)
          : render(child, direction, target, cyclic, ref, accountPart);
      },
    );
  }
  const accountDeclarations = byteBudget();
  for (const members of groups.values()) {
    const file = members[0]!.file!;
    const local = (entry: TypeNode) =>
      entry.file === file ? entry.symbol : reference(entry);
    const declarations = members.map((entry, index) => {
      let accounted = 0;
      const accountPart = (source: string) => {
        const bytes = Buffer.byteLength(source);
        accounted += bytes;
        accountDeclarations(bytes, entry.location);
      };
      const value = render(
        entry.schema,
        entry.direction,
        entry.target,
        entry.recursive,
        local,
        accountPart,
      );
      const source = `export type ${entry.symbol} = ${value};`;
      accountDeclarations(
        Buffer.byteLength(source) - accounted + (index === 0 ? 0 : 1),
        entry.location,
      );
      return source;
    });
    addOutput(file, declarations.join('\n'));
  }
  return {
    component: (name, direction, target) =>
      reference(node(name, direction, target)),
    schema: (schema, direction, target) => {
      const entry = privateType(schema, direction, target);
      return entry
        ? reference(entry)
        : render(schema, direction, target, false, reference);
    },
  };
}
