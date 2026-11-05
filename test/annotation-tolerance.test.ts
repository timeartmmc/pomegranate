import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';
import { schemaFixture } from './schema-fixture.ts';

const selection = {
  clients: [],
  standalone: {
    input: { schema: '#/components/schemas/Value', usage: 'request' },
    output: { schema: '#/components/schemas/Value', usage: 'response' },
  },
} as const;
function document(schema: Schema, version = '3.1.2') {
  return {
    openapi: version,
    info: { title: 'Synthetic annotation tolerance', version: '1' },
    paths: {},
    components: { schemas: { Value: schema, Base: { type: 'string' } } },
  };
}

void test('undeclared formats diagnose across schema kinds, nullable types, dialects and reference siblings', async () => {
  const schemas: Schema[] = [
    {},
    { type: 'string', minLength: 1, enum: ['ready@example.invalid'] },
    { type: 'integer', minimum: 0 },
    { type: 'number', maximum: 10 },
    { type: 'boolean' },
    {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    { type: 'array', items: { type: 'integer' } },
    { type: 'object', additionalProperties: { type: 'string' } },
  ];
  for (const version of ['3.0.4', '3.1.2'])
    for (const schema of schemas) {
      await compile(document(schema, version), selection);
      for (const format of ['unregistered', 'vendor-specific', '']) {
        const input = document({ ...schema, format }, version);
        const before = structuredClone(input);
        await assert.rejects(
          compile(input, selection),
          (error) =>
            error instanceof ContractError &&
            error.location === 'components.schemas.Value.format',
        );
        assert.deepEqual(input, before);
      }
    }
  for (const schema of [
    { $ref: '#/components/schemas/Base' },
    { type: ['string', 'null'], enum: ['ready', null] },
  ])
    await assert.rejects(
      compile(document({ ...schema, format: 'unknown' }), selection),
      (error) =>
        error instanceof ContractError &&
        error.location === 'components.schemas.Value.format',
    );
});

void test('supported formats preserve constraints and enums at runtime', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(
      document({
        type: 'string',
        format: 'email',
        enum: ['ready@example.invalid'],
        minLength: 3,
      }),
      selection,
    ),
  );
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.output.ts',
  );
  assert.equal(schema.parse('ready@example.invalid'), 'ready@example.invalid');
  for (const input of [null, 0, 'other', 'r'])
    assert.equal(schema.safeParse(input).success, false);
  await assert.rejects(
    compile(
      document({ type: 'string', format: 'email', enum: ['x'], minLength: 3 }),
      selection,
    ),
    /literal violates declared bounds/,
  );
  await assert.rejects(
    compile(
      document({ type: 'string', format: 'email', enum: ['invalid'] }),
      selection,
    ),
    /literal violates declared email format/,
  );
});

void test('malformed formats still diagnose even in unused declarations', async () => {
  for (const format of [null, 1, false, {}, [], undefined]) {
    const input = document({ type: 'string' });
    Object.assign(input.components.schemas, {
      Unused: { type: 'string', format },
    });
    await assert.rejects(
      compile(input, selection),
      (error) =>
        error instanceof ContractError &&
        error.location === 'components.schemas.Unused.format',
    );
  }
});

void test('response defaults are inert through aliases, maps, arrays and discriminated branches', async () => {
  const input = schemaFixture();
  const expected = await compile(input, { clients: ['samples'] });
  Object.assign(input.components.schemas.Circle, {
    default: { kind: 'circle', radius: 1 },
  });
  Object.assign(input.components.schemas.Circle.properties.radius, {
    default: 'documentation',
  });
  Object.assign(input.components.schemas.Shape.oneOf[0]!, {
    default: { kind: 'circle' },
  });
  Object.assign(input.components.schemas.ShapeMap.additionalProperties, {
    default: null,
  });
  Object.assign(input.components.schemas.Location.items.anyOf[0]!, {
    default: 'documentation',
  });
  const before = structuredClone(input);
  assert.deepEqual(await compile(input, { clients: ['samples'] }), expected);
  assert.deepEqual(input, before);
});

void test('response defaults do not synthesize missing values, rescue required fields or coerce invalid values', async (t) => {
  for (const version of ['3.0.4', '3.1.2']) {
    const input = document(
      {
        type: 'object',
        properties: {
          required: { type: 'integer', default: 1 },
          optional: { type: 'string', default: 'example' },
        },
        required: ['required'],
        default: { required: 1 },
      },
      version,
    );
    const root = await generatedTestWorkspace(
      t,
      await compile(input, selection),
    );
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      'standalone.output.ts',
    );
    assert.deepEqual(schema.parse({ required: 2 }), { required: 2 });
    assert.equal(schema.safeParse({}).success, false);
    assert.equal(schema.safeParse({ required: '2' }).success, false);
    assert.equal(schema.safeParse(undefined).success, false);
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const value of [undefined, 1n, Infinity, cyclic])
    await assert.rejects(
      compile(document({ type: 'string', default: value }), selection),
      (error) =>
        error instanceof ContractError &&
        error.location === 'components.schemas.Value.default',
    );
});

void test('undeclared format names never yield apparently validated values', async (t) => {
  for (const format of ['uuid-v7', 'uudi'])
    await assert.rejects(
      compile(document({ type: 'string', format, minLength: 2 }), selection),
      /format.*unsupported format/,
    );
  const root = await generatedTestWorkspace(
    t,
    await compile(document({ type: 'string', format: 'uuid' }), selection),
  );
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.output.ts',
  );
  assert.equal(schema.safeParse('not-a-uuid').success, false);
});
