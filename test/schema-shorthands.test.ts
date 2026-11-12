import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

const selection = {
  clients: [],
  standalone: {
    input: { schema: ref('Value').$ref, usage: 'request' },
    output: { schema: ref('Value').$ref, usage: 'response' },
  },
} as const;
const tagged = (tag: string): Schema => ({
  type: 'object',
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: [tag] },
    value: { type: 'integer' },
  },
});
function document(value: Schema, version = '3.1.2') {
  return {
    openapi: version,
    info: { title: 'Synthetic schema shorthands', version: '1' },
    paths: {},
    components: {
      schemas: { Value: value, Cat: tagged('Cat'), Dog: tagged('Dog') },
    },
  };
}

void test('properties without type preserve conditional object semantics in both dialects', async (t) => {
  const value: Schema = {
    additionalProperties: {},
    properties: {
      id: { type: 'integer' },
      nested: {
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: true,
      },
      server: { type: 'string', readOnly: true },
    },
    required: ['id'],
  };
  const expected = await compile(document(value), selection);
  const oracle = new Ajv2020({ strict: false }).compile(value);
  for (const version of ['3.0.4', '3.1.2']) {
    const source = document(value, version);
    const before = structuredClone(source);
    const files = await compile(source, selection);
    assert.deepEqual(files, expected);
    assert.deepEqual(
      await compile(parseYaml(stringify(source), 'shorthands.yaml'), selection),
      expected,
    );
    assert.deepEqual(source, before);
    const root = await generatedTestWorkspace(t, files);
    const input = (
      await importGenerated<StandaloneModule>(root, 'standalone.input.ts')
    ).schema;
    const output = (
      await importGenerated<StandaloneModule>(root, 'standalone.output.ts')
    ).schema;
    assert.deepEqual(input.parse({ id: 1, nested: { name: 'demo' } }), {
      id: 1,
      nested: { name: 'demo' },
    });
    for (const invalid of [
      {},
      { id: '1' },
      { id: 1, nested: {} },
      { id: 1, server: 'hidden' },
    ])
      assert.equal(input.safeParse(invalid).success, false);
    for (const sample of [
      null,
      true,
      7,
      'demo',
      [],
      [{ arbitrary: true }],
      { id: 1 },
      { id: '1' },
      { id: 1, nested: null },
      { id: 1, nested: 4 },
      { id: 1, nested: {} },
    ]) {
      assert.equal(input.safeParse(sample).success, oracle(sample));
      assert.equal(output.safeParse(sample).success, oracle(sample));
    }
    assert.deepEqual(output.parse({ id: 1, server: 'visible', extra: true }), {
      id: 1,
      server: 'visible',
    });
  }
  await assert.rejects(
    compile(document({ properties: {}, nullable: true }, '3.0.4'), selection),
    /nullable.*explicit type/,
  );
  await assert.rejects(
    compile(
      document({
        properties: { id: { type: 'integer' } },
        additionalProperties: { type: 'string' },
      }),
      selection,
    ),
    /mixed fixed properties/,
  );
});

void test('untyped object assertions do not hide oneOf overlap with non-object branches', async () => {
  for (const branch of [
    { type: 'null' },
    { type: 'number' },
    { type: 'array', items: {} },
  ])
    await assert.rejects(
      compile(
        document({
          oneOf: [{ properties: { name: { type: 'string' } } }, branch],
        }),
        selection,
      ),
      /oneOf alternatives.*disjoint JSON types/,
    );
});

