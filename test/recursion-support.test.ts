import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { entry, present, record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import {
  recursionFixture,
  recursionSelection,
  recursionConsumer,
  verifyRecursion,
} from './recursion-fixture.ts';
import type { RecursionSchemas } from './recursion-fixture.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

async function generated(t: TestContext) {
  const root = await generatedTestWorkspace(
    t,
    await compile(recursionFixture(), recursionSelection),
  );
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const schemas = await importGenerated<RecursionSchemas>(
    root,
    'client.consumer.schemas.ts',
  );
  const roots = Object.fromEntries(
    await Promise.all(
      Object.keys(recursionSelection.standalone).map(
        async (name) =>
          [
            name,
            await importGenerated<StandaloneModule>(
              root,
              `standalone.${name}.ts`,
            ),
          ] as const,
      ),
    ),
  );
  return { root, client, schemas, roots };
}

async function standalone(t: TestContext, schema: Schema) {
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic recursive root', version: '1' },
    paths: {},
    components: { schemas: { Loop: schema } },
  };
  const root = await generatedTestWorkspace(
    t,
    await compile(input, {
      clients: [],
      standalone: { value: { schema: ref('Loop').$ref, usage: 'request' } },
    }),
  );
  return (await importGenerated<StandaloneModule>(root, 'standalone.value.ts'))
    .schema;
}

async function wrappedRecursive(t: TestContext, node: Schema, wrapper: Schema) {
  const content = { 'application/json': { schema: wrapper } };
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic recursive traversal root', version: '1' },
    components: { schemas: { Node: node, Batch: wrapper } },
    paths: {
      '/batch': {
        post: {
          operationId: 'batch',
          requestBody: { required: true, content },
          responses: { 200: { description: 'Recursive batch', content } },
        },
      },
    },
  };
  const root = await generatedTestWorkspace(
    t,
    await compile(input, {
      clients: ['consumer'],
      surfaces: { consumer: ['batch'] },
      standalone: {
        request: { schema: ref('Batch').$ref, usage: 'request' },
        response: { schema: ref('Batch').$ref, usage: 'response' },
        single: { schema: ref('Node').$ref, usage: 'request' },
      },
    }),
  );
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const validators = await Promise.all(
    ['request', 'response'].map(
      async (name) =>
        (await importGenerated<StandaloneModule>(root, `standalone.${name}.ts`))
          .schema,
    ),
  );
  const single = (
    await importGenerated<StandaloneModule>(root, 'standalone.single.ts')
  ).schema;
  return { client, validators, single };
}

void test('flat batches share the recursive allowance and fail closed across public boundaries', async (t) => {
  const properties = {
    id: { type: 'integer', minimum: 0 },
    label: { type: 'string', minLength: 1 },
    category: { type: 'string' },
    enabled: { type: 'boolean' },
    quantity: { type: 'integer' },
    price: { type: 'number' },
    revision: { type: 'integer' },
  };
  const required = Object.keys(properties);
  const { client, validators } = await wrappedRecursive(
    t,
    {
      type: 'object',
      properties: {
        ...properties,
        children: { type: 'array', items: ref('Node') },
      },
      required,
    },
    { type: 'array', items: ref('Node') },
  );
  const rows = Array.from({ length: 20_000 }, (_, id) => ({
    id,
    label: `row-${id}`,
    category: 'synthetic',
    enabled: id % 2 === 0,
    quantity: id % 10,
    price: id / 10,
    revision: 1,
  }));
  const accepted = rows.slice(0, 4_000);
  const recovery = rows.slice(0, 1);
  const workLimit = /recursive validation work exceeds 100000 visits/;
  // Seven supplied scalar fields alone exceed the allowance in the large batch.
  // The smaller batch leaves ample room for container and parser accounting.
  for (const schema of validators) {
    assert.deepEqual(schema.parse(accepted), accepted);
    const result = schema.safeParse(rows);
    assert.equal(result.success, false);
    assert.equal(Object.hasOwn(result, 'data'), false);
    if (!result.success) assert.match(result.error.message, workLimit);
    assert.deepEqual(schema.parse(recovery), recovery);
  }
  const operation = present(client.operations.batch);
  assert.deepEqual(operation.build({ body: accepted }).body, accepted);
  assert.throws(
    () => operation.build({ body: rows }),
    (error) => {
      assert.ok(error instanceof client.RequestValidationError);
      assert.match(error.message, workLimit);
      return true;
    },
  );
  assert.deepEqual(operation.build({ body: recovery }).body, recovery);
  const observed = (value: unknown) =>
    operation.parseResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  const first = observed(accepted);
  assert.equal(first.kind, 'success');
  if (first.kind === 'success') assert.deepEqual(first.data, accepted);
  const failed = observed(rows);
  assert.equal(failed.kind, 'protocol');
  assert.equal(Object.hasOwn(failed, 'data'), false);
  if (failed.kind === 'protocol')
    assert.ok(failed.issues.some(({ message }) => workLimit.test(message)));
  const next = observed(recovery);
  assert.equal(next.kind, 'success');
  if (next.kind === 'success') assert.deepEqual(next.data, recovery);

  // The same flat values do not start a recursive traversal under a flat schema.
  const nonrecursive = await standalone(t, {
    type: 'array',
    items: { type: 'object', properties, required },
  });
  assert.deepEqual(nonrecursive.parse(rows), rows);
});

