import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
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

const fixed = (name: string): Schema => ({
  type: 'object',
  properties: { [name]: { type: 'integer' }, shared: { type: 'string' } },
  required: [name],
});

function contract(openapi: string, value: Schema) {
  const content = { 'application/json': { schema: ref('Value') } };
  return {
    openapi,
    info: { title: 'Synthetic general unions', version: '1' },
    components: {
      schemas: {
        Left: fixed('left'),
        Right: fixed('right'),
        Node: {
          type: 'object',
          properties: {
            value: {
              anyOf: [
                { type: 'string' },
                { type: 'integer' },
                ref('Node'),
                { type: 'array', items: ref('Node') },
              ],
            },
          },
        },
        Value: value,
      },
    },
    paths: {
      '/values': {
        post: {
          operationId: 'save',
          requestBody: { required: true, content },
          responses: { 200: { description: 'Saved value', content } },
        },
      },
    },
  };
}

async function generated(t: TestContext, openapi: string, value: Schema) {
  const root = await generatedTestWorkspace(
    t,
    await compile(contract(openapi, value), {
      clients: ['consumer'],
      surfaces: { consumer: ['save'] },
      standalone: Object.fromEntries(
        ['Value', 'Node'].flatMap((name) =>
          (['request', 'response'] as const).map((usage) => [
            `${name.toLowerCase()}-${usage}`,
            { schema: ref(name).$ref, usage },
          ]),
        ),
      ),
    }),
  );
  const load = async (name: string) =>
    (await importGenerated<StandaloneModule>(root, `standalone.${name}.ts`))
      .schema;
  return {
    root,
    client: await importGenerated<RuntimeClient>(root, 'client.consumer.ts'),
    request: await load('value-request'),
    response: await load('value-response'),
    node: await load('node-request'),
  };
}

async function typecheckConsumer(root: string, source: string) {
  await writeFile(join(root, 'consumer.ts'), source);
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
}

void test('anyOf accepts any supported branch and returns the first matching parsed value', async (t) => {
  const { root, client, request, response } = await generated(t, '3.1.2', {
    anyOf: [
      ref('Left'),
      ref('Right'),
      { type: 'string', minLength: 2 },
      { type: 'integer', minimum: 0 },
      { type: 'array', items: { type: 'boolean' } },
      { type: 'null' },
    ],
  });
  for (const value of ['ab', 3, [true, false], null, { left: 1 }])
    assert.deepEqual(request.parse(value), value);
  // Responses strip fields unknown to the first matching branch.
  assert.deepEqual(response.parse({ left: 1, right: 2, shared: 's' }), {
    left: 1,
    shared: 's',
  });
  assert.deepEqual(response.parse({ right: 2, extra: true }), { right: 2 });
  // Requests reject fields unknown to every branch.
  const mixed = request.safeParse({ left: 1, right: 2 });
  assert.equal(mixed.success, false);
  if (!mixed.success)
    assert.deepEqual(
      mixed.error.issues.map(({ message }) => message),
      [
        'union branch 1: unrecognized key: "right"',
        'union branch 2: unrecognized key: "left"',
      ],
    );
  // One branch accepted the shape but failed a constraint: report it directly.
  const short = request.safeParse('a');
  assert.equal(short.success, false);
  if (!short.success)
    assert.deepEqual(short.error.issues, [
      { path: [], message: 'string is too short' },
    ]);
  assert.equal(request.safeParse(1.5).success, false);
  assert.equal(request.safeParse(true).success, false);

  const operation = present(client.operations.save);
  const prepared = operation.build({ body: [true] });
  assert.deepEqual(prepared.body, [true]);
  const result = prepared.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ right: 4, shared: 'x', extra: 1 }),
  });
  assert.equal(result.kind, 'success');
  if (result.kind === 'success')
    assert.deepEqual(result.data, { right: 4, shared: 'x' });

  await typecheckConsumer(
    root,
    `import type { Input, Output } from './standalone.value-request.ts';
const values: Input[] = [{ left: 1 }, { right: 2, shared: 's' }, 'ab', 3, [true], null];
function describe(value: Output): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(String).join();
  return 'left' in value ? String(value.left) : String(value.right);
}
// @ts-expect-error A union branch does not admit unrelated scalar types.
const invalid: Input = true;
void [values, describe, invalid];
`,
  );
});

