import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { compile } from '../dist/index.js';
import { record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

const object = (
  properties: Record<string, Schema>,
  required = Object.keys(properties),
  extra: Schema = {},
): Schema => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  ...extra,
});
const basic = object({ a: { type: 'string' } });
const full = object({ a: { type: 'string' }, b: { type: 'string' } });

async function generated(
  t: TestContext,
  Value: Schema,
  schemas: Record<string, Schema> = {},
  openapi = '3.1.2',
) {
  const root = await generatedTestWorkspace(
    t,
    await compile(
      {
        openapi,
        info: { title: 'Synthetic source oneOf membership', version: '1' },
        paths: {},
        components: { schemas: { Value, ...schemas } },
      },
      {
        clients: [],
        standalone: {
          request: { schema: ref('Value').$ref, usage: 'request' },
          response: { schema: ref('Value').$ref, usage: 'response' },
        },
      },
    ),
  );
  return {
    request: (
      await importGenerated<StandaloneModule>(root, 'standalone.request.ts')
    ).schema,
    response: (
      await importGenerated<StandaloneModule>(root, 'standalone.response.ts')
    ).schema,
  };
}

void test('oneOf counts original source matches before directional field policies in both dialects', async (t) => {
  const samples = [
    { a: 'a' },
    { a: 'a', b: 'b' },
    { a: 'a', extra: 1 },
    {},
    null,
    1,
  ];
  for (const openapi of ['3.0.4', '3.1.2'])
    for (const closed of [false, true]) {
      const branches = [basic, full].map((branch) => ({
        ...branch,
        ...(closed ? { additionalProperties: false } : {}),
      }));
      const { request, response } = await generated(
        t,
        { oneOf: [ref('Basic'), ref('Full')] },
        {
          Basic: branches[0]!,
          Full: branches[1]!,
        },
        openapi,
      );
      const oracle = new Ajv2020({ strict: false }).compile({
        oneOf: branches,
      });
      for (const input of samples) {
        assert.equal(
          response.safeParse(input).success,
          oracle(input),
          `response ${openapi}, closed ${closed}: ${JSON.stringify(input)}`,
        );
        const result = request.safeParse(input);
        assert.equal(
          result.success,
          oracle(input) &&
            !(
              'extra' in
              (input !== null && typeof input === 'object' ? input : {})
            ),
        );
        if (result.success) assert.deepEqual(result.data, input);
      }
      const complete = { a: 'a', b: 'b' };
      assert.equal(request.safeParse(complete).success, closed);
      assert.equal(response.safeParse(complete).success, closed);
    }
});

void test('source closure also applies to disjoint and tagged oneOf without changing ordinary response tolerance', async (t) => {
  for (const Value of [
    { oneOf: [ref('Closed'), { type: 'boolean' }] },
    { oneOf: [ref('Closed')] },
    {
      oneOf: [ref('Closed')],
      discriminator: {
        propertyName: 'kind',
        mapping: { closed: ref('Closed').$ref },
      },
    },
  ]) {
    const { request, response } = await generated(t, Value, {
      Closed: object({ kind: { type: 'string', enum: ['closed'] } }, ['kind'], {
        additionalProperties: false,
      }),
    });
    assert.deepEqual(response.parse({ kind: 'closed' }), { kind: 'closed' });
    for (const schema of [request, response])
      assert.equal(
        schema.safeParse({ kind: 'closed', extra: 1 }).success,
        false,
      );
  }
  const ordinary = await generated(t, {
    ...basic,
    additionalProperties: false,
  });
  assert.deepEqual(ordinary.response.parse({ a: 'a', extra: 1 }), { a: 'a' });
});

void test('closed oneOf remembers excluded source names and checks request policy after membership', async (t) => {
  const Value: Schema = { oneOf: [ref('Closed'), { type: 'boolean' }] };
  const { request, response } = await generated(t, Value, {
    Closed: object(
      {
        value: { type: 'string' },
        id: { type: 'integer', readOnly: true },
        secret: { type: 'string', writeOnly: true },
      },
      ['value', 'id', 'secret'],
      { additionalProperties: false },
    ),
  });
  assert.deepEqual(request.parse({ value: 'v', secret: 's' }), {
    value: 'v',
    secret: 's',
  });
  assert.equal(request.safeParse({ value: 'v' }).success, false);
  assert.equal(
    request.safeParse({
      value: 'v',
      secret: 's',
      get id(): unknown {
        throw new Error('forbidden getter');
      },
    }).success,
    false,
  );
  assert.deepEqual(
    response.parse({
      value: 'v',
      id: 1,
      get secret(): unknown {
        throw new Error('excluded getter');
      },
    }),
    { value: 'v', id: 1 },
  );
  assert.equal(
    response.safeParse({ value: 'v', id: 1, unrelated: 1 }).success,
    false,
  );
});

