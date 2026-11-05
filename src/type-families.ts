import { literal } from './code.js';
import type { Client, Direction, Schema } from './model.js';
import { schemaType } from './schema-types.js';

type Declaration = { symbol: string; file?: string };
type Parameter = { object: boolean };
type Context = {
  reference: (declaration: Declaration) => string;
  parameter: (parameter: Parameter) => string;
};
type Source = (context: Context) => string;
export type TypeNode = Declaration & {
  name: string;
  direction: Direction;
  target: Client['target'];
  owners: Set<string>;
  id: number;
  schema: Schema;
  binding?: Binding;
};
export type TypeFamily = Declaration & {
  owners: Set<string>;
  parameters: readonly Parameter[];
  source: Source;
  object: boolean;
};
type Binding = { family: TypeFamily; values: readonly Source[] };
type Entry = { node: TypeNode; schema: Schema };

// TypeScript compares related directional types structurally unless their
// shared constructors carry the differing parts as covariant parameters. Keep
// those parts shallow and forward positional arguments through the whole graph.
// Nested Pick packs hit instantiation limits on supported depth-128 objects;
// immediate-child arguments still require deeply recursive comparisons.
export function typeFamily(
  nodes: readonly TypeNode[],
  resolve: (name: string, node: TypeNode) => TypeNode,
): TypeFamily | undefined {
  if (nodes.length < 2) return undefined;
  if (nodes.every((node) => node.schema.kind === 'ref')) {
    for (const node of nodes) {
      if (node.schema.kind === 'ref')
        node.binding = resolve(node.schema.name, node).binding!;
    }
    return undefined;
  }
  const parameters: Parameter[] = [];
  const included = new Set<Parameter>();
  const values = nodes.map(() => new Map<Parameter, Source>());
  const include = (parameter: Parameter) => {
    if (!included.has(parameter)) {
      included.add(parameter);
      parameters.push(parameter);
    }
  };
  const plain =
    ({ node, schema }: Entry): Source =>
    (context) =>
      schemaType(schema, node.direction, node.target, (name) =>
        context.reference(resolve(name, node)),
      );
  function render(entries: readonly Entry[]): Source {
    const first = entries[0]!;
    const shapes = entries.map(({ node, schema }) =>
      schemaType(
        schema,
        node.direction,
        node.target,
        (name) => `ref_${resolve(name, node).id}`,
      ),
    );
    if (shapes.every((shape) => shape === shapes[0])) return plain(first);
    const schemas = entries.map(({ schema }) => schema);
    if (schemas.every((schema) => schema.kind === 'ref')) {
      const targets = entries.map(({ node }, index) =>
        resolve(schemas[index]!.name, node),
      );
      const family = targets[0]!.binding!.family;
      for (const parameter of family.parameters) include(parameter);
      targets.forEach((target, index) => {
        family.parameters.forEach((parameter, position) =>
          values[index]!.set(parameter, target.binding!.values[position]!),
        );
      });
      return (context) =>
        `${context.reference(family)}<${family.parameters.map(context.parameter).join(',')}>`;
    }
    if (schemas.every((schema) => schema.kind === 'object')) {
      const objects = schemas;
      const names = Object.keys(objects[0]!.properties);
      const common = names.filter((name) =>
        objects.every((schema) => Object.hasOwn(schema.properties, name)),
      );
      const children = new Map(
        common.map((name) => [
          name,
          render(
            entries.map(({ node }, index) => ({
              node,
              schema: objects[index]!.properties[name]!,
            })),
          ),
        ]),
      );
      const signatures = objects.map((schema) =>
        JSON.stringify([
          Object.keys(schema.properties),
          schema.required,
          schema.forbidden ?? [],
        ]),
      );
      if (signatures.every((signature) => signature === signatures[0]))
        return (context) =>
          schemaType(
            objects[0]!,
            first.node.direction,
            first.node.target,
            (name) => context.reference(resolve(name, first.node)),
            (name) => children.get(name)!(context),
          );
      // The row owns exact keys, requiredness and exclusive fields. Only common
      // children enter the shared template: an excluded field must not import
      // another direction's component dependencies into this output.
      const parameter: Parameter = { object: true };
      include(parameter);
      entries.forEach(({ node }, index) => {
        const schema = objects[index]!;
        values[index]!.set(parameter, (context) =>
          schemaType(
            schema,
            node.direction,
            node.target,
            (name) => context.reference(resolve(name, node)),
            (name) => (children.has(name) ? 'unknown' : undefined),
          ),
        );
      });
      return (context) => {
        const row = context.parameter(parameter);
        const choices = [...children]
          .map(
            ([name, child]) =>
              `K extends ${literal(name).source} ? ${child(context)}${objects[0]!.required.includes(name) ? '' : ' | undefined'} : `,
          )
          .join('');
        return `{[K in keyof ${row}]:${choices}${row}[K]}`;
      };
    }
    if (schemas.every((schema) => schema.kind === 'array')) {
      const child = render(
        entries.map(({ node }, index) => ({
          node,
          schema: schemas[index]!.items,
        })),
      );
      return (context) => `Array<${child(context)}>`;
    }
    if (schemas.every((schema) => schema.kind === 'map')) {
      const child = render(
        entries.map(({ node }, index) => ({
          node,
          schema:
            schemas[index]!.values === true
              ? { kind: 'json' }
              : schemas[index]!.values,
        })),
      );
      return (context) => `Record<string,${child(context)}>`;
    }
    if (schemas.every((schema) => schema.kind === 'union')) {
      const branches = schemas[0]!.branches.map((_, index) =>
        render(
          entries.map(({ node }, position) => ({
            node,
            schema: schemas[position]!.branches[index]!,
          })),
        ),
      );
      return (context) =>
        `(${branches.map((branch) => branch(context)).join('|')})`;
    }
    const parameter: Parameter = { object: false };
    include(parameter);
    entries.forEach((entry, index) =>
      values[index]!.set(parameter, plain(entry)),
    );
    return (context) => context.parameter(parameter);
  }
  const source = render(nodes.map((node) => ({ node, schema: node.schema })));
  const family: TypeFamily = {
    symbol: `${nodes[0]!.symbol}_shape`,
    owners: new Set(nodes.flatMap((node) => [...node.owners])),
    parameters,
    source,
    object: nodes[0]!.schema.kind === 'object',
  };
  nodes.forEach((node, index) => {
    node.binding = {
      family,
      values: parameters.map((parameter) => values[index]!.get(parameter)!),
    };
  });
  return family;
}

export function familySource(
  family: TypeFamily,
  reference: Context['reference'],
): string {
  const positions = new Map(
    family.parameters.map((entry, index) => [entry, `T${index}`]),
  );
  const parameter = (entry: Parameter) => positions.get(entry)!;
  // Explicit covariance avoids recursively inferring variance at every object
  // level. TypeScript checks the annotation against these data-only templates.
  const parameters = family.parameters
    .map(
      (entry) =>
        `${family.object ? 'out ' : ''}${parameter(entry)}${entry.object ? ' extends object' : ''}`,
    )
    .join(',');
  return `export type ${family.symbol}<${parameters}> = ${family.source({ reference, parameter })};`;
}

export function boundType(
  node: TypeNode,
  reference: Context['reference'],
  account: (source: string) => void,
): string | undefined {
  if (!node.binding) return undefined;
  const { family, values } = node.binding;
  const context: Context = {
    reference,
    parameter: () => {
      throw new Error('unbound type parameter');
    },
  };
  const arguments_ = values.map((value) => {
    const source = value(context);
    account(source);
    return source;
  });
  return `${reference(family)}<${arguments_.join(',')}>`;
}