void test('productive recursive contracts preserve JSON/YAML and OpenAPI 3.0/3.1 behavior without mutating inputs', async () => {
  const input = recursionFixture();
  const before = structuredClone(input);
  const expected = await compile(input, recursionSelection);
  assert.deepEqual(input, before);
  assert.deepEqual(
    await compile(
      parseYaml(stringify(input), 'recursive.yaml'),
      recursionSelection,
    ),
    expected,
  );
  const oldDialect = recursionFixture('3.0.4');
  assert.deepEqual(await compile(oldDialect, recursionSelection), expected);
  assert.deepEqual(
    await compile(
      parseYaml(stringify(oldDialect), 'recursive30.yaml'),
      recursionSelection,
    ),
    expected,
  );
});

void test('recursive standalone validators, builders and responses preserve aliases, direction and detached values', async (t) => {
  const { root, client, schemas, roots } = await generated(t);
  verifyRecursion(client, schemas, roots);
  await writeFile(join(root, 'consumer.ts'), recursionConsumer);
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        types: [],
      },
      include: ['*.ts'],
    }),
  );
  await promisify(execFile)(process.execPath, [
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
});

void test('recursive failures retain the nested field path at standalone, request and protocol boundaries', async (t) => {
  const { client, roots } = await generated(t);
  const failure = entry(roots, 'request').schema.safeParse({
    secret: 'root',
    value: 1,
    next: { secret: 'leaf', value: -1 },
  });
  assert.equal(failure.success, false);
  if (!failure.success)
    assert.ok(
      failure.error.issues.some(
        ({ path }) => JSON.stringify(path) === '["next","value"]',
      ),
    );
  const operation = present(client.operations.saveTree);
  assert.throws(
    () =>
      operation.build({
        body: { secret: 'root', value: 1, next: { secret: 'leaf', value: -1 } },
      }),
    (error) => {
      assert.ok(error instanceof client.RequestValidationError);
      assert.ok(
        error.issues.some(
          ({ path }) => JSON.stringify(path) === '["body","next","value"]',
        ),
      );
      return true;
    },
  );
  const result = operation.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'root',
      value: 1,
      next: { id: 'leaf', value: -1 },
    }),
  });
  assert.equal(result.kind, 'protocol');
  if (result.kind === 'protocol')
    assert.ok(
      result.issues.some(
        ({ path }) => JSON.stringify(path) === '["next","value"]',
      ),
    );
});

