import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import {
  toleranceFixture,
  toleranceSelection,
  toleranceConsumer,
  verifyTolerance,
} from './tolerance-fixture.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const int64 = { type: 'integer', format: 'int64' };
const minimum = Number.MIN_SAFE_INTEGER;
const maximum = Number.MAX_SAFE_INTEGER;
function document(schemas: Record<string, Schema>) {
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic numeric int64 contracts', version: '1' },
    paths: {},
    components: { schemas },
  };
}
const roots = {
  clients: [],
  standalone: {
    request: { schema: '#/components/schemas/Value', usage: 'request' },
    response: { schema: '#/components/schemas/Value', usage: 'response' },
  },
} as const;

void test('int64 lowers to safe-integer bounds and preserves JSON and YAML bytes', async () => {
  const input = document({ Value: int64 });
  assert.deepEqual(
    await compile(input, roots),
    await compile(
      document({ Value: { type: 'integer', minimum, maximum } }),
      roots,
    ),
  );
  const files = await compile(toleranceFixture(), toleranceSelection);
  const source = toleranceFixture();
  const before = structuredClone(source);
  assert.deepEqual(await compile(source, toleranceSelection), files);
  assert.deepEqual(source, before);
  assert.deepEqual(
    await compile(
      parseYaml(stringify(source), 'int64.yaml'),
      toleranceSelection,
    ),
    files,
  );
});

void test('numeric int64 validates safe integers at runtime and preserves generated types', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(toleranceFixture(), toleranceSelection),
  );
  verifyTolerance(
    await importGenerated<RuntimeClient>(root, 'client.consumer.ts'),
    await importGenerated<StandaloneModule>(root, 'standalone.int64.ts'),
  );
  await writeFile(join(root, 'consumer.ts'), toleranceConsumer);
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
        types: [],
        allowImportingTsExtensions: true,
        noEmit: true,
      },
      include: ['./*.ts'],
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

void test('int64 references narrow safe integers while ordinary integer schemas keep their existing range', async (t) => {
  const schemas: Record<string, Schema> = {
    Value: int64,
    Alias: { $ref: '#/components/schemas/Value' },
    Narrow: { $ref: '#/components/schemas/Alias', minimum: -2, maximum: 2 },
    Even: { $ref: '#/components/schemas/Narrow', multipleOf: 2 },
    Plain: { type: 'integer' },
    Nullable: { type: ['integer', 'null'], format: 'int64' },
    Literals: { ...int64, enum: [minimum, maximum] },
  };
  const standalone = Object.fromEntries(
    Object.keys(schemas).flatMap((name) =>
      (['request', 'response'] as const).map((usage) => [
        `${name.toLowerCase()}-${usage}`,
        { schema: `#/components/schemas/${name}`, usage },
      ]),
    ),
  );
  const root = await generatedTestWorkspace(
    t,
    await compile(document(schemas), { clients: [], standalone }),
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
    1n,
    '1',
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
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        `standalone.${name}-${usage}.ts`,
      );
      for (const sample of samples)
        assert.equal(
          schema.safeParse(sample).success,
          typeof sample === 'number' &&
            Number.isFinite(sample) &&
            Number.isInteger(sample) &&
            accepts(sample),
          `${name}/${usage}/${String(sample)}`,
        );
    }
    const { schema: plain } = await importGenerated<StandaloneModule>(
      root,
      `standalone.plain-${usage}.ts`,
    );
    assert.equal(plain.parse(maximum + 1), maximum + 1);
    const { schema: nullable } = await importGenerated<StandaloneModule>(
      root,
      `standalone.nullable-${usage}.ts`,
    );
    assert.equal(nullable.parse(null), null);
    assert.equal(nullable.parse(maximum), maximum);
    assert.equal(nullable.safeParse(maximum + 1).success, false);
  }
});

void test('int64 rejects unsafe literals and contradictory bounds before output selection', async () => {
  for (const schema of [
    { ...int64, enum: [0, maximum + 1] },
    { ...int64, enum: [minimum - 1] },
    { ...int64, const: 0.5 },
    { ...int64, minimum: maximum + 1 },
    { ...int64, maximum: minimum - 1 },
    { ...int64, exclusiveMinimum: maximum },
    { ...int64, exclusiveMaximum: minimum },
  ]) {
    const source = document({ Value: int64, Unused: schema });
    const before = structuredClone(source);
    await assert.rejects(compile(source, roots), (error) => {
      assert.ok(error instanceof ContractError);
      assert.match(error.location, /^components.schemas.Unused/);
      assert.match(error.message, /literal|bounds admit no/);
      return true;
    });
    assert.deepEqual(source, before);
  }
  for (const constraints of [
    { minimum: maximum + 1 },
    { minimum: minimum + 1, maximum: maximum - 1 },
  ])
    await assert.rejects(
      compile(
        document({
          Value: { ...int64, enum: [minimum, maximum] },
          Alias: { $ref: '#/components/schemas/Value' },
          Unused: { $ref: '#/components/schemas/Alias', ...constraints },
        }),
        roots,
      ),
      /bounds admit no|admit no literal/,
    );
});
