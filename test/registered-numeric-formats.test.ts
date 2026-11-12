import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import type { CompileOptions } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { invalidOptions } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

const formats = {
  uint32: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
  decimal: { type: 'number' },
  quarter: { type: 'number', multipleOf: 0.25 },
} as const;
const selection = {
  clients: [],
  formats,
  standalone: {
    value: { schema: ref('Value').$ref, usage: 'request' },
  },
} as const;
function document(schema: Schema, openapi = '3.1.2') {
  return {
    openapi,
    info: { title: 'Synthetic numeric registrations', version: '1' },
    paths: {},
    components: {
      schemas: { Value: schema, Base: { type: 'integer', format: 'uint32' } },
    },
  };
}

void test('numeric registrations lower to ordinary constraints in both dialects and YAML', async (t) => {
  const value = { type: 'integer', format: 'uint32', minimum: 2, maximum: 10 };
  const expected = await compile(
    document({ type: 'integer', minimum: 2, maximum: 10 }),
    selection,
  );
  const before = structuredClone(selection);
  for (const version of ['3.0.4', '3.1.2']) {
    const source = document(value, version);
    const original = structuredClone(source);
    const files = await compile(source, selection);
    assert.deepEqual(files, expected);
    assert.deepEqual(
      await compile(parseYaml(stringify(source), 'numeric.yaml'), selection),
      expected,
    );
    assert.deepEqual(source, original);
    const root = await generatedTestWorkspace(t, files);
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      'standalone.value.ts',
    );
    for (const valid of [2, 5, 10]) assert.equal(schema.parse(valid), valid);
    for (const invalid of [
      -1,
      0,
      1,
      11,
      4_294_967_296,
      2.5,
      '2',
      null,
      Infinity,
    ])
      assert.equal(schema.safeParse(invalid).success, false);
  }
  assert.deepEqual(selection, before);
});

void test('numeric format constraints survive aliases, composition, nullability and independent multiples', async (t) => {
  for (const [value, valid, invalid] of [
    [{ $ref: ref('Base').$ref, maximum: 5 }, [0, 5], [-1, 6]],
    [
      { allOf: [ref('Base'), { type: 'integer', minimum: 2 }] },
      [2, 4_294_967_295],
      [1, 4_294_967_296],
    ],
    [
      { type: ['number', 'null'], format: 'quarter', multipleOf: 0.1 },
      [null, 0, 0.5, 1],
      [0.1, 0.25, 0.75, '0.5'],
    ],
    [
      { type: 'number', format: 'decimal' },
      [0, -1, 0.125],
      [NaN, Infinity, '1'],
    ],
    [
      { type: 'integer', format: 'uint32', nullable: true },
      [null, 0],
      [-1, 0.5],
    ],
  ] satisfies [Schema, unknown[], unknown[]][]) {
    const root = await generatedTestWorkspace(
      t,
      await compile(
        document(value, value.nullable === true ? '3.0.4' : '3.1.2'),
        selection,
      ),
    );
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      'standalone.value.ts',
    );
    for (const sample of valid) assert.deepEqual(schema.parse(sample), sample);
    for (const sample of invalid)
      assert.equal(schema.safeParse(sample).success, false, String(sample));
  }
});

void test('numeric registration types, definitions and literal contradictions fail before output selection', async () => {
  for (const value of [
    { type: 'number', format: 'uint32' },
    { type: 'string', format: 'decimal' },
    { type: 'integer', format: 'decimal' },
    { type: 'integer', format: 'uint32', minimum: 4_294_967_296 },
    { type: 'integer', format: 'uint32', enum: [-1] },
    { type: 'number', format: 'quarter', multipleOf: 0.1, enum: [0.25] },
    { type: 'number', format: 'quarter', multipleOf: 0.1, enum: [0.1] },
  ])
    await assert.rejects(compile(document(value), selection), ContractError);
  const definitions: unknown[] = [
    { type: 'boolean' },
    { type: 'number', pattern: 'x' },
    { type: 'integer', minimum: NaN },
    { type: 'number', maximum: Infinity },
    { type: 'number', exclusiveMinimum: true },
    { type: 'number', minimum: 2, maximum: 1 },
    { type: 'integer', minimum: 0.1, maximum: 0.9 },
    { type: 'number', multipleOf: 0 },
    { type: 'number', multipleOf: -1 },
  ];
  for (const bad of definitions)
    await assert.rejects(
      invalidOptions(compile, document({ type: 'string' }), {
        clients: [],
        formats: { ...formats, unused: bad },
      }),
      (error) =>
        error instanceof ContractError &&
        error.location.startsWith('formats.unused'),
    );
  const options: CompileOptions = {
    ...selection,
    formats: {
      ...formats,
      positive: { type: 'number', exclusiveMinimum: 0 },
    },
  };
  await compile(document({ type: 'number', format: 'positive' }), options);
});