void test('recursive limit causes keep earlier issues and stay under their request part', async (t) => {
  const content = { 'application/json': { schema: ref('Node') } };
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic recursive failure attribution', version: '1' },
    components: {
      schemas: {
        Node: {
          type: 'object',
          properties: {
            caption: { type: 'string' },
            children: { type: 'array', items: ref('Node') },
          },
        },
      },
    },
    paths: {
      '/nodes': {
        post: {
          operationId: 'save',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              required: true,
              schema: { type: 'integer' },
            },
          ],
          requestBody: { required: true, content },
          responses: { 200: { description: 'Saved node', content } },
        },
      },
    },
  };
  const root = await generatedTestWorkspace(
    t,
    await compile(input, {
      clients: ['consumer'],
      surfaces: { consumer: ['save'] },
      standalone: { node: { schema: ref('Node').$ref, usage: 'request' } },
    }),
  );
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const node = (
    await importGenerated<StandaloneModule>(root, 'standalone.node.ts')
  ).schema;
  let deep: Record<string, unknown> = {};
  for (let level = 0; level < 70; level++) deep = { children: [deep] };
  const cause = 'recursive validation depth exceeds 128 levels';
  const failure = node.safeParse({ caption: 1, children: [deep] });
  assert.equal(failure.success, false);
  if (!failure.success)
    assert.deepEqual(failure.error.issues.slice(0, 2), [
      { path: [], message: cause },
      { path: ['caption'], message: 'expected a string' },
    ]);
  assert.throws(
    () =>
      present(client.operations.save).build({
        query: { limit: 'x' },
        body: { children: [deep] },
      }),
    (error) => {
      assert.ok(error instanceof client.RequestValidationError);
      assert.deepEqual(
        error.issues.slice(0, 2).map(({ path }) => path),
        [['query', 'limit'], ['body']],
      );
      assert.equal(error.issues[1]?.message, cause);
      return true;
    },
  );
});

void test('cycles through recursive arrays, maps, mutual objects and tagged unions fail normally and release traversal state', async (t) => {
  const { roots } = await generated(t);
  const array: unknown[] = [];
  array.push(array);
  const map: Record<string, unknown> = {};
  map.child = map;
  const mutual: Record<string, unknown> = { name: 'outer' };
  mutual.b = { enabled: true, a: mutual };
  const group: Record<string, unknown> = { kind: 'group' };
  group.children = [group];
  for (const [name, value, valid] of [
    ['array', array, []],
    ['map', map, {}],
    ['nullable', array, null],
    ['mutual', mutual, { name: 'after' }],
    ['expression', group, { kind: 'literal', value: 1 }],
  ] as const) {
    const schema = entry(roots, name).schema;
    const result = schema.safeParse(value);
    assert.equal(result.success, false);
    if (!result.success) assert.match(result.error.message, /cycl|circular/i);
    assert.deepEqual(schema.parse(valid), valid);
  }
});

void test('deep recursive JavaScript values and raw JSON stop at a validation boundary before exhausting the call stack', async (t) => {
  const { client, roots } = await generated(t);
  let value: Record<string, unknown> = { secret: 'leaf', value: 1 };
  for (let index = 0; index < 10000; index++)
    value = { secret: 'parent', value: 1, next: value };
  const result = entry(roots, 'request').schema.safeParse(value);
  assert.equal(result.success, false);
  if (!result.success) assert.match(result.error.message, /depth|nest|128/i);
  const operation = present(client.operations.saveTree);
  assert.throws(
    () => operation.build({ body: value }),
    client.RequestValidationError,
  );
  const body =
    '{"id":"parent","value":1,"next":'.repeat(1000) +
    '{"id":"leaf","value":1}' +
    '}'.repeat(1000);
  const parsed = operation.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(parsed.kind, 'protocol');
  if (parsed.kind === 'protocol')
    assert.ok(
      parsed.issues.some(({ message }) => /depth|nest|128/i.test(message)),
    );
});

void test('runtime descent limits account for inline containers between recursive component entries', async (t) => {
  let child: Schema = ref('Loop');
  for (let index = 0; index < 20; index++)
    child = { type: 'array', items: child };
  const schema = await standalone(t, {
    type: 'object',
    properties: { next: child },
  });
  let value: unknown = {};
  for (let index = 0; index < 500; index++) {
    for (let level = 0; level < 20; level++) value = [value];
    value = { next: value };
  }
  const parsed = schema.safeParse(value);
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.match(parsed.error.message, /depth|nest|128/i);
  assert.deepEqual(schema.parse({}), {});
});

