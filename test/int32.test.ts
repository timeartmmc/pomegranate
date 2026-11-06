import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { fixture, temporary } from './helpers.ts';
import { present } from './assertions.ts';
import type { Schema } from './schema-helpers.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';

const minimum = -2_147_483_648;
const maximum = 2_147_483_647;
const int32 = { type: 'integer', format: 'int32' };
const valueRef = { $ref: '#/components/schemas/Value' };
function document(schemas: Record<string, Schema>) {
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic int32 contracts', version: '1' },
    components: { schemas },
    paths: {},
  };
}
const roots = {
  clients: [],
  standalone: {
    value: { schema: '#/components/schemas/Value', usage: 'request' },
    reply: { schema: '#/components/schemas/Value', usage: 'response' },
  },
} as const;
async function save(files: Readonly<Record<string, string>>, root: string) {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries(files))
    await writeFile(join(root, name), source);
}
async function standalone(root: string, name: string) {
  return (await import(
    pathToFileURL(join(root, `standalone.${name}.ts`)).href
  )) as StandaloneModule;
}

void test('int32 lowers to explicit integer bounds with identical output and YAML behavior', async () => {
  for (const limits of [
    {},
    { minimum: minimum - 1, maximum: maximum + 1 },
    { minimum: -2, maximum: 2 },
    { exclusiveMinimum: -2, exclusiveMaximum: 2, multipleOf: 1 },
  ]) {
    const input = document({ Value: { ...int32, ...limits } });
    const before = structuredClone(input);
    const files = await compile(input, roots);
    const expanded = document({
      Value: {
        type: 'integer',
        ...limits,
        minimum: Math.max(minimum, limits.minimum ?? minimum),
        maximum: Math.min(maximum, limits.maximum ?? maximum),
      },
    });
    assert.deepEqual(files, await compile(expanded, roots));
    assert.deepEqual(
      files,
      await compile(parseYaml(stringify(input), 'int32.yaml'), roots),
    );
    assert.deepEqual(input, before);
  }
});

void test('generated request and response int32 validators enforce endpoints and reference narrowing', async (t) => {
  const schemas = {
    Value: int32,
    Alias: valueRef,
    Narrow: { $ref: '#/components/schemas/Alias', minimum: -2, maximum: 2 },
    Even: { $ref: '#/components/schemas/Narrow', multipleOf: 2 },
    Nullable: { type: ['integer', 'null'], format: 'int32' },
    Literals: { ...int32, enum: [minimum, maximum] },
    NullOnly: {
      type: ['integer', 'null'],
      format: 'int32',
      const: null,
      minimum: maximum + 1,
    },
  } satisfies Record<string, Schema>;
  const root = await temporary(t);
  const selections = Object.fromEntries(
    Object.keys(schemas).flatMap((name) =>
      (['request', 'response'] as const).map((usage) => [
        `${name.toLowerCase()}-${usage}`,
        { schema: `#/components/schemas/${name}`, usage },
      ]),
    ),
  );
  await save(
    await compile(document(schemas), { clients: [], standalone: selections }),
    root,
  );
  const samples: unknown[] = [
    minimum - 1,
    minimum,
    -2,
    -1,
    -0,
    0,
    1,
    2,
    maximum,
    maximum + 1,
    0.5,
    Infinity,
    NaN,
    '0',
    null,
    undefined,
  ];
  for (const usage of ['request', 'response']) {
    for (const [name, accepts] of [
      ['value', (input: number) => input >= minimum && input <= maximum],
      ['alias', (input: number) => input >= minimum && input <= maximum],
      ['narrow', (input: number) => input >= -2 && input <= 2],
      ['even', (input: number) => input >= -2 && input <= 2 && input % 2 === 0],
      ['literals', (input: number) => input === minimum || input === maximum],
    ] as const) {
      const { schema } = await standalone(root, `${name}-${usage}`);
      for (const sample of samples) {
        const expected =
          typeof sample === 'number' &&
          Number.isInteger(sample) &&
          accepts(sample);
        assert.equal(
          schema.safeParse(sample).success,
          expected,
          `${name}/${usage}/${String(sample)}`,
        );
      }
    }
    const { schema: nullable } = await standalone(root, `nullable-${usage}`);
    assert.equal(nullable.parse(null), null);
    assert.equal(nullable.parse(maximum), maximum);
    assert.equal(nullable.safeParse(maximum + 1).success, false);
    const { schema: nullOnly } = await standalone(root, `nullonly-${usage}`);
    assert.equal(nullOnly.parse(null), null);
    assert.equal(nullOnly.safeParse(maximum).success, false);
  }
});

