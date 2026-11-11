import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { compile, ContractError } from '../dist/index.js';
import { jsonAnnotation } from '../dist/annotations.js';
import {
  defineOperation,
  list,
  map,
  numeric,
  stringValue,
  text,
  validator,
} from '../dist/runtime.js';
import type {
  ArrayRules,
  NumberRules,
  ObjectRules,
  StringRules,
} from '../dist/runtime.js';
import { temporary } from './helpers.ts';

function polluted<T>(name: string, value: unknown, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, name);
  Object.defineProperty(Object.prototype, name, {
    configurable: true,
    writable: true,
    value,
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(Object.prototype, name, previous);
    else Reflect.deleteProperty(Object.prototype, name);
  }
}

void test('validator rule metadata uses only declared bounds, including a cold predicate cache', () => {
  // Keep the descriptors stable across calls so the cleanup assertion exercises
  // the same cached predicates, including their first use during pollution.
  const textWith = (rules: StringRules) =>
    validator((v, i) => text(v, i, rules));
  const numberWith = (rules: NumberRules) =>
    validator((v, i) => numeric(v, i, rules));
  const arrayWith = (rules: ArrayRules) =>
    validator((v, i) => list(v, i, stringValue, rules));
  const mapWith = (rules: ObjectRules) =>
    validator((v, i) => map(v, i, stringValue, rules));
  for (const [name, value, create, input, bad] of [
    ['minLength', 9, () => textWith({ maxLength: 2 }), 'a', 'abc'],
    ['maxLength', 0, () => textWith({ minLength: 1 }), 'a', ''],
    ['minimum', 9, () => numberWith({ maximum: 2 }), 1, 3],
    ['maximum', 0, () => numberWith({ minimum: 1 }), 1, 0],
    ['exclusiveMinimum', 9, () => numberWith({ maximum: 2 }), 1, 3],
    ['exclusiveMaximum', 0, () => numberWith({ minimum: 1 }), 1, 0],
    ['multipleOf', 2, () => numberWith({ maximum: 2 }), 1, 3],
    ['integer', true, () => numberWith({ maximum: 2 }), 1.5, 3],
    ['float', true, () => numberWith({ minimum: 1 }), 1e40, 0],
    ['pattern', '^never$', () => textWith({ minLength: 1 }), 'a', ''],
    [
      'format',
      { message: 'inherited format', check: () => false },
      () => textWith({ minLength: 1 }),
      'a',
      '',
    ],
    ['minItems', 9, () => arrayWith({ maxItems: 2 }), ['a'], ['a', 'b', 'c']],
    ['maxItems', 0, () => arrayWith({ minItems: 1 }), ['a'], []],
    [
      'minProperties',
      9,
      () => mapWith({ maxProperties: 2 }),
      { a: 'a' },
      { a: 'a', b: 'b', c: 'c' },
    ],
    ['maxProperties', 0, () => mapWith({ minProperties: 1 }), { a: 'a' }, {}],
  ] as const) {
    for (const warm of [false, true]) {
      const schema = create();
      if (warm) assert.equal(schema.safeParse(input).success, true);
      polluted(name, value, () => {
        for (const current of [schema, create()]) {
          assert.equal(current.safeParse(input).success, true, name);
          assert.equal(
            current.safeParse(bad).success,
            false,
            `${name}: own bound`,
          );
        }
      });
      assert.equal(schema.safeParse(input).success, true, `${name}: cached`);
    }
  }
});