void test('shared acyclic graphs remain valid while excessive recursive output expansion receives a work diagnostic', async (t) => {
  const { roots } = await generated(t);
  const schema = entry(roots, 'request').schema;
  const leaf = { secret: 'leaf', value: 1 };
  const small = { secret: 'parent', value: 1, children: [leaf, leaf] };
  const detached = record(schema.parse(small));
  assert.ok(Array.isArray(detached.children));
  assert.notEqual(detached.children[0], detached.children[1]);
  let value: object = leaf;
  for (let index = 0; index < 17; index++)
    value = { secret: 'parent', value: 1, children: [value, value] };
  const result = schema.safeParse(value);
  assert.equal(result.success, false);
  if (!result.success)
    assert.match(result.error.message, /visit|work|100.?000/i);
  assert.deepEqual(schema.parse(leaf), leaf);
});

void test('acyclic named and inline wrappers share one recursive work budget across sibling values', async (t) => {
  const { client, validators, single } = await wrappedRecursive(
    t,
    {
      type: 'object',
      properties: { children: { type: 'array', items: ref('Node') } },
    },
    { type: 'array', items: ref('Node') },
  );
  let shared: object = {};
  for (let level = 0; level < 15; level++)
    shared = { children: [shared, shared] };
  assert.equal(single.safeParse(shared).success, true);
  const batch = [shared, shared];
  for (const schema of validators) {
    const failure = schema.safeParse(batch);
    assert.equal(failure.success, false);
    if (!failure.success)
      assert.match(failure.error.message, /work|visit|100.?000/i);
    assert.deepEqual(schema.parse([{}, {}]), [{}, {}]);
  }
  const operation = present(client.operations.batch);
  assert.throws(
    () => operation.build({ body: batch }),
    (error) => {
      assert.ok(error instanceof client.RequestValidationError);
      assert.match(error.message, /work|visit|100.?000/i);
      return true;
    },
  );
  const response = operation.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(batch),
  });
  assert.equal(response.kind, 'protocol');
  if (response.kind === 'protocol')
    assert.ok(
      response.issues.some(({ message }) =>
        /work|visit|100.?000/i.test(message),
      ),
    );
});

void test('arbitrary JSON descent uses the containing recursive depth and work allowance', async (t) => {
  const schema = await standalone(t, {
    type: 'object',
    properties: { payload: {}, next: ref('Loop') },
  });
  let payload: unknown = 0;
  for (let level = 0; level < 127; level++) payload = [payload];
  assert.deepEqual(schema.parse({ payload }), { payload });
  const deep = schema.safeParse({ payload: [payload] });
  assert.equal(deep.success, false);
  if (!deep.success) assert.match(deep.error.message, /depth exceeds 128/);

  const values = Array(60000).fill(0);
  assert.equal(schema.safeParse({ payload: values }).success, true);
  const work = schema.safeParse({ payload: values, next: { payload: values } });
  assert.equal(work.success, false);
  if (!work.success) assert.match(work.error.message, /work exceeds 100000/);
  assert.deepEqual(schema.parse({ payload: [0] }), { payload: [0] });
});

void test('wide arbitrary JSON objects stop reading values at the recursive work allowance', async (t) => {
  const { validators } = await wrappedRecursive(
    t,
    {
      type: 'object',
      properties: { payload: {}, next: ref('Node') },
    },
    ref('Node'),
  );
  let reads = 0;
  const payload = {};
  for (let index = 0; index < 100_005; index++)
    Object.defineProperty(payload, `key${index}`, {
      enumerable: true,
      get() {
        reads++;
        return 0;
      },
    });
  for (const schema of validators) {
    reads = 0;
    const failure = schema.safeParse({ payload });
    assert.equal(failure.success, false);
    if (!failure.success)
      assert.match(failure.error.message, /work exceeds 100000/);
    assert.ok(reads <= 100_000, `read ${reads} values before stopping`);
    assert.deepEqual(schema.parse({ payload: { value: 1 } }), {
      payload: { value: 1 },
    });
  }
});

