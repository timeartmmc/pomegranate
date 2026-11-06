import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { commandError } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import {
  minimumInt64String,
  maximumInt64String,
  numericFormatProfilesFixture as fixture,
  numericFormatProfilesSelection as selection,
  numericFormatProfilesConsumer,
  verifyNumericFormatProfiles,
} from './numeric-format-profiles-fixture.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

void test('numeric wire profiles preserve dialect/YAML bytes and source inputs', async () => {
  const expected = await compile(fixture(), selection);
  for (const modern of [true, false]) {
    const document = fixture(modern);
    const before = structuredClone(document);
    assert.deepEqual(await compile(document, selection), expected);
    assert.deepEqual(
      await compile(parseYaml(stringify(document), 'profiles.yaml'), selection),
      expected,
    );
    assert.deepEqual(document, before);
  }
});

void test('string int64 and numeric float/double profiles validate their wire values and generated types', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  const module = (name: string) =>
    importGenerated<StandaloneModule>(root, `standalone.${name}.ts`);
  verifyNumericFormatProfiles(
    await importGenerated<RuntimeClient>(root, 'client.consumer.ts'),
    await module('decimal'),
    await module('single'),
  );
  const decimal = await module('decimal');
  for (const value of [null, undefined, 0, 1n, true, {}, []])
    assert.equal(decimal.schema.safeParse(value).success, false);
  for (const name of ['decimalnull', 'singlenull'])
    assert.equal((await module(name)).schema.parse(null), null);
  assert.equal(
    (await module('decimalenum')).schema.parse(maximumInt64String),
    maximumInt64String,
  );
  assert.equal(
    (await module('decimalenum')).schema.safeParse('1').success,
    false,
  );
  assert.equal(
    (await module('singleenum')).schema.parse(3.4028235e38),
    3.4028235e38,
  );
  assert.equal(
    (await module('singleenum')).schema.safeParse(0.2).success,
    false,
  );
  const single = await module('single');
  for (const value of [null, '1', NaN, Infinity, -Infinity])
    assert.equal(single.schema.safeParse(value).success, false);
  const buffer = new DataView(new ArrayBuffer(4));
  const edge = 2 ** 128 - 2 ** 103;
  for (const value of [
    0.1,
    1e-50,
    3.4028235e38,
    3.40282356e38,
    edge,
    3.4028236e38,
    -3.4028235e38,
    -edge,
    -3.4028236e38,
  ]) {
    buffer.setFloat32(0, value);
    assert.equal(
      single.schema.safeParse(value).success,
      Number.isFinite(buffer.getFloat32(0)),
      String(value),
    );
  }
  await writeFile(join(root, 'consumer.ts'), numericFormatProfilesConsumer);
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        types: [],
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ['*.ts'],
    }),
  );
  try {
    await promisify(execFile)(process.execPath, [
      fileURLToPath(
        new URL('../node_modules/typescript/bin/tsc', import.meta.url),
      ),
      '-p',
      root,
    ]);
  } catch (error) {
    const failure = commandError(error);
    failure.message += failure.stdout + failure.stderr;
    throw failure;
  }
});

void test('string int64 full range agrees with independent bigint comparisons near signed boundaries', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  const decimal = await importGenerated<StandaloneModule>(
    root,
    'standalone.decimal.ts',
  );
  const low = BigInt(minimumInt64String),
    high = BigInt(maximumInt64String);
  for (const boundary of [low, high, 0n])
    for (let delta = -12n; delta <= 12n; delta++) {
      const value = boundary + delta;
      const text = value.toString();
      const padded = text.startsWith('-')
        ? `-000${text.slice(1)}`
        : `000${text}`;
      const expected = value >= low && value <= high;
      assert.equal(decimal.schema.safeParse(text).success, expected, text);
      assert.equal(decimal.schema.safeParse(padded).success, expected, padded);
    }
});