void test('operation metadata never inherits serialization, multipart, or content-type defaults', () => {
  function operation() {
    return defineOperation({
      operationId: 'list',
      method: 'POST',
      path: '/items',
      bodyKind: 'json',
      security: { transport: 'none' },
      policy: {},
      parameters: [{ name: 'tag', in: 'query', required: false }],
      options: (input: unknown) => ({
        query: { tag: ['a', 'b'] },
        body: input,
      }),
      headers: {},
      responses: { 204: { bodyKind: 'none', headers: {} } },
    });
  }
  const existing = operation();
  for (const [name, value] of [
    ['explode', false],
    ['multipart', 'not an array'],
    ['contentType', 'text/plain'],
  ] as const) {
    polluted(name, value, () => {
      for (const current of [existing, operation()]) {
        const request = current.build({
          query: { tag: ['a', 'b'] },
          body: { value: 1 },
        });
        assert.equal(request.url, '/items?tag=a&tag=b');
        assert.equal(request.bodyKind, 'json');
        if (request.bodyKind === 'json')
          assert.equal(request.contentType, 'application/json');
      }
    });
  }
});

function document() {
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic own metadata', version: '1' },
    paths: {
      '/items': {
        get: {
          operationId: 'list',
          parameters: [
            {
              name: 'tag',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
            },
          ],
          responses: { 204: { description: 'Empty' } },
        },
      },
    },
    components: {
      schemas: {
        Root: {
          type: 'object',
          properties: {
            customerId: {
              type: 'string',
              maxLength: 20,
              readOnly: false,
              writeOnly: false,
            },
            serverId: { type: 'string', readOnly: true },
            secret: { type: 'string', writeOnly: true },
            count: { type: 'integer', maximum: 100 },
            values: { type: 'array', items: { type: 'string' }, maxItems: 3 },
            labels: {
              type: 'object',
              additionalProperties: { type: 'string' },
              maxProperties: 3,
            },
            maybe: { type: ['string', 'null'] },
          },
        },
      },
    },
  };
}
const selection = {
  clients: ['consumer'],
  surfaces: { consumer: ['list'] },
  standalone: {
    root: { schema: '#/components/schemas/Root', usage: 'request' },
  },
} as const;

const inheritedSchemaMetadata = [
  ['minLength', 9],
  ['maxLength', 0],
  ['pattern', '^never$'],
  ['minimum', 9],
  ['maximum', 0],
  ['exclusiveMinimum', 9],
  ['exclusiveMaximum', 0],
  ['multipleOf', 2],
  ['float', true],
  ['integer', true],
  ['minItems', 9],
  ['maxItems', 0],
  ['minProperties', 9],
  ['maxProperties', 0],
  ['readOnly', true],
  ['writeOnly', true],
  ['format', 'binary'],
  ['literals', ['inherited literal']],
  ['forbidden', ['customerId']],
  ['sourceTypeArray', true],
  ['discriminator', { propertyName: 'inheritedTag', mapping: {} }],
] as const;

for (const version of ['3.0.4', '3.1.2'])
  void test(`compilation ignores inherited declarations and retains the original ${version} document`, async () => {
    const input = document();
    input.openapi = version;
    if (version === '3.0.4')
      Object.assign(input.components.schemas.Root.properties, {
        maybe: { type: 'string', nullable: true },
      });
    const before = structuredClone(input);
    const baseline = await compile(input, selection);
    for (const [name, value] of [
      ['explode', false],
      ...inheritedSchemaMetadata,
      ['formats', { inherited: { type: 'number' } }],
      ['customerId', 'unrelated global field'],
    ] as const) {
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, name);
      let actual: Readonly<Record<string, string>>;
      Object.defineProperty(Object.prototype, name, {
        value,
        configurable: true,
        writable: true,
      });
      try {
        actual = await compile(input, selection);
      } finally {
        if (previous) Object.defineProperty(Object.prototype, name, previous);
        else Reflect.deleteProperty(Object.prototype, name);
      }
      assert.deepEqual(actual, baseline, name);
    }
    assert.deepEqual(input, before);
    // Caller mutations between invocations must not be hidden by a global cache.
    input.components.schemas.Root.properties.customerId.maxLength = 10;
    assert.notDeepEqual(await compile(input, selection), baseline);
  });