void test('arbitrary JSON children reject active typed ancestors even when JSON enumeration hides the back edge', async (t) => {
  const schema = await standalone(t, {
    type: 'object',
    properties: { payload: {}, next: ref('Loop') },
  });
  const ancestor = {};
  Object.defineProperty(ancestor, 'payload', {
    value: { back: ancestor },
  });
  for (const value of [ancestor, { next: ancestor }])
    assert.equal(schema.safeParse(value).success, false);
  const child = { items: [1] };
  const value = { payload: { left: child, right: child } };
  const output = record(record(schema.parse(value)).payload);
  assert.deepEqual(output, value.payload);
  assert.notEqual(output.left, child);
  assert.notEqual(output.left, output.right);
});

void test('recursive depth includes leading named and inline containers before the first recursive component', async (t) => {
  let wrapper: Schema = ref('Node');
  for (let level = 0; level < 20; level++)
    wrapper = { type: 'array', items: wrapper };
  const { client, validators } = await wrappedRecursive(
    t,
    { type: 'object', properties: { next: ref('Node') } },
    wrapper,
  );
  let value: unknown = {};
  for (let level = 0; level < 120; level++) value = { next: value };
  for (let level = 0; level < 20; level++) value = [value];
  for (const schema of validators) {
    const failure = schema.safeParse(value);
    assert.equal(failure.success, false);
    if (!failure.success)
      assert.match(failure.error.message, /depth|nest|128/i);
  }
  const operation = present(client.operations.batch);
  assert.throws(
    () => operation.build({ body: value }),
    (error) => {
      assert.ok(error instanceof client.RequestValidationError);
      assert.match(error.message, /depth|nest|128/i);
      return true;
    },
  );
  const response = operation.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  assert.equal(response.kind, 'protocol');
  if (response.kind === 'protocol')
    assert.ok(
      response.issues.some(({ message }) => /depth|nest|128/i.test(message)),
    );
});

void test('object composition around recursive properties preserves the same detached contract', async (t) => {
  const schema = await standalone(t, {
    allOf: [
      {
        type: 'object',
        properties: { value: { type: 'integer', minimum: 0 } },
        required: ['value'],
      },
      { type: 'object', properties: { next: ref('Loop') } },
    ],
  });
  const value = { value: 1, next: { value: 2 } };
  const parsed = schema.parse(value);
  assert.deepEqual(parsed, value);
  assert.notEqual(record(parsed).next, value.next);
  assert.equal(
    schema.safeParse({ value: 1, next: { value: -1 } }).success,
    false,
  );
});

void test('constrained recursive array aliases retain root and nested length bounds', async (t) => {
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic constrained recursive arrays', version: '1' },
    paths: {},
    components: {
      schemas: {
        Loop: { type: 'array', items: ref('Bounded') },
        Bounded: { ...ref('Loop'), maxItems: 1 },
        Nonempty: { ...ref('Loop'), minItems: 1 },
      },
    },
  };
  const root = await generatedTestWorkspace(
    t,
    await compile(input, {
      clients: [],
      standalone: {
        source: { schema: ref('Loop').$ref, usage: 'request' },
        bounded: { schema: ref('Bounded').$ref, usage: 'request' },
        nonempty: { schema: ref('Nonempty').$ref, usage: 'request' },
      },
    }),
  );
  const source = (
    await importGenerated<StandaloneModule>(root, 'standalone.source.ts')
  ).schema;
  const bounded = (
    await importGenerated<StandaloneModule>(root, 'standalone.bounded.ts')
  ).schema;
  const nonempty = (
    await importGenerated<StandaloneModule>(root, 'standalone.nonempty.ts')
  ).schema;
  assert.deepEqual(source.parse([[], []]), [[], []]);
  assert.deepEqual(bounded.parse([[[]]]), [[[]]]);
  assert.equal(bounded.safeParse([[], []]).success, false);
  assert.equal(source.safeParse([[[], []]]).success, false);
  assert.equal(nonempty.safeParse([]).success, false);
  assert.deepEqual(nonempty.parse([[]]), [[]]);
});

