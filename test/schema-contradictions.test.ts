import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { compile, ContractError, runProject } from '../dist/index.js';
import { fileSnapshot, fixture, temporary } from './helpers.ts';
import type { Schema } from './schema-helpers.ts';

const selection = { clients: ['consumer'] };
const invalidSchemas: [string, Schema, RegExp][] = [
  [
    'literal at exclusive minimum',
    { type: 'number', const: 1, exclusiveMinimum: 1 },
    /literal violates declared bounds/,
  ],
  [
    'array interval',
    { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 1 },
    /minItems exceeds maxItems/,
  ],
  [
    'string interval',
    { type: 'string', minLength: 2, maxLength: 1 },
    /minLength exceeds maxLength/,
  ],
  [
    'number interval',
    { type: 'number', minimum: 2, maximum: 1 },
    /number bounds admit no finite number/,
  ],
  [
    'exclusive number interval',
    { type: 'number', exclusiveMinimum: 2, exclusiveMaximum: 1 },
    /number bounds admit no finite number/,
  ],
  [
    'enum pattern',
    { type: 'string', enum: ['ab'], pattern: '^x' },
    /literal.*pattern/,
  ],
  [
    'partially invalid enum',
    { type: 'string', enum: ['xa', 'ab'], pattern: '^x' },
    /literal.*pattern/,
  ],
  [
    'uuid const',
    { type: 'string', const: 'nope', format: 'uuid' },
    /literal.*uuid format/,
  ],
  [
    'date enum',
    { type: 'string', enum: ['2025-02-29'], format: 'date' },
    /literal.*date format/,
  ],
  [
    'date-time const',
    { type: 'string', const: '2026-10-25T12:00Z', format: 'date-time' },
    /literal.*date-time format/,
  ],
  [
    'integer multiple',
    { type: 'integer', enum: [3], multipleOf: 2 },
    /literal.*multipleOf/,
  ],
  [
    'decimal multiple',
    { type: 'number', const: 0.3, multipleOf: 0.2 },
    /literal.*multipleOf/,
  ],
  [
    'fractional integer interval',
    { type: 'integer', minimum: 0.5, maximum: 0.9 },
    /integer bounds admit no finite integer/,
  ],
  [
    'negative integer interval',
    { type: 'integer', minimum: -0.9, maximum: -0.5 },
    /integer bounds admit no finite integer/,
  ],
  [
    'exclusive integer interval',
    { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 1 },
    /integer bounds admit no finite integer/,
  ],
  [
    'exclusive signed zero',
    { type: 'integer', minimum: -0, exclusiveMaximum: 1, exclusiveMinimum: 0 },
    /integer bounds admit no finite integer/,
  ],
  [
    'large adjacent integers',
    {
      type: 'integer',
      exclusiveMinimum: 2 ** 54,
      exclusiveMaximum: 2 ** 54 + 4,
    },
    /integer bounds admit no finite integer/,
  ],
  [
    'finite upper endpoint',
    { type: 'number', exclusiveMinimum: Number.MAX_VALUE },
    /number bounds admit no finite number/,
  ],
  [
    'finite lower endpoint',
    { type: 'number', exclusiveMaximum: -Number.MAX_VALUE },
    /number bounds admit no finite number/,
  ],
  [
    'adjacent floating values',
    {
      type: 'number',
      exclusiveMinimum: 1,
      exclusiveMaximum: 1 + Number.EPSILON,
    },
    /number bounds admit no finite number/,
  ],
];

for (const [name, schema, message] of invalidSchemas) {
  void test(`contradictory ${name} diagnoses before selection`, async () => {
    const document = fixture();
    Object.assign(document.components.schemas, { Invalid: schema });
    await assert.rejects(
      compile(document, selection),
      (error) =>
        error instanceof ContractError &&
        /components.schemas.Invalid/.test(error.location) &&
        message.test(error.message),
    );
    Object.assign(document.components.schemas, {
      Invalid: {
        ...schema,
        type: [schema.type, 'null'],
      },
    });
    await assert.rejects(compile(document, selection), message);
  });
}

