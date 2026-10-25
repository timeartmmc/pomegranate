import { fail } from './diagnostics.js';
import type { Client, Direction, Schema } from './model.js';
import { resolveSchema } from './schemas.js';

function identifier(name: string): string {
  // Escape the escape character too: A-B, A.B and A_hB must remain distinct.
  // Symbols depend only on their component, so adding a reachable schema does
  // not rename every subsequent validator in a generated diff.
  return name.replace(/[_\-.]/g, (character) =>
    character === '_' ? '_u' : character === '-' ? '_h' : '_d',
  );
}

export const schemaSymbol = (name: string, direction: Direction): string =>
  `schema_${identifier(name)}_${direction}`;
export const typeSymbol = (name: string, direction: Direction): string =>
  `type_${identifier(name)}_${direction}`;

export function schemaType(
  schema: Schema,
  direction: Direction,
  target?: Client['target'],
  reference: (name: string, direction: Direction) => string = typeSymbol,
): string {
  const child = (value: Schema): string =>
    schemaType(value, direction, target, reference);
  switch (schema.kind) {
    case 'ref':
      return reference(schema.name, direction);
    case 'object':
      // TypeScript's {} includes non-null primitives. Match Zod's empty-object
      // contract so named types cannot admit values the validator rejects.
      if (Object.keys(schema.properties).length === 0)
        return 'Record<string, never>';
      return `{${Object.entries(schema.properties)
        .map(([name, value]) => {
          const required = schema.required.includes(name);
          return `[${JSON.stringify(name)}]${required ? '' : '?'}: ${child(value)}${required ? '' : ' | undefined'};`;
        })
        .join('\n')}}`;
    case 'array':
      return `Array<${child(schema.items)}>`;
    case 'map':
      return `Record<string, ${schema.values === true ? "import('./runtime.ts').JsonValue" : child(schema.values)}>`;
    case 'union':
      return `(${schema.branches.map(child).join(' | ')})`;
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
        ? schema.literals.map((literal) => JSON.stringify(literal)).join(' | ')
        : schema.kind === 'integer'
          ? 'number'
          : schema.kind;
  }
}

export function validatorType(
  schema: Schema,
  name: string,
  schemas: Readonly<Record<string, Schema>>,
): string {
  // A named structural type stops inference expanding through every reference.
  // Arrays retain their specialized validator API: $ref siblings use native
  // .min/.max checks to reject oversized inputs before validating their items.
  return resolveSchema(schema, schemas).kind === 'array'
    ? `import('zod').ZodArray<import('zod').ZodType<${name}[number], ${name}[number]>>`
    : `import('zod').ZodType<${name}, ${name}>`;
}
