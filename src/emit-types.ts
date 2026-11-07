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
import { byteBudget, sourceBudget } from './source-budget.js';

type Variant = {
  name: string;
  direction: Direction;
  target: Client['target'];
  owners: Set<string>;
};
type TypeNode = Variant & {
  id: number;
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
  function hasBinary(schema: Schema, direction: Direction): boolean {
    switch (schema.kind) {
      case 'binary':
        return true;
      case 'ref':
        return binary[direction].get(schema.name)!;
      case 'object':
        return [...schema.properties.values()].some((value) =>
          hasBinary(value, direction),
        );
      case 'array':
        return hasBinary(schema.items, direction);
      case 'map':
        return schema.values !== true && hasBinary(schema.values, direction);
      case 'union':
        return schema.branches.some((value) => hasBinary(value, direction));
      case 'boolean':
      case 'integer':
      case 'json':
      case 'null':
      case 'number':
      case 'string':
        return false;
    }
  }
  for (const name of descriptor.schemaOrder)
    for (const direction of ['request', 'response'] as const)
      binary[direction].set(
        name,
        hasBinary(descriptor.schemas[direction].get(name)!, direction),
      );

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
      if (schema.kind === 'ref') {
        // Reference siblings constrain values without changing their TS type.
        // Reuse the target now: consumers skipping declaration checking must
        // not recursively resolve thousands of aliases before reaching it.
        const target = node(schema.name, variant.direction, variant.target);
        for (const owner of variant.owners) target.owners.add(owner);
        nodes.set(key(name, variant.direction, variant.target), target);
        continue;
      }
      // Dependencies precede their users. Canonical child identities make this
      // an exact type-shape comparison, including directional field projection
      // and browser/native file types, without expanding reference graphs.
      const shape = schemaType(
        schema,
        variant.direction,
        variant.target,
        (child, direction) =>
          `ref_${node(child, direction, variant.target).id}`,
      );
      let shared = shapes.get(shape);
      if (!shared) {
        accountShapes(shape, `components.schemas.${name}`);
        shared = {
          ...variant,
          owners: new Set(),
          id: canonical.length,
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
      );
      return admit(`export type ${entry.symbol} = ${value};`);
    });
    addOutput(file, declarations.join('\n'));
  }
  return (name, direction, target) => reference(node(name, direction, target));
}
