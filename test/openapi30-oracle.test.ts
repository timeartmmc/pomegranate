import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv } from 'ajv';
import { compile } from '../dist/index.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const cases: readonly { name: string; schema: Schema }[] = [
  {
    name: 'String',
    schema: { type: 'string', nullable: true, minLength: 1 },
  },
  {
    name: 'EnumExcludesNull',
    schema: { type: 'string', nullable: true, enum: ['ready'] },
  },
  {
    name: 'EnumIncludesNull',
    schema: { type: 'string', nullable: true, enum: ['ready', null] },
  },
  {
    name: 'NullOnlyEnum',
    schema: { type: 'string', nullable: true, enum: [null] },
  },
  { name: 'FalseNullable', schema: { type: 'string', nullable: false } },
  { name: 'Boolean', schema: { type: 'boolean', nullable: true } },
  {
    name: 'Integer',
    schema: { type: 'integer', nullable: true, minimum: 1, maximum: 5 },
  },
  {
    name: 'Number',
    schema: { type: 'number', nullable: true, minimum: 1, maximum: 5 },
  },
  {
    name: 'Array',
    schema: {
      type: 'array',
      nullable: true,
      items: { type: 'integer' },
      minItems: 1,
      maxItems: 2,
    },
  },
  {
    name: 'Map',
    schema: {
      type: 'object',
      nullable: true,
      additionalProperties: { type: 'integer' },
    },
  },
  {
    name: 'EmptyObject',
    schema: { type: 'object', nullable: true, additionalProperties: false },
  },
];

const samples: readonly unknown[] = [
  null,
  undefined,
  true,
  false,
  '',
  'ready',
  'other',
  0,
  1,
  1.5,
  5,
  6,
  [],
  [1],
  [1, 2],
  [1, 2, 3],
  ['one'],
  {},
  { a: 1 },
  { a: null },
];

void test('OpenAPI 3.0 standalone validators agree with independent nullable validation', async (t) => {
  const schemas = Object.fromEntries(
    cases.map(({ name, schema }) => [name, schema]),
  );
  const standalone = Object.fromEntries(
    cases.map(({ name }) => [
      name.toLowerCase(),
      { schema: `#/components/schemas/${name}`, usage: 'request' as const },
    ]),
  );
  const files = await compile(
    {
      openapi: '3.0.4',
      info: { title: 'Synthetic nullable oracle', version: '1' },
      paths: {},
      components: { schemas },
    },
    { clients: [], standalone },
  );
  const root = await generatedTestWorkspace(t, files);
  // Ajv implements nullable directly. Feed both compilers the original 3.0
  // assertions: no type-array rewriting, coercion, or default insertion. This
  // oracle covers nullable; Ajv's dialect does not accept boolean numeric bounds.
  const ajv = new Ajv({ strict: true });
  for (const { name, schema } of cases) {
    const reference = ajv.compile(schema);
    const generated = await importGenerated<StandaloneModule>(
      root,
      `standalone.${name.toLowerCase()}.ts`,
    );
    for (const sample of samples) {
      const context = `${name}: ${JSON.stringify(sample)}`;
      const result = generated.schema.safeParse(sample);
      assert.equal(result.success, reference(sample), context);
      if (result.success) assert.deepEqual(result.data, sample, context);
    }
  }
});
