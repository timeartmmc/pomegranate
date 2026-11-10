import { fail } from './diagnostics.js';
import { jsonSource, propertyKey } from './code.js';
import { isRequired } from './required-index.js';
import type { Client, Direction, Schema } from './model.js';

function identifier(name: string): string {
  // Escape the escape character too: A-B, A.B and A_hB must remain distinct.
  // Symbols depend only on their component, so adding a reachable schema does
  // not rename every subsequent validator in a generated diff.
  return name.replace(/[_\-.]/g, (character) =>
    character === '_' ? '_u' : character === '-' ? '_h' : '_d',
  );
}

export const typeSymbol = (name: string, direction: Direction): string =>
  `type_${identifier(name)}_${direction}`;
export const parseSymbol = (name: string, direction: Direction): string =>
  `parse_${identifier(name)}_${direction}`;

export function schemaType(
  schema: Schema,
  direction: Direction,
  target?: Client['target'],
  reference: (name: string, direction: Direction) => string = typeSymbol,
  recursive = false,
): string {
  const child = (value: Schema): string =>
    schemaType(value, direction, target, reference, recursive);
  switch (schema.kind) {
    case 'json':
      return "import('./runtime.ts').JsonValue";
    case 'ref':
      return reference(schema.name, direction);
    case 'object': {
      // TypeScript's {} includes non-null primitives. Match the empty-object
      // parser so named types cannot admit values the validator rejects.
      if (schema.properties.size === 0) return 'Record<string, never>';
      const properties = [...schema.properties].map(([name, value]) => {
        const required = isRequired(schema.required, name);
        return `${propertyKey(name)}${required ? '' : '?'}: ${child(value)}${required ? '' : ' | undefined'};`;
      });
      // Explicit forbidden keys also reject structural assignments and spreads.
      for (const name of schema.forbidden ?? [])
        properties.push(`${propertyKey(name)}?: never;`);
      return `{${properties.join('\n')}}`;
    }
    case 'array':
      return `Array<${child(schema.items)}>`;
    case 'map': {
      const value =
        schema.values === true
          ? "import('./runtime.ts').JsonValue"
          : child(schema.values);
      // TypeScript permits recursive index signatures but rejects the same
      // self-reference through the generic Record alias (TS2456).
      return recursive
        ? `{ [key: string]: ${value} }`
        : `Record<string, ${value}>`;
    }
    case 'union':
      return `(${schema.branches.map(child).join(' | ')})`;
    case 'intersection':
      // Composition admits only scalar conjuncts of one primitive type, with
      // number and integer both rendering as number. Literals carry narrowing.
      return schema.literals
        ? schema.literals.map((value) => jsonSource(value)).join(' | ')
        : child(schema.branches[0]!);
    case 'binary':
      if (target === undefined)
        fail(
          'generated type',
          'binary schema requires a multipart client target',
        );
      return target === 'browser'
        ? 'File'
        : "import('./runtime.ts').NativeFile";
    case 'integer':
    case 'number':
    case 'string':
    case 'boolean':
    case 'null':
      return schema.literals
        ? schema.literals.map((literal) => jsonSource(literal)).join(' | ')
        : schema.kind === 'integer'
          ? 'number'
          : schema.kind;
  }
}