void test('oneOf without a discriminator dispatches disjoint JSON types in OpenAPI 3.0 and 3.1', async (t) => {
  for (const openapi of ['3.0.3', '3.1.2']) {
    const { request, response, node } = await generated(t, openapi, {
      oneOf: [
        ref('Left'),
        { type: 'array', items: { type: 'string' } },
        { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      ],
    });
    for (const value of [{ left: 1 }, ['a'], 'a', 7])
      assert.deepEqual(request.parse(value), value);
    assert.deepEqual(response.parse({ left: 1, extra: 2 }), { left: 1 });
    for (const value of [null, true, [1], { right: 1 }])
      assert.equal(request.safeParse(value).success, false);

    // Recursive alternatives keep their traversal bounds and detached values.
    const leaf = { value: 'x' };
    const parsed = node.parse({ value: [leaf, { value: leaf }] }) as {
      value: { value: unknown }[];
    };
    assert.notEqual(parsed.value[0], leaf);
    assert.deepEqual(parsed, { value: [leaf, { value: leaf }] });
    let deep: Record<string, unknown> = { value: 1 };
    for (let level = 0; level < 200; level++) deep = { value: deep };
    const failure = node.safeParse(deep);
    assert.equal(failure.success, false);
    if (!failure.success)
      assert.deepEqual(failure.error.issues[0], {
        path: [],
        message: 'recursive validation depth exceeds 128 levels',
      });
  }
});

void test('overlapping union alternatives are bounded at compile time, including shared and nested chains', async () => {
  const document = (schemas: Record<string, Schema>) => ({
    openapi: '3.1.2',
    info: { title: 'Synthetic union work', version: '1' },
    paths: {},
    components: { schemas: { Root: { type: 'string' }, ...schemas } },
  });
  const selection = {
    clients: [],
    standalone: { root: { schema: ref('Root').$ref, usage: 'request' } },
  } as const;
  const shared: Record<string, Schema> = { U0: { type: 'string' } };
  for (let level = 1; level <= 30; level++)
    shared[`U${level}`] = {
      anyOf: [ref(`U${level - 1}`), ref(`U${level - 1}`)],
    };
  // An unused tagless oneOf over a shared chain, and the chain alone. Cached
  // analysis reports the bound instead of expanding every path.
  for (const schemas of [
    { ...shared, ZChoice: { oneOf: [ref('U30'), { type: 'boolean' }] } },
    shared,
  ]) {
    await assert.rejects(compile(document(schemas), selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, 'components.schemas.U11');
      assert.match(error.message, /more than 1024 times/);
      return true;
    });
  }
  const nested: Record<string, Schema> = { V0: { type: 'string' } };
  for (let level = 1; level <= 12; level++)
    nested[`V${level}`] = {
      anyOf: [
        fixed('left'),
        {
          type: 'object',
          properties: { next: ref(`V${level - 1}`), tag: { type: 'string' } },
          required: ['tag'],
        },
        {
          type: 'object',
          properties: { next: ref(`V${level - 1}`) },
        },
      ],
    };
  await assert.rejects(compile(document(nested), selection), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, 'components.schemas.V10');
    assert.match(error.message, /more than 1024 times/);
    return true;
  });
  // Wide but shallow overlap and recursive alternatives remain supported.
  await compile(
    document({
      Wide: {
        anyOf: Array.from({ length: 30 }, (_, index) => fixed(`field${index}`)),
      },
      Expr: {
        anyOf: [
          {
            type: 'object',
            properties: { left: ref('Expr'), right: ref('Expr') },
            required: ['left', 'right'],
          },
          {
            type: 'object',
            properties: { argument: ref('Expr') },
            required: ['argument'],
          },
          { type: 'integer' },
        ],
      },
    }),
    selection,
  );
});

void test('recursive union failures memoize scalar retries and retain the underlying mismatch', async (t) => {
  const levels = 120;
  const schemas: Record<string, Schema> = {
    U0: { type: 'object', properties: { next: ref(`U${levels}`) } },
  };
  for (let level = 1; level <= levels; level++)
    schemas[`U${level}`] = {
      anyOf: [ref(`U${level - 1}`), ref(`U${level - 1}`)],
    };
  const input = contract('3.1.2', ref(`U${levels}`));
  Object.assign(input.components.schemas, schemas);
  const root = await generatedTestWorkspace(
    t,
    await compile(input, {
      clients: ['consumer'],
      surfaces: { consumer: ['save'] },
      standalone: { value: { schema: ref('Value').$ref, usage: 'request' } },
    }),
  );
  const schema = (
    await importGenerated<StandaloneModule>(root, 'standalone.value.ts')
  ).schema;
  const message = /expected an object/;
  for (const value of [
    false,
    null,
    0,
    '',
    true,
    1.5,
    undefined,
    Symbol('invalid'),
    NaN,
  ]) {
    const failure = schema.safeParse(value);
    assert.equal(failure.success, false);
    if (!failure.success) {
      assert.deepEqual(failure.error.issues[0]?.path, []);
      assert.match(failure.error.issues[0].message, message);
      assert.ok(failure.error.issues.length <= 101);
      assert.ok(
        failure.error.issues.every(({ message }) => message.length <= 1024),
      );
    }
  }
  // A failed traversal must not spend the next call's allowance.
  assert.deepEqual(schema.parse({}), {});

  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const operation = present(client.operations.save);
  assert.throws(
    () => operation.build({ body: false }),
    (error) => {
      assert.ok(error instanceof client.RequestValidationError);
      assert.deepEqual(error.issues[0]?.path, ['body']);
      assert.match(error.issues[0].message, message);
      return true;
    },
  );
  const result = operation.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: 'false',
  });
  assert.equal(result.kind, 'protocol');
  if (result.kind === 'protocol')
    assert.ok(result.issues.some(({ message: issue }) => message.test(issue)));
});