void test('numeric format references preserve string constraints and finite-float range restrictions', async (t) => {
  const document = fixture();
  Object.assign(document.components.schemas, {
    Positive: {
      $ref: '#/components/schemas/Decimal',
      pattern: '^[0-9]+$',
      minLength: 2,
      maxLength: 24,
    },
    Bounded: {
      $ref: '#/components/schemas/Float',
      minimum: -1,
      exclusiveMaximum: 1,
    },
  });
  const root = await generatedTestWorkspace(
    t,
    await compile(document, {
      ...selection,
      standalone: {
        positive: {
          schema: '#/components/schemas/Positive',
          usage: 'response',
        },
        bounded: { schema: '#/components/schemas/Bounded', usage: 'request' },
      },
    }),
  );
  const positive = await importGenerated<StandaloneModule>(
    root,
    'standalone.positive.ts',
  );
  for (const value of ['00', '42', maximumInt64String])
    assert.equal(positive.schema.parse(value), value);
  for (const value of ['0', '-42', '9223372036854775808'])
    assert.equal(positive.schema.safeParse(value).success, false);
  const bounded = await importGenerated<StandaloneModule>(
    root,
    'standalone.bounded.ts',
  );
  for (const value of [-1, 0.1, 0.999])
    assert.equal(bounded.schema.parse(value), value);
  for (const value of [-2, 1, 1e40])
    assert.equal(bounded.schema.safeParse(value).success, false);
});

void test('unknown numeric formats diagnose supported numeric formats before selection', async () => {
  for (const modern of [true, false])
    for (const nullable of [false, true])
      for (const [type, detail] of [
        [
          'number',
          'unsupported numeric format; number schemas support float or double',
        ],
        ['integer', 'unsupported integer format; expected int32 or int64'],
      ] as const) {
        const document = fixture(modern);
        document.components.schemas.Unused = {
          type: modern && nullable ? [type, 'null'] : type,
          ...(!modern && nullable ? { nullable: true } : {}),
          format: 'currency',
        };
        await assert.rejects(compile(document, selection), (error) => {
          assert.ok(error instanceof ContractError);
          assert.equal(error.location, 'components.schemas.Unused.format');
          assert.equal(error.message, `${error.location}: ${detail}`);
          return true;
        });
      }
});

void test('numeric profiles reject invalid literals, impossible intervals, wrong types and built-in overrides before selection', async () => {
  const cases: [Schema, RegExp][] = [
    [
      { type: 'string', format: 'int64', enum: ['9223372036854775808'] },
      /int64 format/,
    ],
    [
      { type: 'string', format: 'int64', enum: ['-9223372036854775809'] },
      /int64 format/,
    ],
    [{ type: 'number', format: 'float', enum: [3.4028236e38] }, /float format/],
    [{ type: 'number', format: 'float', minimum: 1e40 }, /no finite float32/],
    [{ type: 'number', format: 'float', maximum: -1e40 }, /no finite float32/],
    [
      { $ref: '#/components/schemas/Float', minimum: 1e40 },
      /no finite float32/,
    ],
    [{ type: 'string', format: 'float' }, /unsupported format/],
    [{ type: 'string', format: 'double' }, /unsupported format/],
    [{ type: 'integer', format: 'float' }, /unsupported integer format/],
    [{ type: 'number', format: 'int64' }, /unsupported numeric format/],
  ];
  for (const [schema, message] of cases) {
    const document = fixture();
    document.components.schemas['Unused'] = schema;
    await assert.rejects(compile(document, selection), message);
  }
  for (const name of ['int64', 'float', 'double'])
    await assert.rejects(
      compile(fixture(), {
        ...selection,
        formats: { [name]: { type: 'string', pattern: '.*' } },
      }),
      /built-in formats cannot be overridden/,
    );
  const document = fixture();
  Object.assign(document.components.schemas, {
    Narrowed: {
      $ref: '#/components/schemas/FloatEnum',
      minimum: 1,
      maximum: 2,
    },
  });
  await assert.rejects(
    compile(document, selection),
    /reference constraints admit no literal value/,
  );
  // Ordinary finite double values retain the existing JS-number profile.
  const baseline = fixture();
  baseline.components.schemas['Double'] = { type: 'number' };
  assert.deepEqual(
    await compile(fixture(), selection),
    await compile(baseline, selection),
  );
});
