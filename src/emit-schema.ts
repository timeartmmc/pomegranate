import {
  array,
  arrow,
  binary,
  call,
  data,
  identifier,
  literal,
  member,
  method,
  object,
  source,
  spread,
} from './code.js';
import type { Expression } from './code.js';
import { fail } from './diagnostics.js';
import type { Client, Constraints, Direction, Schema } from './model.js';
import { schemaType, validatorType } from './schema-types.js';

function constrain(
  expression: Expression,
  limits: Constraints,
  helpers: Set<string>,
): Expression {
  let result = expression;
  const refine = (predicate: Expression, message: string) => {
    result = method(result, 'refine', [predicate, literal(message)]);
  };
  // JSON Schema counts code points; Zod's native string bounds count UTF-16.
  for (const [key, operator, message] of [
    ['minLength', '>=', 'string is too short'],
    ['maxLength', '<=', 'string is too long'],
  ] as const) {
    const bound = limits[key];
    if (bound !== undefined)
      refine(
        arrow(
          'value',
          binary(
            member(array([spread(identifier('value'))]), 'length'),
            operator,
            literal(bound),
          ),
        ),
        message,
      );
  }
  if (limits.pattern !== undefined) {
    helpers.add('patternTest');
    refine(
      call(identifier('patternTest'), [literal(limits.pattern)]),
      'string does not match pattern',
    );
  }
  // Native array bounds reject oversized input before parsing the items.
  if (limits.minItems !== undefined)
    result = method(result, 'min', [literal(limits.minItems)]);
  if (limits.maxItems !== undefined)
    result = method(result, 'max', [literal(limits.maxItems)]);
  for (const [key, operator] of [
    ['minimum', '>='],
    ['maximum', '<='],
    ['exclusiveMinimum', '>'],
    ['exclusiveMaximum', '<'],
  ] as const) {
    const bound = limits[key];
    if (bound !== undefined)
      refine(
        arrow('value', binary(identifier('value'), operator, literal(bound))),
        `expected value ${operator} ${bound}`,
      );
  }
  if (limits.multipleOf !== undefined) {
    helpers.add('multipleOf');
    refine(
      call(identifier('multipleOf'), [literal(limits.multipleOf)]),
      'expected a declared multiple',
    );
  }
  return result;
}

export function schemaRenderer(
  schemas: Readonly<Record<string, Schema>>,
  reference: (name: string, direction: Direction) => Expression,
  typeReference: (name: string, direction: Direction) => string,
  target?: Client['target'],
) {
  const helpers = new Set<string>();
  const declarations: string[] = [];
  let usesZod = false;
  const zod = (name: string, args: readonly Expression[] = []): Expression => {
    usesZod = true;
    return method(identifier('z'), name, args);
  };
  const scalar = (
    value: Extract<
      Schema,
      { kind: 'string' | 'number' | 'integer' | 'boolean' | 'null' }
    >,
  ): Expression => {
    let expression: Expression;
    if (value.kind === 'string' && value.format === 'date-time') {
      helpers.add('dateTime');
      expression = identifier('dateTime');
    } else if (value.kind === 'string' && value.format === 'date') {
      usesZod = true;
      expression = call(member(member(identifier('z'), 'iso'), 'date'));
    } else if (value.kind === 'string')
      expression = zod(value.format === 'uuid' ? 'guid' : 'string');
    else if (value.kind === 'integer')
      // .int() would add a safe-integer range that the contract did not declare.
      expression = method(zod('number'), 'refine', [
        member(identifier('Number'), 'isInteger'),
        literal('expected an integer'),
      ]);
    else expression = zod(value.kind);
    if (
      value.kind === 'string' ||
      value.kind === 'number' ||
      value.kind === 'integer'
    )
      expression = constrain(expression, value, helpers);
    return value.literals
      ? method(expression, 'and', [
          zod('literal', [
            data(
              value.literals.length === 1 ? value.literals[0] : value.literals,
            ),
          ]),
        ])
      : expression;
  };

  function schema(
    value: Schema,
    direction: Direction,
    location: string,
    scope: string,
    bindRoot = false,
  ): Expression {
    let index = 0;
    const build = (
      value: Schema,
      location: string,
      bind: boolean,
    ): Expression => {
      const child = (value: Schema, path: string) => build(value, path, true);
      let expression: Expression;
      switch (value.kind) {
        case 'binary': {
          if (!target)
            fail(location, 'binary schema requires a multipart client target');
          const helper = target === 'browser' ? 'browserFile' : 'nativeFile';
          helpers.add(helper);
          return identifier(helper);
        }
        case 'ref':
          return constrain(
            reference(value.name, direction),
            value.constraints,
            helpers,
          );
        case 'map':
          helpers.add('recordSchema');
          if (value.values === true) helpers.add('jsonValue');
          expression = call(identifier('recordSchema'), [
            value.values === true
              ? identifier('jsonValue')
              : child(value.values, `${location}.additionalProperties`),
          ]);
          break;
        case 'union':
          // Required distinct literal tags make supported oneOf branches disjoint.
          expression = zod('union', [
            array(
              value.branches.map((branch, index) =>
                child(
                  branch,
                  `${location}.${value.discriminator ? 'oneOf' : 'anyOf'}[${index}]`,
                ),
              ),
            ),
          ]);
          break;
        case 'object':
          // Fixed fields use TypeScript's structural object semantics. Zod
          // validates inherited/class fields too and copies every accepted value;
          // dynamic maps deliberately require plain records instead.
          expression = method(
            zod('object', [
              object(
                Object.entries(value.properties).map(([name, field]) => {
                  const expression = child(
                    field,
                    `${location}.properties.${name}`,
                  );
                  return [
                    name,
                    value.required.includes(name)
                      ? expression
                      : method(expression, 'optional'),
                  ];
                }),
              ),
            ]),
            direction === 'request' ? 'strict' : 'strip',
          );
          break;
        case 'array':
          expression = constrain(
            zod('array', [child(value.items, `${location}.items`)]),
            value,
            helpers,
          );
          break;
        case 'boolean':
        case 'integer':
        case 'null':
        case 'number':
        case 'string':
          return scalar(value);
      }
      if (!bind) return expression;
      // Flat, typed aggregate bindings bound formatter and inference depth even
      // for inline schemas. Keep each binding beside its owning declaration so
      // referenced components have already initialized in dependency order.
      const name = `${scope}_part${index++}`;
      const type = `type_${name}`;
      declarations.push(`type ${type} = ${schemaType(value, direction, target, typeReference)};
        const ${name}: ${validatorType(value, type, schemas)} = ${source(expression, location)};`);
      return identifier(name);
    };
    return build(value, location, bindRoot);
  }
  return {
    schema,
    helpers,
    usesZod: () => usesZod,
    takeDeclarations: () => declarations.splice(0).join('\n'),
  };
}

export type SchemaRenderer = ReturnType<typeof schemaRenderer>;