const invalid: [string, Schema, RegExp][] = [
  ['lower const overflow', { ...int32, const: minimum - 1 }, /literal.*bounds/],
  ['upper const overflow', { ...int32, const: maximum + 1 }, /literal.*bounds/],
  [
    'upper enum overflow',
    { ...int32, enum: [0, maximum + 1] },
    /literal.*bounds/,
  ],
  ['fractional const', { ...int32, const: 1.5 }, /literal must match/],
  [
    'empty signed interval',
    { ...int32, minimum: maximum + 1 },
    /bounds admit no/,
  ],
  [
    'exclusive lower interval',
    { ...int32, exclusiveMaximum: minimum },
    /bounds admit no/,
  ],
  [
    'exclusive upper interval',
    { ...int32, exclusiveMinimum: maximum },
    /bounds admit no/,
  ],
  ['invalid constraint syntax', { ...int32, minimum: '0' }, /finite number/],
  [
    'number type mismatch',
    { type: 'number', format: 'int32' },
    /unsupported numeric format/,
  ],
  [
    'string type mismatch',
    { type: 'string', format: 'int32' },
    /unsupported format/,
  ],
  [
    'boolean type mismatch',
    { type: 'boolean', format: 'int32' },
    /format is not supported on boolean schemas in this version/,
  ],
  [
    'reference format sibling',
    { ...valueRef, format: 'int32' },
    /format.*unsupported keyword/,
  ],
];
for (const [name, schema, message] of invalid)
  void test(`int32 rejects ${name} before selecting output`, async () => {
    const input = fixture();
    Object.assign(input.components.schemas, { UnselectedInt32: schema });
    const before = structuredClone(input);
    await assert.rejects(compile(input, { clients: ['consumer'] }), (error) => {
      assert.ok(error instanceof ContractError);
      assert.match(error.location, /^components.schemas.UnselectedInt32/);
      assert.match(error.message, message);
      return true;
    });
    assert.deepEqual(input, before);
  });

void test('undeclared numeric formats diagnose', async () => {
  for (const format of ['custom', 'unknown']) {
    const input = document({ Value: { type: 'number', format } });
    await assert.rejects(
      compile(input, roots),
      /format: unsupported numeric format; number schemas support float or double/,
    );
  }
});

void test('int32 reference chains reject contradictory bounds and exhausted literals', async () => {
  for (const constraints of [
    { minimum: maximum + 1 },
    { minimum: 0, maximum: maximum - 1 },
  ]) {
    const input = document({
      Value: { ...int32, enum: [minimum, maximum] },
      Alias: valueRef,
      Invalid: { $ref: '#/components/schemas/Alias', ...constraints },
    });
    await assert.rejects(
      compile(input, roots),
      /bounds admit no|admit no literal/,
    );
  }
});

void test('int32 defaults stay annotations without filling or changing requiredness', async (t) => {
  const input = document({
    Value: {
      type: 'object',
      properties: {
        required: { ...int32, default: maximum + 1 },
        optional: { ...int32, default: 'server-owned annotation' },
      },
      required: ['required'],
      additionalProperties: false,
    },
  });
  const root = await temporary(t);
  const selection = {
    clients: [],
    standalone: { value: roots.standalone.value },
  };
  await save(await compile(input, selection), root);
  const { schema } = await standalone(root, 'value');
  assert.deepEqual(schema.parse({ required: 0 }), { required: 0 });
  assert.deepEqual(schema.parse({ required: 0, optional: undefined }), {
    required: 0,
    optional: undefined,
  });
  assert.equal(schema.safeParse({}).success, false);
  assert.equal(schema.safeParse({ required: undefined }).success, false);
  assert.equal(schema.safeParse({ required: maximum + 1 }).success, false);
  await compile(input, roots);
});

void test('int32 operation builders, response parsers and declaration consumers agree', async (t) => {
  const input = document({ Value: int32 });
  Object.assign(input.paths, {
    '/value': {
      post: {
        operationId: 'roundTrip',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: valueRef } },
        },
        responses: {
          200: {
            description: 'Value',
            content: { 'application/json': { schema: valueRef } },
          },
        },
      },
    },
  });
  const root = await temporary(t);
  await save(
    await compile(input, {
      clients: ['consumer'],
      surfaces: { consumer: ['roundTrip'] },
    }),
    root,
  );
  const { operations } = (await import(
    pathToFileURL(join(root, 'client.consumer.ts')).href
  )) as RuntimeClient;
  const operation = present(operations.roundTrip);
  assert.equal(operation.build({ body: minimum }).body, minimum);
  assert.throws(
    () => operation.build({ body: maximum + 1 }),
    /invalid request/,
  );
  for (const [body, expected] of [
    [String(maximum), 'success'],
    [String(maximum + 1), 'protocol'],
  ] as const)
    assert.equal(
      operation.parseResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body,
      }).kind,
      expected,
    );
  await writeFile(
    join(root, 'consumer.ts'),
    `
    import {operations} from './client.consumer.ts';
    export const send: typeof operations.roundTrip.build = operations.roundTrip.build;
    send({body: 2147483647});
    // @ts-expect-error Integer request types remain numeric.
    send({body: '1'});
  `,
  );
  const compilerOptions = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    types: [],
    declaration: true,
    emitDeclarationOnly: true,
    isolatedDeclarations: true,
    allowImportingTsExtensions: true,
    outDir: './declarations',
  };
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions, include: ['./*.ts'] }),
  );
  const tsc = fileURLToPath(
    new URL('../node_modules/typescript/bin/tsc', import.meta.url),
  );
  const exec = promisify(execFile);
  await exec(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')]);
  await writeFile(
    join(root, 'published.ts'),
    `
    import {send} from './declarations/consumer.js';
    send({body: -2147483648});
    // @ts-expect-error Published numeric input excludes strings.
    send({body: '1'});
  `,
  );
  await writeFile(
    join(root, 'published.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        types: [],
        noEmit: true,
      },
      include: ['./published.ts', './declarations/*.d.ts'],
    }),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'published.json')]);
});
