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
import { byteBudget, sourceBudget } from './source-budget.js';

type Variant = {
  name: string;
  direction: Direction;
  target: Client['target'];
  owners: Set<string>;
};
type TypeNode = Variant & {
  symbol: string;
  file: string | undefined;
};

// Identical schemas emitted independently can exceed TypeScript's structural
// comparison limit when a standalone value enters a client, even though each
// module typechecks. Share actual type identities, without brands or generic
// argument expansion across the dependency graph. Distinct directional shapes
// remain ordinary named types subject to TypeScript's comparison limits.
export function renderTypes(
  descriptor: Descriptor,
  clients: readonly Client[],
  standalone: readonly Standalone[],
  addOutput: (name: string, source: string) => void,
): (name: string, direction: Direction, target?: Client['target']) => string {
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
  function hasBinary(schema: Schema): boolean {
    switch (schema.kind) {
      case 'binary':
        return true;
      case 'ref':
        return false;
      case 'object':
        return [...schema.properties.values()].some((value) =>
          hasBinary(value),
        );
      case 'array':
        return hasBinary(schema.items);
      case 'map':
        return schema.values !== true && hasBinary(schema.values);
      case 'intersection':
      case 'union':
        return schema.branches.some(hasBinary);
      case 'boolean':
      case 'integer':
      case 'json':
      case 'null':
      case 'number':
      case 'string':
        return false;
    }
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

  // References retain their names through directional projection. A local type
  // difference affects every ancestor, including every member of a recursive
  // component. Without a reachable difference the two graphs describe the same
  // type and can share an identity before either graph's bodies are emitted.
  const different = propagate(
    [...byName.keys()].filter((name) => {
      const shape = (direction: Direction) =>
        schemaType(
          descriptor.schemas[direction].get(name)!,
          direction,
          'browser',
          (child) => JSON.stringify(child),
        );
      return shape('request') !== shape('response');
    }),
    [parents.request, parents.response],
  );
  const terminal = (name: string, direction: Direction): string =>
    terminalName(name, descriptor.schemas[direction]);
  const identities = new Map<string, number>();
  const identity = (
    name: string,
    direction: Direction,
    target?: Client['target'],
  ) => {
    const name_ = terminal(name, direction);
    const value = JSON.stringify([
      name_,
      different.has(name_) ? direction : null,
      binary[direction].get(name_) ? target : null,
    ]);
    let id = identities.get(value);
    if (id === undefined) {
      id = identities.size;
      identities.set(value, id);
    }
    return id;
  };
  const nodes = new Map<string, TypeNode>();
  const canonical: TypeNode[] = [];
  const accountShapes = sourceBudget();
  const node = (
    name: string,
    direction: Direction,
    target?: Client['target'],
  ): TypeNode => {
    const result = nodes.get(key(name, direction, target));
    if (!result) fail('generated types', `missing selected type ${name}`);
    return result;
  };
  for (const name of descriptor.schemaOrder) {
    const shapes = new Map<string, TypeNode>();
    for (const variant of byName.get(name) ?? []) {
      const schema = descriptor.schemas[variant.direction].get(name)!;
      if (schema.kind === 'ref') continue;
      // Assign every identity before rendering declarations. Child identities
      // depend on graph reachability, not a dependency-first allocation order.
      const shape = schemaType(
        schema,
        variant.direction,
        variant.target,
        (child, direction) =>
          `ref_${identity(child, direction, variant.target)}`,
        recursive[variant.direction].has(name),
      );
      let shared = shapes.get(shape);
      if (!shared) {
        accountShapes(shape, `components.schemas.${name}`);
        shared = {
          ...variant,
          owners: new Set(),
          symbol: typeSymbol(name, variant.direction),
          file: undefined,
        };
        canonical.push(shared);
        shapes.set(shape, shared);
      }
      for (const owner of variant.owners) shared.owners.add(owner);
      nodes.set(key(name, variant.direction, variant.target), shared);
    }
  }
  for (const variant of variants.values()) {
    const target = terminal(variant.name, variant.direction);
    if (target === variant.name) continue;
    // Constraint siblings do not change an alias's public TS type. Flatten the
    // complete chain so published declarations never require recursive alias
    // expansion before they reach a productive object, array or map identity.
    const shared = node(target, variant.direction, variant.target);
    for (const owner of variant.owners) shared.owners.add(owner);
    nodes.set(key(variant.name, variant.direction, variant.target), shared);
  }
  const groups = new Map<string, TypeNode[]>();
  for (const entry of canonical) {
    const owners = JSON.stringify([...entry.owners].sort());
    // Membership grouping keeps files small in number while preserving each
    // output's exact schema closure. Dependency owner sets only grow, so distinct
    // groups cannot introduce an import cycle. Digests also avoid case-folding
    // collisions between legal case-sensitive component and selection names.
    entry.file = `schema-types.${createHash('sha256').update(owners).digest('hex')}.ts`;
    const members = groups.get(owners) ?? [];
    members.push(entry);
    groups.set(owners, members);
  }
  const reference = (entry: TypeNode) =>
    `import('./${entry.file!}').${entry.symbol}`;
  const accountDeclarations = byteBudget();
  for (const members of groups.values()) {
    const file = members[0]!.file!;
    const local = (entry: TypeNode) =>
      entry.file === file ? entry.symbol : reference(entry);
    const declarations = members.map((entry, index) => {
      const location = `components.schemas.${entry.name}`;
      let accounted = 0;
      const accountPart = (source: string) => {
        const bytes = Buffer.byteLength(source);
        accounted += bytes;
        accountDeclarations(bytes, location);
      };
      const admit = (source: string) => {
        accountDeclarations(
          Buffer.byteLength(source) - accounted + (index === 0 ? 0 : 1),
          location,
        );
        return source;
      };
      const value = schemaType(
        descriptor.schemas[entry.direction].get(entry.name)!,
        entry.direction,
        entry.target,
        (child, direction) => {
          const source = local(node(child, direction, entry.target));
          // Preserve incremental reference accounting before schemaType joins
          // long names and import paths into a declaration.
          accountPart(source);
          return source;
        },
        recursive[entry.direction].has(entry.name),
      );
      return admit(`export type ${entry.symbol} = ${value};`);
    });
    addOutput(file, declarations.join('\n'));
  }
  return (name, direction, target) => reference(node(name, direction, target));
}