void test('overlapping compilations isolate caller mutations and reuse no stale metadata', async () => {
  const input = document();
  const root: { schema: string; usage: 'request' | 'response' } = {
    ...selection.standalone.root,
  };
  const options = { ...selection, standalone: { root } };
  const before = structuredClone(input);
  const beforeOptions = structuredClone(options);
  const first = compile(input, options);

  input.components.schemas.Root.properties.customerId.maxLength = 10;
  root.usage = 'response';
  const changed = structuredClone(input);
  const changedOptions = structuredClone(options);
  const second = compile(input, options);

  input.components.schemas.Root.properties.customerId.maxLength = 20;
  root.usage = 'request';
  const third = compile(input, options);
  const [firstOutput, secondOutput, thirdOutput] = await Promise.all([
    first,
    second,
    third,
  ]);
  assert.deepEqual(firstOutput, await compile(before, beforeOptions));
  assert.deepEqual(secondOutput, await compile(changed, changedOptions));
  assert.notDeepEqual(secondOutput, firstOutput);
  assert.deepEqual(thirdOutput, firstOutput);
  assert.deepEqual(input, before);
  assert.deepEqual(options, beforeOptions);
});

void test('compiler metadata ownership rejects custom source prototypes at the original location', async () => {
  const input = document();
  Object.setPrototypeOf(input.components.schemas.Root.properties.count, {
    minimum: 9,
  });
  await assert.rejects(compile(input, selection), {
    name: 'ContractError',
    location: 'components.schemas.Root.properties.count',
    message: /expected a plain object/,
  });
});

void test('3.0 lowering also reads own declarations before interpreting the source type', async () => {
  const input = document();
  input.openapi = '3.0.4';
  Object.assign(input.components.schemas, {
    Alias: { $ref: '#/components/schemas/Root' },
  });
  // The equivalent 3.0 nullable form avoids 3.1-only type arrays.
  Object.assign(input.components.schemas.Root.properties, {
    maybe: { type: 'string', nullable: true },
  });
  const baseline = await compile(input, selection);
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'type');
  let actual: Readonly<Record<string, string>>;
  Object.defineProperty(Object.prototype, 'type', {
    value: 'null',
    configurable: true,
    writable: true,
  });
  try {
    actual = await compile(input, selection);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'type', previous);
    else Reflect.deleteProperty(Object.prototype, 'type');
  }
  assert.deepEqual(actual, baseline);
});

void test('generated max-only containers remain valid under inherited minimum bounds', async (t) => {
  const root = await temporary(t);
  const files = await compile(document(), selection);
  for (const [name, source] of Object.entries(files))
    await writeFile(join(root, name), source);
  const module = (await import(
    pathToFileURL(join(root, 'standalone.root.ts')).href
  )) as {
    schema: { parse(input: unknown): unknown };
  };
  const input = {
    customerId: 'a',
    count: 1,
    values: ['a'],
    labels: { a: 'a' },
    maybe: null,
  };
  for (const [name, value] of [
    ['minItems', 9],
    ['minProperties', 9],
    ['minLength', 9],
    ['minimum', 9],
  ] as const)
    polluted(name, value, () =>
      assert.deepEqual(module.schema.parse(input), input),
    );
});