void test('closed empty and projected-empty oneOf branches enforce source keys', async (t) => {
  for (const fields of [{}, { secret: { type: 'string', writeOnly: true } }]) {
    const { response } = await generated(t, {
      oneOf: [
        object(fields, [], { additionalProperties: false }),
        { type: 'boolean' },
      ],
    });
    assert.deepEqual(response.parse({}), {});
    assert.equal(response.safeParse({ unrelated: true }).success, false);
    if ('secret' in fields)
      assert.deepEqual(
        response.parse({
          get secret(): unknown {
            throw new Error('excluded');
          },
        }),
        {},
      );
  }
});

void test('source-aware nested anyOf selects a source-valid branch before stripping', async (t) => {
  const choices = {
    anyOf: [
      { ...basic, additionalProperties: false },
      { ...full, additionalProperties: false },
    ],
  };
  const { response } = await generated(t, {
    oneOf: [object({ payload: choices }), { type: 'number' }],
  });
  assert.deepEqual(response.parse({ payload: { a: 'a', b: 'b' } }), {
    payload: { a: 'a', b: 'b' },
  });
  const ordinary = await generated(t, object({ payload: choices }));
  assert.deepEqual(ordinary.response.parse({ payload: { a: 'a', b: 'b' } }), {
    payload: { a: 'a' },
  });
});

void test('recursive union caches keep source-aware and ordinary projections separate', async (t) => {
  const z = (tag: string) => object({ tag: { type: 'string', enum: [tag] } });
  const { response } = await generated(t, ref('Node'), {
    Basic: { ...basic, additionalProperties: false },
    Full: { ...full, additionalProperties: false },
    Choice: { anyOf: [ref('Basic'), ref('Full')] },
    Checked: { oneOf: [ref('Choice'), { type: 'boolean' }] },
    Node: {
      anyOf: [
        object({ child: ref('Checked'), z: z('a'), next: ref('Node') }, [
          'child',
          'z',
        ]),
        object({ child: ref('Choice'), z: z('b'), next: ref('Node') }, [
          'child',
          'z',
        ]),
      ],
    },
  });
  const child = { a: 'a', b: 'b' };
  const input = { child, z: { tag: 'b' }, next: { child, z: { tag: 'b' } } };
  const output = record(response.parse(input));
  assert.deepEqual(output, {
    child: { a: 'a' },
    z: { tag: 'b' },
    next: { child: { a: 'a' }, z: { tag: 'b' } },
  });
  assert.notEqual(output.child, child);
  assert.notEqual(output.child, record(output.next).child);
  assert.deepEqual(response.parse(input), output);
});

void test('membership counts and uniqueness use source data before output normalization', async (t) => {
  const counted = object(
    { a: { type: 'string' }, optional: { type: 'string' } },
    ['a'],
    { maxProperties: 1 },
  );
  const member = await generated(t, { oneOf: [counted, { type: 'number' }] });
  const ordinary = await generated(t, counted);
  const optionalUndefined = { a: 'a', optional: undefined };
  assert.equal(member.request.safeParse(optionalUndefined).success, false);
  assert.equal(ordinary.request.safeParse(optionalUndefined).success, true);
  const requiredCount = object({ a: { type: 'string' } }, ['a'], {
    minProperties: 1,
  });
  const inherited = Object.create({ a: 'a' }) as object;
  const countedMember = await generated(t, {
    oneOf: [requiredCount, { type: 'number' }],
  });
  const countedOrdinary = await generated(t, requiredCount);
  assert.equal(countedMember.request.safeParse(inherited).success, false);
  assert.deepEqual(countedOrdinary.request.parse(inherited), { a: 'a' });
  const unique = await generated(t, {
    oneOf: [
      { type: 'array', uniqueItems: true, items: basic },
      { type: 'number' },
    ],
  });
  assert.deepEqual(
    unique.response.parse([
      { a: 'a', extra: 1 },
      { a: 'a', extra: 2 },
    ]),
    [{ a: 'a' }, { a: 'a' }],
  );
  assert.equal(
    unique.response.safeParse([
      { a: 'a', extra: 1 },
      { a: 'a', extra: 1 },
    ]).success,
    false,
  );
});