const invalidReferences: [string, Schema, Schema, RegExp][] = [
  [
    'literal at exclusive minimum',
    { type: 'number', enum: [1] },
    { exclusiveMinimum: 1 },
    /reference constraints admit no literal value/,
  ],
  [
    'pattern enum',
    { type: 'string', enum: ['ab'] },
    { pattern: '^x' },
    /reference constraints admit no literal value/,
  ],
  [
    'multiple enum',
    { type: 'integer', enum: [3] },
    { multipleOf: 2 },
    /reference constraints admit no literal value/,
  ],
  [
    'integer bounds',
    { type: 'integer', minimum: 0.5 },
    { maximum: 0.9 },
    /integer bounds admit no finite integer/,
  ],
  [
    'string bounds',
    { type: 'string', minLength: 3 },
    { maxLength: 2 },
    /minLength exceeds maxLength/,
  ],
  [
    'array bounds',
    { type: 'array', items: { type: 'string' }, minItems: 2 },
    { maxItems: 1 },
    /minItems exceeds maxItems/,
  ],
];
for (const [name, base, restriction, message] of invalidReferences) {
  void test(`contradictory ${name} across reference chains diagnoses`, async () => {
    const document = fixture();
    const alias = { $ref: '#/components/schemas/RuleBase', ...restriction };
    Object.assign(document.components.schemas, {
      RuleBase: base,
      RuleAlias: alias,
    });
    await assert.rejects(compile(document, selection), message);
    Object.assign(document.components.schemas, {
      RuleMiddle: alias,
      RuleAlias: { $ref: '#/components/schemas/RuleMiddle' },
    });
    await assert.rejects(compile(document, selection), message);
  });
}

void test('valid neighboring literals and boundary intervals remain accepted', async () => {
  const document = fixture();
  const valid = [
    { type: 'string', const: '😀', minLength: 1, maxLength: 1, pattern: '^.$' },
    {
      type: 'string',
      enum: [
        '00000000-0000-0000-0000-000000000000',
        'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
      ],
      format: 'uuid',
    },
    { type: 'string', const: '2000-02-29', format: 'date' },
    { type: 'string', const: '2026-10-25t12:00:00z', format: 'date-time' },
    { type: 'number', enum: [0.3, -0.3, 0, 1e21], multipleOf: 0.1 },
    { type: 'number', const: Number.MIN_VALUE, multipleOf: Number.MIN_VALUE },
    { type: 'integer', minimum: 0.5, maximum: 1 },
    { type: 'integer', exclusiveMinimum: -1, exclusiveMaximum: 1 },
    { type: 'integer', exclusiveMinimum: 2 ** 54, maximum: 2 ** 54 + 4 },
    { type: 'integer', minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE },
    { type: 'number', minimum: 1, exclusiveMaximum: 1 + Number.EPSILON },
    { type: 'number', exclusiveMinimum: 1, maximum: 1 + Number.EPSILON },
    {
      type: 'number',
      exclusiveMinimum: -Number.MIN_VALUE,
      exclusiveMaximum: Number.MIN_VALUE,
    },
    { type: ['string', 'null'], enum: [null], pattern: '^x', format: 'uuid' },
  ];
  for (const [index, schema] of valid.entries())
    Object.assign(document.components.schemas, { [`Valid${index}`]: schema });
  Object.assign(document.components.schemas, {
    ValidBase: { type: 'integer', minimum: 0.5, enum: [1, 2] },
    ValidAlias: { $ref: '#/components/schemas/ValidBase', multipleOf: 1 },
    ValidOuter: { $ref: '#/components/schemas/ValidAlias', maximum: 2 },
  });
  await compile(document, selection);
});

void test('reference restrictions preserve narrowing and diagnose empty intersections across aliases', async () => {
  const document = fixture();
  const outer: Schema = {
    $ref: '#/components/schemas/ChoiceMiddle',
    pattern: 'b$',
  };
  Object.assign(document.components.schemas, {
    ChoiceBase: { type: 'string', enum: ['aaa', 'abb', 'bbb'] },
    ChoiceMiddle: { $ref: '#/components/schemas/ChoiceBase', pattern: '^a' },
    ChoiceOuter: outer,
  });
  await compile(document, selection);
  outer.pattern = '^b';
  await assert.rejects(
    compile(document, selection),
    /reference constraints admit no literal value/,
  );
});

void test('contradiction diagnostics preserve inputs and existing outputs in both modes', async (t) => {
  const root = await temporary(t);
  const config = join(root, 'pom.json');
  const input = join(root, 'openapi.json');
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      ...selection,
    }),
  );
  await writeFile(input, JSON.stringify(fixture()));
  await runProject(config);
  const before = await fileSnapshot(join(root, 'generated'));
  for (const [, schema, message] of invalidSchemas) {
    const document = fixture();
    Object.assign(document.components.schemas, { Invalid: schema });
    await writeFile(input, JSON.stringify(document));
    const inputs = await fileSnapshot(root);
    for (const check of [false, true]) {
      await assert.rejects(runProject(config, { check }), message);
      assert.deepEqual(await fileSnapshot(root), inputs);
      assert.deepEqual(await fileSnapshot(join(root, 'generated')), before);
    }
  }
});