const nonproductive: readonly [string, Record<string, Schema>][] = [
  ['self alias', { Loop: ref('Loop') }],
  ['mutual aliases', { Loop: ref('Other'), Other: ref('Loop') }],
  [
    'nullable same-value loop',
    { Loop: { anyOf: [ref('Loop'), { type: 'null' }] } },
  ],
  ['composition same-value loop', { Loop: { allOf: [ref('Loop')] } }],
  [
    'cycle with a productive sibling',
    {
      Loop: {
        allOf: [
          ref('Loop'),
          { type: 'object', properties: { child: ref('Loop') } },
        ],
      },
    },
  ],
];
for (const [name, schemas] of nonproductive) {
  void test(`nonproductive ${name} diagnoses before output selection`, async () => {
    const input = recursionFixture();
    Object.assign(input.components.schemas, schemas);
    await assert.rejects(compile(input, recursionSelection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.match(error.location, /components\.schemas/);
      assert.match(error.message, /cycl|recurs|progress/i);
      return true;
    });
  });
}

function nullableBindingSchemas(): Record<string, Schema> {
  const schemas: Record<string, Schema> = {
    Node: {
      type: 'object',
      properties: { next: ref('U0') },
      required: ['next'],
    },
  };
  for (let index = 0; index < 32; index++)
    schemas[`U${index}`] = {
      anyOf: [ref(index === 31 ? 'Node' : `U${index + 1}`), { type: 'null' }],
    };
  return schemas;
}

function recursiveNodeChain(length: number) {
  let value: unknown = null;
  for (let index = 0; index < length; index++) value = { next: value };
  return value;
}

void test('many nullable bindings per descent stop at a parser-depth diagnostic before the call stack is exhausted', async (t) => {
  const schemas = nullableBindingSchemas();
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic nullable recursive bindings', version: '1' },
    components: { schemas },
    paths: {
      '/node': {
        get: {
          operationId: 'readNode',
          responses: {
            200: {
              description: 'Recursive node',
              content: { 'application/json': { schema: ref('Node') } },
            },
          },
        },
      },
    },
  };
  const root = await generatedTestWorkspace(
    t,
    await compile(input, {
      clients: ['consumer'],
      surfaces: { consumer: ['readNode'] },
      standalone: { node: { schema: ref('Node').$ref, usage: 'request' } },
    }),
  );
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.node.ts',
  );
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const small = recursiveNodeChain(8);
  const large = recursiveNodeChain(64);
  assert.deepEqual(schema.parse(small), small);
  const failure = schema.safeParse(large);
  assert.equal(failure.success, false);
  if (!failure.success) {
    assert.equal(failure.error.name, 'ValidationError');
    assert.match(failure.error.message, /parser depth exceeds 512/);
  }
  const operation = present(client.operations.readNode);
  const observed = (body: unknown) =>
    operation.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const result = observed(large);
  assert.equal(result.kind, 'protocol');
  if (result.kind === 'protocol')
    assert.ok(
      result.issues.some(({ message }) =>
        /parser depth exceeds 512/.test(message),
      ),
    );
  assert.deepEqual(schema.parse(small), small);
  const after = observed(small);
  assert.equal(after.kind, 'success');
  if (after.kind === 'success') assert.deepEqual(after.data, small);
});

