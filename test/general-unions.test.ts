import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { compile, ContractError } from '../dist/index.js';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema, SchemaCase } from './schema-helpers.ts';

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

void test('untagged oneOf counts literal and constrained scalar matches in both dialects', async (t) => {
  for (const version of ['3.0.4', '3.1.2']) {
    const { root, request, response } = await generated(t, version, {
      oneOf: [
        { type: 'string', enum: ['left', 'both'] },
        { type: 'string', enum: ['right', 'both'] },
        { type: 'number', minimum: 0 },
        { type: 'integer', maximum: 0 },
      ],
    });
    for (const schema of [request, response]) {
      for (const input of ['left', 'right', 1, 1.5, -1])
        assert.deepEqual(schema.parse(input), input);
      for (const input of ['both', 'neither', 0, -1.5, null, false])
        assert.equal(schema.safeParse(input).success, false);
      const overlap = schema.safeParse('both');
      assert.equal(overlap.success, false);
      if (!overlap.success)
        assert.deepEqual(overlap.error.issues, [
          {
            path: [],
            message:
              'expected exactly one matching union branch; several branches matched',
          },
        ]);
    }
    await typecheckConsumer(
      root,
      `import type { Input, Output } from './standalone.value-request.ts';
const values: Input[] = ['left', 'right', -1, 1.5];
function describe(value: Output): string {
  return typeof value === 'number' ? value.toFixed(1) : value.toUpperCase();
}
// @ts-expect-error Branch types exclude booleans.
const invalid: Input = false;
void [values, describe, invalid];
`,
    );
  }
});

void test('oneOf matches source objects before choosing detached outputs and protocol results', async (t) => {
  const { request, response, client } = await generated(t, '3.1.2', {
    oneOf: [ref('Left'), ref('Right')],
  });
  assert.deepEqual(request.parse({ left: 1 }), { left: 1 });
  const input = { right: 2, shared: 's', extra: { stripped: true } };
  const output = response.parse(input);
  assert.deepEqual(output, { right: 2, shared: 's' });
  assert.notEqual(output, input);
  assert.equal(request.safeParse(input).success, false);
  // Each branch must see both fields, even though its parsed response drops one.
  const mixed = { left: 1, right: 2 };
  const received = response.safeParse(mixed);
  assert.equal(received.success, false);
  if (!received.success)
    assert.match(
      received.error.issues[0]?.message ?? '',
      /several branches matched/,
    );
  const sent = request.safeParse(mixed);
  assert.equal(sent.success, false);
  if (!sent.success)
    assert.ok(
      sent.error.issues.some(({ message }) =>
        /several branches matched/.test(message),
      ),
    );

  const operation = present(client.operations.save);
  assert.throws(
    () => operation.build({ body: mixed }),
    client.RequestValidationError,
  );
  const prepared = operation.build({ body: { right: 2 } });
  const parsed = prepared.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  assert.equal(parsed.kind, 'success');
  if (parsed.kind === 'success') assert.deepEqual(parsed.data, output);
  const ambiguous = prepared.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mixed),
  });
  assert.equal(ambiguous.kind, 'protocol');
  if (ambiguous.kind === 'protocol')
    assert.ok(
      ambiguous.issues.some(({ message }) =>
        /several branches matched/.test(message),
      ),
    );

  const projected = await generated(t, '3.1.2', {
    oneOf: [
      {
        type: 'object',
        properties: {
          value: { type: 'string' },
          secret: { type: 'string', writeOnly: true },
        },
        required: ['value', 'secret'],
      },
      {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    ],
  });
  assert.equal(
    projected.request.safeParse({ value: 'v', secret: 's' }).success,
    false,
  );
  assert.deepEqual(projected.request.parse({ value: 'v' }), { value: 'v' });
  // Projection removes the write-only requirement and creates two matches.
  assert.equal(
    projected.response.safeParse({
      value: 'v',
      get secret(): unknown {
        throw new Error('excluded field must not be read');
      },
    }).success,
    false,
  );
});

