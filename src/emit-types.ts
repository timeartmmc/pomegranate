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
import { boundType, familySource, typeFamily } from './type-families.js';
import type { TypeFamily, TypeNode } from './type-families.js';

type Variant = {
  name: string;
  direction: Direction;
  target: Client['target'];
  owners: Set<string>;
};

// Identical schemas emitted independently can exceed TypeScript's structural
// comparison limit when a standalone value enters a client, even though each
// module typechecks. Share actual type identities, without brands or generic
// recursion shortcuts that can hide incompatible deep fields.
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
        return Object.values(schema.properties).some((value) =>
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
        hasBinary(descriptor.schemas[direction][name]!, direction),
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
  const account = sourceBudget();
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
      // Dependencies precede their users. Canonical child identities make this
      // an exact type-shape comparison, including directional field projection
      // and browser/native file types, without expanding reference graphs.
      const shape = schemaType(
        descriptor.schemas[variant.direction][name]!,
        variant.direction,
        variant.target,
        (child, direction) =>
          `ref_${node(child, direction, variant.target).id}`,
      );
      let shared = shapes.get(shape);
      if (!shared) {
        account(shape, `components.schemas.${name}`);
        shared = {
          ...variant,
          schema: descriptor.schemas[variant.direction][name]!,
          owners: new Set(),
          id: canonical.length,
          symbol: typeSymbol(name, variant.direction),
        };
        canonical.push(shared);
        shapes.set(shape, shared);
      }
      for (const owner of variant.owners) shared.owners.add(owner);
      nodes.set(key(name, variant.direction, variant.target), shared);
    }
  }
  const families: TypeFamily[] = [];
  for (const name of descriptor.schemaOrder) {
    const members = [
      ...new Set(
        (byName.get(name) ?? []).map((variant) =>
          node(name, variant.direction, variant.target),
        ),
      ),
    ];
    const family = typeFamily(members, (child, parent) =>
      node(child, parent.direction, parent.target),
    );
    if (family) families.push(family);
  }
  const groups = new Map<string, (TypeNode | TypeFamily)[]>();
  for (const entry of [...canonical, ...families]) {
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
  const reference = (entry: { file?: string; symbol: string }) =>
    `import('./${entry.file!}').${entry.symbol}`;
  const accountDeclarations = byteBudget();
  for (const members of groups.values()) {
    const file = members[0]!.file!;
    const local = (entry: { file?: string; symbol: string }) =>
      entry.file === file ? entry.symbol : reference(entry);
    const declarations = members.map((entry, index) => {
      const location =
        'name' in entry
          ? `components.schemas.${entry.name}`
          : 'generated type family';
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
      if (!('schema' in entry)) return admit(familySource(entry, local));
      const value =
        boundType(entry, local, accountPart) ??
        schemaType(
          descriptor.schemas[entry.direction][entry.name]!,
          entry.direction,
          entry.target,
          (child, direction) => {
            const dependency = node(child, direction, entry.target);
            return dependency.file === file
              ? dependency.symbol
              : reference(dependency);
          },
        );
      return admit(`export type ${entry.symbol} = ${value};`);
    });
    addOutput(file, declarations.join('\n'));
  }
  return (name, direction, target) => reference(node(name, direction, target));
}