void test('single-branch unions retain their branch constraints in requests and responses', async (t) => {
  for (const version of ['3.0.4', '3.1.2'])
    for (const keyword of ['anyOf', 'oneOf']) {
      const root = await generatedTestWorkspace(
        t,
        await compile(
          document(
            {
              type: 'object',
              [keyword]: [
                {
                  type: 'object',
                  properties: { count: { type: 'integer', minimum: 2 } },
                  required: ['count'],
                },
              ],
            },
            version,
          ),
          selection,
        ),
      );
      for (const usage of ['input', 'output']) {
        const { schema } = await importGenerated<StandaloneModule>(
          root,
          `standalone.${usage}.ts`,
        );
        assert.deepEqual(schema.parse({ count: 2 }), { count: 2 });
        for (const invalid of [{ count: 1 }, { count: 2.5 }, {}, null])
          assert.equal(schema.safeParse(invalid).success, false);
      }
      await assert.rejects(
        compile(document({ [keyword]: [] }, version), selection),
        /nonempty array/,
      );
    }
});

void test('redundant object types preserve union validation through references and composition', async (t) => {
  for (const version of ['3.0.4', '3.1.2'])
    for (const keyword of ['anyOf', 'oneOf']) {
      const value: Schema = {
        type: 'object',
        [keyword]: [ref('Cat'), ref('Dog')],
        ...(keyword === 'oneOf'
          ? { discriminator: { propertyName: 'kind' } }
          : {}),
      };
      const source = document(value, version);
      Object.assign(source.components.schemas, {
        Cat: {
          allOf: [
            tagged('Cat'),
            { properties: { value: { type: 'integer', minimum: 1 } } },
          ],
        },
        Dog: {
          allOf: [tagged('Dog'), { properties: { next: ref('Alias') } }],
        },
        Alias: { allOf: [ref('Value')] },
      });
      const before = structuredClone(source);
      const files = await compile(source, selection);
      const { type: _type, ...withoutType } = value;
      assert.deepEqual(
        await compile(
          {
            ...source,
            components: {
              schemas: { ...source.components.schemas, Value: withoutType },
            },
          },
          selection,
        ),
        files,
      );
      assert.deepEqual(
        await compile(
          parseYaml(stringify(source), 'typed-unions.yaml'),
          selection,
        ),
        files,
      );
      assert.deepEqual(source, before);
      const root = await generatedTestWorkspace(t, files);
      const input = (
        await importGenerated<StandaloneModule>(root, 'standalone.input.ts')
      ).schema;
      const output = (
        await importGenerated<StandaloneModule>(root, 'standalone.output.ts')
      ).schema;
      const valid = { kind: 'Dog', next: { kind: 'Cat', value: 1 } };
      assert.deepEqual(input.parse(valid), valid);
      assert.deepEqual(
        output.parse({
          ...valid,
          extra: true,
          next: { ...valid.next, extra: true },
        }),
        valid,
      );
      assert.equal(input.safeParse({ ...valid, extra: true }).success, false);
      for (const invalid of [
        null,
        [],
        'Cat',
        {},
        { kind: 'cat' },
        { kind: 'Cat', value: 0 },
        { kind: 'Cat', value: '1' },
        { kind: 'Dog', next: { kind: 'Cat', value: 0 } },
      ]) {
        assert.equal(input.safeParse(invalid).success, false);
        assert.equal(output.safeParse(invalid).success, false);
      }
    }
});

void test('redundant object types accept nested unions and maps without changing their values', async (t) => {
  const source = document({
    type: 'object',
    anyOf: [
      {
        anyOf: [{ type: 'object', additionalProperties: { type: 'integer' } }],
      },
    ],
  });
  const root = await generatedTestWorkspace(
    t,
    await compile(source, selection),
  );
  for (const usage of ['input', 'output']) {
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      `standalone.${usage}.ts`,
    );
    assert.deepEqual(schema.parse({ count: 1 }), { count: 1 });
    assert.equal(schema.safeParse({ count: '1' }).success, false);
    assert.equal(schema.safeParse(null).success, false);
  }
});