void test('untagged oneOf agrees with an independent oracle across nested supported branch forms', async (t) => {
  const cases: SchemaCase[] = [
    {
      name: 'ScalarConstraints',
      schema: {
        oneOf: [
          {
            allOf: [
              { type: 'string', minLength: 2 },
              { type: 'string', pattern: '^a' },
            ],
          },
          { type: 'string', maxLength: 2 },
        ],
      },
      samples: [
        ['a', true],
        ['ab', false],
        ['abc', true],
        ['b', true],
        ['bbb', false],
        [1, false],
      ],
    },
    {
      name: 'NullAndNullable',
      schema: {
        oneOf: [
          { type: 'null' },
          { anyOf: [{ type: 'null' }, { type: 'string' }] },
        ],
      },
      samples: [
        [null, false],
        ['text', true],
        [1, false],
      ],
    },
    {
      name: 'NullAndJson',
      schema: { oneOf: [{ type: 'null' }, {}] },
      samples: [
        [null, false],
        ['text', true],
        [false, true],
        [[], true],
        [{ value: 1 }, true],
      ],
    },
    {
      name: 'Arrays',
      schema: {
        oneOf: [
          { type: 'array', items: { type: 'integer' } },
          { type: 'array', items: { type: 'string' } },
        ],
      },
      samples: [
        [[], false],
        [[1], true],
        [['a'], true],
        [[1, 'a'], false],
        [null, false],
      ],
    },
    {
      name: 'Maps',
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: { type: 'integer' } },
          { type: 'object', additionalProperties: { type: 'string' } },
        ],
      },
      samples: [
        [{}, false],
        [{ value: 1 }, true],
        [{ value: 'a' }, true],
        [{ value: false }, false],
        [[], false],
      ],
    },
    {
      name: 'Objects',
      schema: { oneOf: [fixed('left'), fixed('right')] },
      samples: [
        [{ left: 1 }, true],
        [{ right: 1 }, true],
        [{ left: 1, right: 2 }, false],
        [{}, false],
      ],
    },
    {
      name: 'RepeatedLiterals',
      schema: { oneOf: [{ const: true }, { const: true }, { const: false }] },
      samples: [
        [true, false],
        [false, true],
        [null, false],
      ],
    },
    {
      name: 'NestedOneOf',
      schema: {
        oneOf: [
          {
            oneOf: [
              { type: 'number', minimum: 0 },
              { type: 'number', maximum: 0 },
            ],
          },
          { type: 'integer' },
        ],
      },
      samples: [
        [-1, false],
        [-1.5, true],
        [0, true],
        [1, false],
        [1.5, true],
        [null, false],
      ],
    },
    {
      name: 'DuplicateNull',
      schema: { oneOf: [{ type: 'null' }, { type: 'null' }] },
      samples: [
        [null, false],
        [0, false],
      ],
    },
  ];
  const input = contract('3.1.2', { type: 'string' });
  Object.assign(
    input.components.schemas,
    Object.fromEntries(cases.map(({ name, schema }) => [name, schema])),
  );
  const root = await generatedTestWorkspace(
    t,
    await compile(input, {
      clients: [],
      surfaces: { consumer: ['save'] },
      standalone: Object.fromEntries(
        cases.flatMap(({ name }) =>
          (['request', 'response'] as const).map((usage) => [
            `${name.toLowerCase()}-${usage}`,
            { schema: ref(name).$ref, usage },
          ]),
        ),
      ),
    }),
  );
  const ajv = new Ajv2020({ strict: false });
  for (const { name, schema, samples } of cases) {
    const oracle = ajv.compile(schema);
    for (const usage of ['request', 'response']) {
      const { schema: validator } = await importGenerated<StandaloneModule>(
        root,
        `standalone.${name.toLowerCase()}-${usage}.ts`,
      );
      for (const [value, expected] of samples) {
        assert.equal(oracle(value), expected, `${name}: oracle`);
        assert.equal(
          validator.safeParse(value).success,
          expected,
          `${name}: ${usage} ${JSON.stringify(value)}`,
        );
      }
    }
  }
});

void test('oneOf preserves repeated references and applies use-site constraints before counting matches', async (t) => {
  const repeated = await generated(t, '3.1.2', {
    oneOf: [ref('Left'), ref('Left'), { type: 'integer' }],
  });
  for (const schema of [repeated.request, repeated.response]) {
    assert.equal(schema.safeParse({ left: 1 }).success, false);
    assert.equal(schema.parse(1), 1);
  }
  const constrained = await generated(t, '3.1.2', {
    oneOf: [
      { ...ref('Left'), minProperties: 2 },
      { ...ref('Left'), maxProperties: 1 },
    ],
  });
  for (const schema of [constrained.request, constrained.response]) {
    assert.deepEqual(schema.parse({ left: 1 }), { left: 1 });
    assert.deepEqual(schema.parse({ left: 1, shared: 's' }), {
      left: 1,
      shared: 's',
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
