import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import type { Schema } from './schema-helpers.ts';

const selection = {
  clients: [],
  standalone: {
    root: { schema: '#/components/schemas/Root', usage: 'request' },
  },
} as const;
const document = (version: string, schemas: Record<string, Schema>) => ({
  openapi: version,
  info: { title: 'Synthetic default type properties', version: '1' },
  paths: {},
  components: { schemas },
});

// JSON instance types distinguish null, arrays and objects. Integers are
// mathematical integers, including finite values outside JS's safe range.
function jsonTypes(value: unknown): readonly string[] {
  if (value === null) return ['null'];
  if (Array.isArray(value)) return ['array'];
  if (typeof value === 'number')
    return Number.isFinite(value) && Math.floor(value) === value
      ? ['number', 'integer']
      : ['number'];
  return [typeof value];
}
const values: readonly (readonly [string, unknown])[] = [
  ['emptyString', ''],
  ['text', 'x'],
  ['numericString', '1'],
  ['true', true],
  ['false', false],
  ['zero', 0],
  ['negativeZero', -0],
  ['one', 1],
  ['fraction', 1.5],
  ['largeInteger', 1e20],
  ['negativeInteger', -7],
  ['null', null],
  ['emptyArray', []],
  ['stringArray', ['a']],
  ['numberArray', [1]],
  ['emptyObject', {}],
  ['record', { a: 1 }],
];
const constraints: Record<string, Schema> = {
  string: { minLength: 5, enum: ['value'] },
  number: { minimum: 10, maximum: 30, enum: [20] },
  integer: { minimum: 10, maximum: 30, enum: [20] },
  boolean: { enum: [true] },
  array: { minItems: 3 },
  object: { properties: { id: { type: 'string' } }, required: ['id'] },
};

function* defaultCases() {
  for (const type of [
    'string',
    'number',
    'integer',
    'boolean',
    'array',
    'object',
    undefined,
  ])
    for (const [valueName, value] of values)
      for (const nullable of [undefined, false, true])
        for (const constrained of type === undefined
          ? [false]
          : [false, true]) {
          const schema: Schema = { default: value };
          if (type !== undefined) schema.type = type;
          if (type === 'array') schema.items = { type: 'string' };
          if (constrained && type !== undefined)
            Object.assign(schema, constraints[type]);
          if (nullable !== undefined) schema.nullable = nullable;
          const withoutDefault = { ...schema };
          delete withoutDefault.default;
          yield {
            name: `${type ?? 'untyped'}_${valueName}_${nullable === undefined ? 'absent' : nullable ? 'nullable' : 'nonnullable'}_${constrained ? 'constrained' : 'plain'}`,
            schema,
            withoutDefault,
            nullableError: nullable === true && type === undefined,
            accepted:
              type === undefined ||
              jsonTypes(value).includes(type) ||
              (value === null && nullable === true),
          };
        }
  for (const [name, type, format, value] of [
    ['dateFormatAnnotation', 'string', 'date', 'not-a-date'],
    ['dateTimeFormatAnnotation', 'string', 'date-time', 'not-a-date-time'],
    ['int32FormatAnnotation', 'integer', 'int32', 2_147_483_648],
    ['floatFormatAnnotation', 'number', 'float', 1e100],
    ['dateFormatWrongType', 'string', 'date', 1],
    ['dateTimeFormatWrongType', 'string', 'date-time', false],
    ['int32FormatWrongType', 'integer', 'int32', 1.5],
    ['floatFormatWrongType', 'number', 'float', '1'],
  ] as const) {
    const schema: Schema = { type, format, default: value };
    const withoutDefault = { ...schema };
    delete withoutDefault.default;
    yield {
      name,
      schema,
      withoutDefault,
      nullableError: false,
      accepted: jsonTypes(value).includes(type),
    };
  }
}
const cases = [...defaultCases()];

function batch(
  entries: readonly (typeof cases)[number][],
  withDefaults: boolean,
) {
  const properties = Object.fromEntries(
    entries.map(({ name, schema, withoutDefault }) => [
      name,
      withDefaults ? schema : withoutDefault,
    ]),
  );
  return {
    Root: { type: 'object', properties },
    Unused: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(properties).map(([name, schema]) => [
          name,
          { ...schema, readOnly: true },
        ]),
      ),
    },
  };
}

void test('OpenAPI 3.0 defaults follow JSON types before selection with precise source diagnostics', async () => {
  for (const version of ['3.0.0', '3.0.4'])
    for (const entry of cases) {
      if (!entry.nullableError && entry.accepted) continue;
      for (const placement of ['selected', 'unused'] as const) {
        const schemas: Record<string, Schema> =
          placement === 'selected'
            ? { Root: entry.schema }
            : {
                Root: { type: 'string' },
                Unused: {
                  type: 'object',
                  properties: { value: { ...entry.schema, readOnly: true } },
                },
              };
        const location =
          placement === 'selected'
            ? 'components.schemas.Root'
            : 'components.schemas.Unused.properties.value';
        const input = document(version, schemas);
        const before = structuredClone(input);
        await assert.rejects(
          compile(input, selection),
          {
            name: 'ContractError',
            location: `${location}.${entry.nullableError ? 'nullable' : 'default'}`,
            message: entry.nullableError
              ? /nullable: true requires an explicit type in the same schema/
              : /OpenAPI 3\.0 default must match its declared type/,
          },
          `${version} ${placement} ${entry.name}`,
        );
        assert.deepEqual(
          input,
          before,
          `${version} ${placement} ${entry.name}: input mutation`,
        );
      }
    }
});

void test('matching OpenAPI 3.0 defaults remain annotations independent of sibling constraints and projection', async () => {
  // OAS3.0.4 §4.7.24.1 checks the same-object type. POM keeps defaults as
  // annotations: bounds, formats, enum, item types and required fields do not insert or
  // validate default payloads. Include matching values that violate each one.
  const accepted = cases.filter(
    (entry) => !entry.nullableError && entry.accepted,
  );
  for (const version of ['3.0.0', '3.0.4']) {
    const input = document(version, batch(accepted, true));
    const before = structuredClone(input);
    assert.deepEqual(
      await compile(input, selection),
      await compile(document(version, batch(accepted, false)), selection),
      `${version}: accepted defaults must not alter generated contracts`,
    );
    assert.deepEqual(input, before, `${version}: input mutation`);
  }
});

void test('OpenAPI 3.1 retains sampled JSON defaults as annotations regardless of declared type', async () => {
  const modern = cases.filter(
    (entry) => !Object.hasOwn(entry.schema, 'nullable'),
  );
  const input = document('3.1.2', batch(modern, true));
  const before = structuredClone(input);
  assert.deepEqual(
    await compile(input, selection),
    await compile(document('3.1.2', batch(modern, false)), selection),
  );
  assert.deepEqual(input, before);
});
