import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import { compile, ContractError } from '../dist/index.js';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

const point: Schema = {
  type: 'object',
  properties: {
    x: { type: 'integer' },
    y: { type: 'integer' },
    label: { type: 'string' },
  },
  required: ['x', 'y'],
};

function contract(openapi: string, schemas: Record<string, Schema>) {
  const content = { 'application/json': { schema: ref('Points') } };
  return {
    openapi,
    info: { title: 'Synthetic unique items', version: '1' },
    components: {
      schemas: {
        Point: point,
        Points: { type: 'array', items: ref('Point'), uniqueItems: true },
        Tags: { type: 'array', items: { type: 'string' } },
        ...schemas,
      },
    },
    paths: {
      '/points': {
        post: {
          operationId: 'save',
          parameters: [
            {
              name: 'ids',
              in: 'query',
              schema: {
                type: 'array',
                items: { type: 'integer' },
                uniqueItems: true,
              },
            },
          ],
          requestBody: { required: true, content },
          responses: { 200: { description: 'Saved points', content } },
        },
      },
    },
  };
}

async function generated(
  t: TestContext,
  openapi: string,
  schemas: Record<string, Schema>,
  roots: readonly string[],
) {
  const root = await generatedTestWorkspace(
    t,
    await compile(contract(openapi, schemas), {
      clients: ['consumer'],
      surfaces: { consumer: ['save'] },
      standalone: Object.fromEntries(
        roots.flatMap((name) =>
          (['request', 'response'] as const).map((usage) => [
            `${name.toLowerCase()}-${usage}`,
            { schema: ref(name).$ref, usage },
          ]),
        ),
      ),
    }),
  );
  const validators = Object.fromEntries(
    await Promise.all(
      roots.flatMap((name) =>
        (['request', 'response'] as const).map(
          async (usage) =>
            [
              `${name}:${usage}`,
              (
                await importGenerated<StandaloneModule>(
                  root,
                  `standalone.${name.toLowerCase()}-${usage}.ts`,
                )
              ).schema,
            ] as const,
        ),
      ),
    ),
  );
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  return { root, client, validator: (key: string) => present(validators[key]) };
}

function duplicate(
  result: ReturnType<StandaloneModule['schema']['safeParse']>,
  index: number,
  first: number,
): void {
  assert.equal(result.success, false);
  if (!result.success)
    assert.deepEqual(result.error.issues, [
      {
        path: [index],
        message: `expected unique items; duplicates item ${first}`,
      },
    ]);
}

void test('uniqueItems compares validated JSON values in requests, responses and standalone validators', async (t) => {
  const { client, validator } = await generated(
    t,
    '3.1.2',
    {
      Numbers: { type: 'array', items: { type: 'number' }, uniqueItems: true },
      Nested: {
        type: 'array',
        items: { type: 'array', items: { type: 'integer' } },
        uniqueItems: true,
      },
      Values: { type: 'array', items: {}, uniqueItems: true },
      Allowed: { type: 'array', items: { type: 'string' }, uniqueItems: false },
      Refined: { $ref: '#/components/schemas/Tags', uniqueItems: true },
    },
    ['Points', 'Numbers', 'Nested', 'Values', 'Allowed', 'Refined'],
  );
  const points = validator('Points:request');
  assert.deepEqual(
    points.parse([
      { x: 1, y: 2 },
      { x: 2, y: 1 },
    ]),
    [
      { x: 1, y: 2 },
      { x: 2, y: 1 },
    ],
  );
  // Member order is irrelevant, and an undefined optional field is not sent.
  duplicate(
    points.safeParse([
      { x: 1, y: 2, label: undefined },
      { y: 2, x: 1 },
    ]),
    1,
    0,
  );
  // Responses compare received items, including fields parsing strips.
  const received = validator('Points:response');
  assert.deepEqual(
    received.parse([
      { x: 1, y: 2, extra: 'a' },
      { x: 1, y: 2, extra: { nested: ['b'] } },
    ]),
    [
      { x: 1, y: 2 },
      { x: 1, y: 2 },
    ],
  );
  duplicate(
    received.safeParse([
      { x: 1, y: 2, extra: { a: 1, b: [2] } },
      { y: 2, x: 1, extra: { b: [2], a: 1 } },
    ]),
    1,
    0,
  );
  // Uncomparable received data cannot establish uniqueness.
  const cyclic: Record<string, unknown> = { x: 1, y: 2 };
  cyclic.self = cyclic;
  const callback = () => undefined;
  for (const items of [
    [cyclic, { ...cyclic }],
    [
      { x: 1, y: 2, callback },
      { x: 1, y: 2, callback },
    ],
  ]) {
    const failure = received.safeParse(items);
    assert.equal(failure.success, false);
    if (!failure.success)
      assert.deepEqual(failure.error.issues, [
        {
          path: [0],
          message: 'uniqueItems comparison requires acyclic JSON values',
        },
      ]);
  }
  const numbers = validator('Numbers:request');
  duplicate(numbers.safeParse([1, 2, 1.0]), 2, 0);
  duplicate(numbers.safeParse([0, -0]), 1, 0);
  assert.deepEqual(numbers.parse([1, 1.5, 2]), [1, 1.5, 2]);
  const nested = validator('Nested:response');
  assert.deepEqual(nested.parse([[1, 2], [2, 1], []]), [[1, 2], [2, 1], []]);
  duplicate(nested.safeParse([[], [1], []]), 2, 0);
  // Arbitrary JSON items can exceed the call stack; comparison stays iterative.
  const nest = () => {
    let value: unknown = 0;
    for (let level = 0; level < 20_000; level++) value = [value];
    return value;
  };
  const values = validator('Values:request');
  assert.equal(values.safeParse([nest(), 1]).success, true);
  duplicate(values.safeParse([nest(), nest()]), 1, 0);
  duplicate(
    values.safeParse([
      { a: [1], b: null },
      { b: null, a: [1] },
    ]),
    1,
    0,
  );
  assert.deepEqual(validator('Allowed:request').parse(['a', 'a']), ['a', 'a']);
  duplicate(validator('Refined:response').safeParse(['a', 'b', 'a']), 2, 0);

  const operation = present(client.operations.save);
  assert.throws(
    () =>
      operation.build({ query: { ids: [3, 4, 3] }, body: [{ x: 1, y: 1 }] }),
    (error) => {
      assert.ok(error instanceof client.RequestValidationError);
      assert.deepEqual(error.issues, [
        {
          path: ['query', 'ids', 2],
          message: 'expected unique items; duplicates item 0',
        },
      ]);
      return true;
    },
  );
  const prepared = operation.build({ body: [{ x: 1, y: 1 }] });
  const result = prepared.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      { x: 1, y: 1 },
      { x: 1, y: 1 },
    ]),
  });
  assert.equal(result.kind, 'protocol');
  if (result.kind === 'protocol')
    assert.deepEqual(result.issues, [
      {
        part: 'body',
        path: [1],
        message: 'expected unique items; duplicates item 0',
      },
    ]);
});

