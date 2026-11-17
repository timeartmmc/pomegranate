import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { stringify } from 'yaml';
import { compile } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

function contract(schemas: Record<string, Schema>, openapi = '3.1.2') {
  return {
    openapi,
    info: {
      title: 'Synthetic container and nullable intersections',
      version: '1',
    },
    paths: {},
    components: { schemas },
  };
}
const selection = (names: string[]) => ({
  clients: [],
  standalone: Object.fromEntries(
    names.flatMap((name) =>
      (['request', 'response'] as const).map((usage) => [
        `${name.toLowerCase()}-${usage}`,
        { schema: ref(name).$ref, usage },
      ]),
    ),
  ),
});

const schemas = (openapi: string): Record<string, Schema> => {
  const nullable = (type: string, rules: Schema = {}): Schema => ({
    ...(openapi.startsWith('3.0.')
      ? { type, nullable: true }
      : { type: [type, 'null'] }),
    ...rules,
  });
  return {
    Values: {
      type: 'array',
      items: { type: 'number', minimum: 0 },
      uniqueItems: true,
    },
    Alias: { allOf: [ref('Values')], minItems: 1 },
    Array: {
      allOf: [
        ref('Alias'),
        {
          type: 'array',
          items: { type: 'integer', multipleOf: 2 },
          maxItems: 2,
        },
      ],
    },
    Map: {
      allOf: [
        {
          type: 'object',
          additionalProperties: { type: 'number', minimum: 0 },
          required: ['id'],
        },
        {
          type: 'object',
          additionalProperties: { type: 'integer', maximum: 4 },
          required: ['other'],
        },
        { minProperties: 2, maxProperties: 3 },
      ],
    },
    Nullable: {
      allOf: [
        nullable('string', { minLength: 1 }),
        nullable('string', { maxLength: 2 }),
      ],
    },
    NullOnly: { allOf: [nullable('string'), nullable('integer')] },
    Narrowed: { allOf: [nullable('string'), { type: 'string', minLength: 1 }] },
    NullableArray: {
      allOf: [
        nullable('array', { items: { type: 'number' } }),
        nullable('array', { items: { type: 'integer' }, maxItems: 2 }),
      ],
    },
    NullableMap: {
      allOf: [
        nullable('object', { additionalProperties: { type: 'number' } }),
        nullable('object', {
          additionalProperties: { type: 'integer' },
          maxProperties: 2,
        }),
      ],
    },
    Choice: {
      allOf: [
        { oneOf: [{ type: 'number' }, { type: 'integer' }] },
        nullable('number', { minimum: 0 }),
      ],
    },
    TypedChoice: {
      type: 'string',
      minLength: 1,
      anyOf: [{ type: 'string', maxLength: 2 }, { type: 'integer' }],
    },
    TypedArray: {
      type: 'array',
      oneOf: [
        { type: 'array', items: { type: 'string' } },
        { type: 'boolean' },
      ],
    },
  };
};

void test('nullable/container conjunctions agree with an independent oracle in both dialects', async (t) => {
  const definitions = schemas('3.1.2');
  const names = Object.keys(definitions).filter(
    (name) => !['Values', 'Alias'].includes(name),
  );
  const oracle = new Ajv2020({ strict: false });
  const checks = new Map(
    names.map((name) => [
      name,
      oracle.compile({
        ...definitions[name],
        components: { schemas: definitions },
      }),
    ]),
  );
  const samples: unknown[] = [
    null,
    false,
    true,
    -1,
    0,
    1,
    1.5,
    '',
    'a',
    'ab',
    'abc',
    [],
    [0],
    [2],
    [1.5],
    [0, 2],
    [2, 2],
    [0, 2, 4],
    ['a'],
    {},
    { id: 0 },
    { id: 0, other: 2 },
    { id: 0, other: 4, extra: 1 },
    { id: 0, other: 2, a: 1, b: 2 },
    { id: 0, other: 5 },
    { id: 0, other: 1.5 },
    { id: 'a', other: 2 },
  ];
  for (const openapi of ['3.0.4', '3.1.2']) {
    const source = contract(schemas(openapi), openapi);
    const before = structuredClone(source);
    const files = await compile(source, selection(names));
    assert.deepEqual(await compile(source, selection(names)), files);
    assert.deepEqual(
      await compile(
        parseYaml(stringify(source), 'containers.yaml'),
        selection(names),
      ),
      files,
    );
    assert.deepEqual(source, before);
    const root = await generatedTestWorkspace(t, files);
    for (const name of names)
      for (const usage of ['request', 'response']) {
        const { schema } = await importGenerated<StandaloneModule>(
          root,
          `standalone.${name.toLowerCase()}-${usage}.ts`,
        );
        for (const input of samples)
          assert.equal(
            schema.safeParse(input).success,
            checks.get(name)!(input),
            `${openapi} ${name} ${usage}: ${JSON.stringify(input)}`,
          );
      }
  }
});