void test('non-redundant object types fail before selection and allOf distribution', async () => {
  for (const version of ['3.0.4', '3.1.2'])
    for (const keyword of ['anyOf', 'oneOf'])
      for (const branch of [
        {},
        { type: 'string' },
        { type: 'number' },
        { type: 'boolean' },
        { type: 'array', items: {} },
        { properties: { id: { type: 'string' } } },
        version === '3.0.4'
          ? { type: 'object', nullable: true }
          : { type: ['object', 'null'] },
      ]) {
        const value = { type: 'object', [keyword]: [ref('Cat'), ref('Other')] };
        for (const wrapped of [value, { allOf: [value, { type: 'object' }] }]) {
          const source = document({ type: 'string' }, version);
          Object.assign(source.components.schemas, {
            Unused: wrapped,
            Other: branch,
          });
          const before = structuredClone(source);
          await assert.rejects(compile(source, selection), (error) => {
            assert.ok(error instanceof ContractError);
            assert.match(
              error.location,
              /^components\.schemas\.Unused.*\.type$/,
            );
            assert.match(
              error.message,
              /non-redundant type: object.*every branch must already require an object/,
            );
            return true;
          });
          assert.deepEqual(source, before);
        }
      }
});

void test('redundant object types retain overlap, discriminator and sibling-keyword diagnostics', async () => {
  for (const version of ['3.0.4', '3.1.2']) {
    const base = { type: 'object', oneOf: [ref('Cat'), ref('Dog')] };
    const cases: readonly [Schema, RegExp][] = [
      [base, /oneOf alternatives.*disjoint JSON types/],
      [{ ...base, discriminator: { propertyName: 'value' } }, /discriminator/],
      [{ ...base, minLength: 1 }, /minLength.*unsupported keyword/],
      [
        { type: 'number', anyOf: [{ type: 'integer' }] },
        /type.*only redundant type: object/,
      ],
      [
        { type: 'object', anyOf: [{ ...tagged('Cat'), readOnly: true }] },
        /readOnly and writeOnly on union branches/,
      ],
    ];
    for (const [value, expected] of cases)
      await assert.rejects(
        compile(document(value, version), selection),
        expected,
      );
  }
});

void test('implicit discriminator mappings use component names and fill unmapped branches', async (t) => {
  for (const version of ['3.0.4', '3.1.2'])
    for (const mapping of [undefined, {}, { Dog: ref('Dog').$ref }]) {
      const value: Schema = {
        oneOf: [ref('Cat'), ref('Dog')],
        discriminator: {
          propertyName: 'kind',
          ...(mapping === undefined ? {} : { mapping }),
        },
      };
      const root = await generatedTestWorkspace(
        t,
        await compile(document(value, version), selection),
      );
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        'standalone.input.ts',
      );
      for (const kind of ['Cat', 'Dog'])
        assert.deepEqual(schema.parse({ kind, value: 2 }), { kind, value: 2 });
      for (const invalid of [
        { kind: 'cat' },
        { kind: 'Dog', value: '2' },
        {},
        null,
      ])
        assert.equal(schema.safeParse(invalid).success, false);
    }
  const single = document({
    oneOf: [ref('Cat')],
    discriminator: { propertyName: 'kind' },
  });
  const root = await generatedTestWorkspace(
    t,
    await compile(single, selection),
  );
  assert.deepEqual(
    (
      await importGenerated<StandaloneModule>(root, 'standalone.input.ts')
    ).schema.parse({ kind: 'Cat' }),
    { kind: 'Cat' },
  );
});

void test('implicit mappings preserve distinct-branch, tag and explicit-mapping checks', async () => {
  for (const value of [
    {
      oneOf: [ref('Cat'), ref('Cat')],
      discriminator: { propertyName: 'kind' },
    },
    { oneOf: [tagged('Cat')], discriminator: { propertyName: 'kind' } },
    {
      oneOf: [ref('Cat'), ref('Dog')],
      discriminator: {
        propertyName: 'kind',
        mapping: { Cat: ref('Dog').$ref },
      },
    },
    { oneOf: [ref('Cat')], discriminator: { propertyName: 'value' } },
  ])
    await assert.rejects(compile(document(value), selection), ContractError);
});