void test('response uniqueness compares shared children by value and bounds their expansion', async (t) => {
  const child = {
    type: 'object',
    properties: { id: { type: 'integer' } },
    required: ['id'],
  };
  const { validator } = await generated(
    t,
    '3.1.2',
    {
      Pairs: {
        type: 'array',
        uniqueItems: true,
        items: {
          type: 'object',
          properties: { a: child, b: child },
          required: ['a', 'b'],
        },
      },
    },
    ['Pairs', 'Points'],
  );
  const shared = { id: 1 };
  const items = [
    { a: shared, b: shared },
    { a: shared, b: shared },
  ];
  for (const usage of ['request', 'response'])
    duplicate(validator(`Pairs:${usage}`).safeParse(items), 1, 0);

  let extra: unknown = 0;
  for (let level = 0; level < 18; level++)
    extra = { left: extra, right: extra };
  const failure = validator('Points:response').safeParse([
    { x: 1, y: 2, extra },
    { x: 1, y: 2, extra },
  ]);
  assert.equal(failure.success, false);
  if (!failure.success)
    assert.deepEqual(failure.error.issues, [
      { path: [0], message: 'uniqueItems comparison exceeds 100000 values' },
    ]);
});

void test('response uniqueness reserves collection work before allocation and member reads', async (t) => {
  const { root, validator } = await generated(t, '3.1.2', {}, ['Points']);
  const response = validator('Points:response');
  let reads = 0;
  const members: Record<string, unknown> = {};
  for (let index = 0; index < 2000; index++)
    Object.defineProperty(members, `field${index}`, {
      enumerable: true,
      get: () => {
        reads++;
        return 0;
      },
    });
  const extra = { a: Array<number>(99_000).fill(0), b: members };
  const failure = response.safeParse([
    { x: 1, y: 2, extra },
    { x: 1, y: 2, extra },
  ]);
  assert.equal(failure.success, false);
  if (!failure.success)
    assert.match(failure.error.message, /comparison exceeds 100000 values/);
  assert.ok(reads > 0 && reads < 2000);

  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--max-old-space-size=64',
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
import { schema } from './standalone.points-response.ts';
const extra = Array(2_000_000).fill(0);
const result = schema.safeParse([{ x: 1, y: 2, extra }, { x: 1, y: 2, extra }]);
assert.equal(result.success, false);
assert.match(result.error.message, /comparison exceeds 100000 values/);
console.log('bounded comparison');`,
    ],
    { cwd: root, timeout: 10_000 },
  );
  assert.match(stdout, /^bounded comparison/);
});

void test('uniqueItems applies through 3.0 allOf siblings and diagnoses unsupported forms', async (t) => {
  const { validator } = await generated(
    t,
    '3.0.3',
    { Distinct: { allOf: [ref('Tags')], uniqueItems: true } },
    ['Distinct'],
  );
  duplicate(validator('Distinct:request').safeParse(['a', 'a']), 1, 0);
  for (const [schema, message] of [
    [
      { type: 'array', items: { type: 'string' }, uniqueItems: 'yes' },
      /uniqueItems: expected a boolean/,
    ],
    [{ type: 'string', uniqueItems: true }, /uniqueItems.*unsupported keyword/],
  ] as const) {
    await assert.rejects(
      compile(contract('3.1.2', { Invalid: schema }), {
        clients: [],
        standalone: { tags: { schema: ref('Tags').$ref, usage: 'request' } },
      }),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.match(error.message, message);
        return true;
      },
    );
  }
  const files = { type: 'array', items: { type: 'string', format: 'binary' } };
  for (const field of [
    { ...files, uniqueItems: true },
    { $ref: '#/components/schemas/Files', uniqueItems: true },
  ]) {
    const input = {
      openapi: '3.1.2',
      info: { title: 'Synthetic unique files', version: '1' },
      components: { schemas: { Files: files } },
      paths: {
        '/files': {
          post: {
            operationId: 'upload',
            requestBody: {
              required: true,
              content: {
                'multipart/form-data': {
                  schema: { type: 'object', properties: { files: field } },
                },
              },
            },
            responses: { 204: { description: 'Uploaded' } },
          },
        },
      },
    };
    await assert.rejects(
      compile(input, {
        clients: ['native'],
        surfaces: { native: ['upload'] },
        targets: { native: 'native' },
      }),
      /uniqueItems is unsupported for multipart file arrays/,
    );
  }
});
