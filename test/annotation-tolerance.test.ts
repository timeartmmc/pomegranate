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
function document(schema: Schema) {
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic annotation tolerance', version: '1' },
    paths: {},
    components: { schemas: { Value: schema, Base: { type: 'string' } } },
  };
}

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
  const input = document({
    type: 'object',
    properties: {
      required: { type: 'integer', default: 1 },
      optional: { type: 'string', default: 'example' },
    },
    required: ['required'],
    default: { required: 1 },
  });
  const root = await generatedTestWorkspace(t, await compile(input, selection));
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.output.ts',
  );
  assert.deepEqual(schema.parse({ required: 2 }), { required: 2 });
  assert.equal(schema.safeParse({}).success, false);
  assert.equal(schema.safeParse({ required: '2' }).success, false);
  assert.equal(schema.safeParse(undefined).success, false);
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