void test('generated metadata is invariant before module initialization and after parsing', async (t) => {
  const root = await temporary(t);
  const files = await compile(document(), selection);
  const input = {
    customerId: 'a',
    count: 1,
    values: ['a'],
    labels: { a: 'a' },
    maybe: null,
  };
  let index = 0;
  for (const [name, value] of [
    ...inheritedSchemaMetadata,
    ['explode', false],
    ['contentType', 'text/plain'],
    ['multipart', 'not an array'],
  ] as const) {
    for (const warm of [false, true]) {
      const directory = join(root, `case-${index++}`);
      await mkdir(directory);
      for (const [filename, source] of Object.entries(files))
        await writeFile(join(directory, filename), source);
      const load = async () => {
        const standalone = (await import(
          pathToFileURL(join(directory, 'standalone.root.ts')).href
        )) as { schema: { parse(input: unknown): unknown } };
        const client = (await import(
          pathToFileURL(join(directory, 'client.consumer.ts')).href
        )) as {
          operations: {
            list: {
              build(input: unknown): { url: string; bodyKind: string };
            };
          };
        };
        return { ...standalone, ...client };
      };
      const loaded = warm ? await load() : undefined;
      if (loaded) assert.deepEqual(loaded.schema.parse(input), input);
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, name);
      Object.defineProperty(Object.prototype, name, {
        value,
        configurable: true,
        writable: true,
      });
      try {
        const module = loaded ?? (await load());
        assert.deepEqual(module.schema.parse(input), input, name);
        assert.deepEqual(
          module.schema.parse(Object.create(input)),
          input,
          name,
        );
        assert.deepEqual(
          module.schema.parse({ secret: 'declared write-only input' }),
          {
            secret: 'declared write-only input',
          },
        );
        assert.throws(() =>
          module.schema.parse({ serverId: 'read-only input' }),
        );
        assert.throws(() =>
          module.schema.parse({ ...input, customerId: 'x'.repeat(21) }),
        );
        assert.throws(() => module.schema.parse({ ...input, count: 101 }));
        assert.throws(() =>
          module.schema.parse({ ...input, values: ['a', 'b', 'c', 'd'] }),
        );
        assert.throws(() =>
          module.schema.parse({
            ...input,
            labels: { a: 'a', b: 'b', c: 'c', d: 'd' },
          }),
        );
        const request = module.operations.list.build({
          query: { tag: ['a', 'b'] },
        });
        assert.equal(request.url, '/items?tag=a&tag=b', name);
        assert.equal(request.bodyKind, 'none', name);
      } finally {
        if (previous) Object.defineProperty(Object.prototype, name, previous);
        else Reflect.deleteProperty(Object.prototype, name);
      }
    }
  }
});

void test('application payload prototypes preserve structural fixed fields and own JSON map keys', async (t) => {
  const root = await temporary(t);
  for (const [name, source] of Object.entries(
    await compile(document(), selection),
  ))
    await writeFile(join(root, name), source);
  const { schema } = (await import(
    pathToFileURL(join(root, 'standalone.root.ts')).href
  )) as { schema: { parse(input: unknown): unknown } };
  const fields = {
    customerId: 'structural',
    count: 1,
    values: ['a'],
    maybe: null,
  };
  const payload = Object.create(fields) as Record<string, unknown>;
  payload.labels = JSON.parse(
    '{"__proto__":"data","constructor":"also data","prototype":"still data"}',
  ) as unknown;
  assert.deepEqual(schema.parse(payload), {
    ...fields,
    labels: payload.labels,
  });
  polluted('customerId', 'unrelated global field', () => {
    assert.deepEqual(schema.parse(payload), {
      ...fields,
      labels: payload.labels,
    });
    assert.deepEqual(schema.parse({}), {});
  });
  assert.throws(() =>
    schema.parse({
      labels: Object.create({ a: 'inherited map key' }) as unknown,
    }),
  );
});

void test('own-only compiler views still reject cyclic annotation objects and revisit shared input', async () => {
  const input = document();
  const example: Record<string, unknown> = {};
  example.self = example;
  Object.assign(input.components.schemas.Root, { example });
  await assert.rejects(
    compile(input, selection),
    (error) =>
      error instanceof ContractError &&
      error.location === 'components.schemas.Root.example' &&
      /annotation must be JSON without cycles/.test(error.message),
  );
  const shared = { data: 'synthetic' };
  Object.assign(input.components.schemas.Root, {
    example: { left: shared, right: shared },
  });
  await compile(input, selection);
});

void test('annotation ownership inspects a wide shared record once regardless of incoming references', () => {
  let inspections = 0;
  const shared = new Proxy(
    Object.fromEntries(
      Array.from({ length: 500 }, (_, index) => [`field${index}`, 'value']),
    ),
    {
      ownKeys(target) {
        inspections++;
        return Reflect.ownKeys(target);
      },
    },
  );
  jsonAnnotation(Array(500).fill(shared), 'example');
  assert.equal(inspections, 1);
});