void test('nullable terminals stay within parser limits and preserve later sibling diagnostics', async (t) => {
  const schemas = nullableBindingSchemas();
  schemas.Envelope = {
    type: 'object',
    properties: { recursive: ref('U0'), zError: { type: 'string' } },
    required: ['recursive', 'zError'],
  };
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic recursive union cleanup', version: '1' },
    paths: {},
    components: { schemas },
  };
  const root = await generatedTestWorkspace(
    t,
    await compile(input, {
      clients: [],
      standalone: {
        recursive: { schema: ref('U0').$ref, usage: 'request' },
        envelope: { schema: ref('Envelope').$ref, usage: 'request' },
      },
    }),
  );
  const recursive = (
    await importGenerated<StandaloneModule>(root, 'standalone.recursive.ts')
  ).schema;
  const envelope = (
    await importGenerated<StandaloneModule>(root, 'standalone.envelope.ts')
  ).schema;
  for (const depth of [1, 8, 14, 15]) {
    const value = recursiveNodeChain(depth);
    assert.deepEqual(recursive.parse(value), value);
    const valid = { recursive: value, zError: 'valid sibling' };
    assert.deepEqual(envelope.parse(valid), valid);
    const failure = envelope.safeParse({ recursive: value, zError: 123 });
    assert.equal(failure.success, false);
    if (!failure.success)
      assert.deepEqual(failure.error.issues, [
        { path: ['zError'], message: 'expected a string' },
      ]);
  }
  for (const depth of [16, 32]) {
    const failure = recursive.safeParse(recursiveNodeChain(depth));
    assert.equal(failure.success, false);
    if (!failure.success)
      assert.match(
        failure.error.issues[0]?.message ?? '',
        /parser depth exceeds 512/,
      );
  }
});

void test('a recursive union abort stops later alternatives and sibling value reads', async (t) => {
  const { roots } = await generated(t);
  const schema = entry(roots, 'union-response').schema;
  let reads = 0;
  const children: unknown[] = [];
  const value = {
    id: 'cyclic',
    children,
    value: 1,
    get payload() {
      reads++;
      return {};
    },
  };
  children.push(value);
  const failure = schema.safeParse(value);
  assert.equal(failure.success, false);
  if (!failure.success)
    assert.match(failure.error.issues[0]?.message ?? '', /cyclic input/);
  assert.equal(reads, 0);
  assert.deepEqual(schema.parse({ id: 'after', value: 2 }), {
    id: 'after',
    value: 2,
  });
});

void test('omitted prototype-only optional values neither consume recursive work nor supply a later failure cause', async (t) => {
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic omitted recursive field', version: '1' },
    paths: {},
    components: {
      schemas: {
        Node: {
          type: 'object',
          properties: { children: { type: 'array', items: ref('Node') } },
        },
        Envelope: {
          type: 'object',
          properties: {
            aIgnored: ref('Node'),
            actual: ref('Node'),
            zError: { type: 'string' },
          },
          required: ['actual'],
        },
      },
    },
  };
  const root = await generatedTestWorkspace(
    t,
    await compile(input, {
      clients: [],
      standalone: { value: { schema: ref('Envelope').$ref, usage: 'request' } },
    }),
  );
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.value.ts',
  );
  function binaryTree(depth: number) {
    let value: object = {};
    for (let level = 0; level < depth; level++)
      value = { children: [value, value] };
    return value;
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.children = [cyclic];
  const previous = Object.getOwnPropertyDescriptor(
    Object.prototype,
    'aIgnored',
  );
  try {
    for (const ignored of [binaryTree(15), cyclic]) {
      Object.defineProperty(Object.prototype, 'aIgnored', {
        value: ignored,
        configurable: true,
        writable: true,
      });
      const actual = binaryTree(11);
      const value = { actual };
      const parsed = schema.parse(value);
      assert.deepEqual(parsed, value);
      assert.equal(Object.hasOwn(record(parsed), 'aIgnored'), false);
      assert.notEqual(record(parsed).actual, actual);
      const failure = schema.safeParse({ actual, zError: 123 });
      assert.equal(failure.success, false);
      if (!failure.success)
        assert.deepEqual(failure.error.issues, [
          { path: ['zError'], message: 'expected a string' },
        ]);
    }
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'aIgnored', previous);
    else Reflect.deleteProperty(Object.prototype, 'aIgnored');
  }
  assert.deepEqual(schema.parse({ actual: {} }), { actual: {} });
});