void test('composed array/map objects project once and retain independent mutable outputs', async (t) => {
  const object = (
    properties: Record<string, Schema>,
    required: string[],
  ): Schema => ({ type: 'object', properties, required });
  const first = object(
    { id: { type: 'integer' }, server: { type: 'string', readOnly: true } },
    ['id', 'server'],
  );
  const second = object(
    { name: { type: 'string' }, secret: { type: 'string', writeOnly: true } },
    ['name', 'secret'],
  );
  const root = await generatedTestWorkspace(
    t,
    await compile(
      contract({
        Value: object(
          {
            list: {
              allOf: [
                { type: 'array', items: first },
                { type: 'array', items: second },
              ],
            },
            map: {
              allOf: [
                { type: 'object', additionalProperties: first },
                {
                  type: 'object',
                  additionalProperties: second,
                  required: ['a'],
                },
              ],
            },
          },
          ['list', 'map'],
        ),
      }),
      selection(['Value']),
    ),
  );
  const child = { id: 1, name: 'one', secret: 'input' };
  const source = { list: [child, child], map: { a: child, b: child } };
  const request = (
    await importGenerated<StandaloneModule>(root, 'standalone.value-request.ts')
  ).schema;
  const response = (
    await importGenerated<StandaloneModule>(
      root,
      'standalone.value-response.ts',
    )
  ).schema;
  const parsed = record(request.parse(source));
  assert.deepEqual(parsed, source);
  const list = parsed.list;
  assert.ok(Array.isArray(list));
  const map = record(parsed.map);
  for (const value of [list[0], list[1], map.a, map.b])
    assert.notEqual(value, child);
  assert.equal(new Set([list[0], list[1], map.a, map.b]).size, 4);
  record(list[0]).name = 'changed';
  assert.equal(record(map.a).name, 'one');
  assert.equal(
    request.safeParse({ ...source, list: [{ ...child, server: 'forbidden' }] })
      .success,
    false,
  );
  const observed = { ...child, server: 'output', ignored: true };
  assert.deepEqual(response.parse({ list: [observed], map: { a: observed } }), {
    list: [{ id: 1, name: 'one', server: 'output' }],
    map: { a: { id: 1, name: 'one', server: 'output' } },
  });
});

void test('type pruning preserves source diagnostics and explicit limits on impossible children', async () => {
  for (const [Value, message] of [
    [
      {
        type: 'string',
        anyOf: [{ type: 'string' }, { type: 'integer', minimum: 'bad' }],
      },
      /minimum.*finite number/,
    ],
    [
      { type: 'string', anyOf: [{ type: 'string' }, ref('Missing')] },
      /unresolved reference Missing/,
    ],
    [
      {
        type: 'string',
        anyOf: [
          { type: 'string' },
          { anyOf: [{ type: 'integer', readOnly: true }, { type: 'boolean' }] },
        ],
      },
      /readOnly and writeOnly on union branches/,
    ],
    [
      {
        allOf: [
          { type: 'array', items: { type: 'string' } },
          { type: 'array', items: { type: 'integer' } },
        ],
      },
      /incompatible scalar types/,
    ],
    [
      {
        allOf: [
          { type: 'object', additionalProperties: { type: 'string' } },
          { type: 'object', additionalProperties: { type: 'integer' } },
        ],
      },
      /incompatible scalar types/,
    ],
    [
      {
        allOf: [
          { type: 'array', items: {}, minItems: 2 },
          { type: 'array', items: {}, maxItems: 1 },
        ],
      },
      /minItems exceeds maxItems/,
    ],
  ] satisfies [Schema, RegExp][])
    await assert.rejects(
      compile(contract({ Value }), selection(['Value'])),
      message,
    );
});

void test('nullable recursive properties compose without expanding their active ancestor', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(
      contract({
        Value: {
          allOf: [
            {
              type: 'object',
              properties: { next: { anyOf: [ref('Value'), { type: 'null' }] } },
            },
            {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            },
          ],
        },
      }),
      selection(['Value']),
    ),
  );
  for (const usage of ['request', 'response']) {
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      `standalone.value-${usage}.ts`,
    );
    const value = { id: 'a', next: { id: 'b', next: null } };
    const parsed = record(schema.parse(value));
    assert.deepEqual(parsed, value);
    assert.notEqual(parsed.next, value.next);
    assert.equal(
      schema.safeParse({ id: 'a', next: { next: null } }).success,
      false,
    );
    const cycle: { id: string; next?: unknown } = { id: 'cycle' };
    cycle.next = cycle;
    assert.equal(schema.safeParse(cycle).success, false);
  }
});
