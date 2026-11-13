import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
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

void test('XML schema metadata preserves JSON names and constraints in both dialects', async (t) => {
  const plain = {
    type: 'object',
    properties: {
      id: { type: 'integer', minimum: 1 },
      labels: {
        type: 'array',
        minItems: 1,
        items: { type: 'string', minLength: 2 },
      },
    },
    required: ['id', 'labels'],
  };
  for (const version of ['3.0.4', '3.1.2']) {
    const annotated = structuredClone(plain);
    Object.assign(annotated, {
      xml: { name: 'entry', namespace: 'urn:synthetic:xml', prefix: 's' },
    });
    Object.assign(annotated.properties.id, {
      xml: { name: 'external-id', attribute: true },
    });
    Object.assign(annotated.properties.labels, {
      xml: { name: 'names', wrapped: true },
    });
    Object.assign(annotated.properties.labels.items, {
      xml: { name: 'label', attribute: false },
    });
    const source = document(annotated, version);
    const before = structuredClone(source);
    const files = await compile(source, selection);
    assert.deepEqual(files, await compile(document(plain, version), selection));
    assert.deepEqual(
      await compile(parseYaml(stringify(source), 'xml.yaml'), selection),
      files,
    );
    assert.deepEqual(source, before);
    assert.deepEqual(
      await compile(document({ xml: {} }, version), selection),
      await compile(document({}, version), selection),
    );
    const root = await generatedTestWorkspace(t, files);
    for (const usage of ['input', 'output']) {
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        `standalone.${usage}.ts`,
      );
      assert.deepEqual(schema.parse({ id: 1, labels: ['ok'] }), {
        id: 1,
        labels: ['ok'],
      });
      for (const input of [
        { id: 0, labels: ['ok'] },
        { id: 1, labels: [] },
        { id: 1, labels: ['x'] },
        { 'external-id': 1, names: ['ok'] },
      ])
        assert.equal(schema.safeParse(input).success, false);
    }
  }
});

void test('malformed XML metadata diagnoses schema fields and 3.1 reference siblings', async () => {
  for (const version of ['3.0.4', '3.1.2'])
    for (const schema of [
      { type: 'string' },
      ...(version === '3.1.2' ? [{ $ref: '#/components/schemas/Base' }] : []),
    ])
      for (const [xml, suffix] of [
        [undefined, ''],
        [null, ''],
        [[], ''],
        ['entry', ''],
        [{ name: 1 }, '.name'],
        [{ namespace: false }, '.namespace'],
        [{ prefix: [] }, '.prefix'],
        [{ attribute: 'true' }, '.attribute'],
        [{ wrapped: 0 }, '.wrapped'],
        [{ unknown: true }, '.unknown'],
      ] as const)
        await assert.rejects(
          compile(document({ ...schema, xml }, version), selection),
          (error) =>
            error instanceof ContractError &&
            error.location === `components.schemas.Value.xml${suffix}`,
        );
});

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
