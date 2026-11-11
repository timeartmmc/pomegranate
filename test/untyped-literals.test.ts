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
import type { Validator } from '../src/runtime.ts';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { Schema } from './schema-helpers.ts';

// Each untyped schema beside the typed spelling it stands for. `modern`
// entries need 3.1 syntax; the null alternative has a 3.0 spelling of its own.
const nullOnly = (modern: boolean): Schema =>
  modern ? { type: 'null' } : { type: 'string', nullable: true, enum: [null] };
const equivalents = (
  modern: boolean,
): Record<string, [untyped: Schema, typed: Schema]> => ({
  Text: [
    { enum: ['ready', 'done'] },
    { type: 'string', enum: ['ready', 'done'] },
  ],
  Whole: [{ enum: [1, 2] }, { type: 'integer', enum: [1, 2] }],
  Fraction: [{ enum: [1, 2.5] }, { type: 'number', enum: [1, 2.5] }],
  Flag: [{ enum: [true] }, { type: 'boolean', enum: [true] }],
  Nothing: [{ enum: [null] }, nullOnly(modern)],
  Annotated: [
    { enum: ['a'], description: 'One value', default: 'a', deprecated: true },
    {
      type: 'string',
      enum: ['a'],
      description: 'One value',
      default: 'a',
      deprecated: true,
    },
  ],
  // One alternative per JSON type, in order of first appearance.
  Mixed: [
    { enum: ['a', 1, null, 'b', 2.5, false] },
    {
      anyOf: [
        { type: 'string', enum: ['a', 'b'] },
        { type: 'number', enum: [1, 2.5] },
        nullOnly(modern),
        { type: 'boolean', enum: [false] },
      ],
    },
  ],
  // The literals restrict a referenced type like any other allOf member.
  Narrowed: [
    { allOf: [{ $ref: '#/components/schemas/Text' }], enum: ['done'] },
    {
      allOf: [
        { $ref: '#/components/schemas/Text' },
        { type: 'string', enum: ['done'] },
      ],
    },
  ],
  ...(modern
    ? {
        Constant: [{ const: 'fixed' }, { type: 'string', const: 'fixed' }],
        Zero: [{ const: 0 }, { type: 'integer', const: 0 }],
        NullConstant: [{ const: null }, { type: 'null' }],
      }
    : {}),
});

function fixture(modern: boolean, typed: boolean) {
  const schemas = Object.fromEntries(
    Object.entries(equivalents(modern)).map(([name, forms]) => [
      name,
      forms[typed ? 1 : 0],
    ]),
  );
  const content = (name: string) => ({
    'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
  });
  return {
    openapi: modern ? '3.1.2' : '3.0.4',
    info: { title: 'Synthetic untyped literals', version: '1' },
    components: { schemas },
    paths: {
      '/echo': {
        post: {
          operationId: 'echo',
          parameters: [
            {
              name: 'mode',
              in: 'query',
              // A parameter needs a primitive: one literal type qualifies.
              schema: typed
                ? { type: 'string', enum: ['fast', 'safe'] }
                : { enum: ['fast', 'safe'] },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: Object.fromEntries(
                    Object.keys(schemas).map((name) => [
                      name,
                      { $ref: `#/components/schemas/${name}` },
                    ]),
                  ),
                },
              },
            },
          },
          responses: {
            200: { description: 'Echo', content: content('Mixed') },
          },
        },
      },
    },
  };
}

const selection = { clients: ['client'], surfaces: { client: ['echo'] } };

void test('enum and const without a type generate their typed spelling in both dialects and YAML', async () => {
  for (const modern of [true, false]) {
    const expected = await compile(fixture(modern, true), selection);
    const document = fixture(modern, false);
    const before = structuredClone(document);
    assert.deepEqual(await compile(document, selection), expected);
    assert.deepEqual(document, before);
    assert.deepEqual(
      await compile(parseYaml(stringify(document), 'literals.yaml'), selection),
      expected,
    );
  }
});

void test('untyped literals accept exactly their values and type each alternative', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(true, false), selection),
  );
  const { requestSchemas } = await importGenerated<{
    requestSchemas: Record<string, Validator<unknown>>;
  }>(root, 'client.client.schemas.ts');
  const samples: Record<string, [accepted: unknown[], rejected: unknown[]]> = {
    Text: [
      ['ready', 'done'],
      ['other', '', null, 1, ['ready']],
    ],
    Whole: [
      [1, 2],
      [3, 1.5, '1', null, true],
    ],
    Fraction: [
      [1, 2.5],
      [2, '2.5', null],
    ],
    Flag: [[true], [false, 1, 'true', null]],
    Nothing: [[null], [0, '', false, undefined]],
    Mixed: [
      ['a', 'b', 1, 2.5, null, false],
      ['c', 2, true, '1', 0, [], {}, undefined],
    ],
    Narrowed: [['done'], ['ready', null]],
    Constant: [['fixed'], ['other', null]],
    Zero: [
      [0, -0],
      ['0', false, null, 1],
    ],
    NullConstant: [[null], [0, '']],
  };
  for (const [name, [accepted, rejected]] of Object.entries(samples)) {
    const schema = present(requestSchemas[name]);
    for (const value of accepted)
      assert.equal(schema.parse(value), value, `${name} ${String(value)}`);
    for (const value of rejected)
      assert.equal(
        schema.safeParse(value).success,
        false,
        `${name} ${String(value)}`,
      );
  }
  await writeFile(
    join(root, 'consumer.ts'),
    `
    import { operations } from './client.client.ts';
    import type { RequestTypes } from './client.client.ts';
    const mixed: RequestTypes['Mixed'][] = ['a', 'b', 1, 2.5, null, false];
    // @ts-expect-error Only the listed string values are accepted.
    const text: RequestTypes['Mixed'] = 'c';
    // @ts-expect-error Only the listed boolean value is accepted.
    const flag: RequestTypes['Mixed'] = true;
    const whole: 1 | 2 = 1 as RequestTypes['Whole'];
    const constant: 'fixed' = 'fixed' as RequestTypes['Constant'];
    const nothing: null = null as RequestTypes['Nothing'];
    operations.echo.build({ query: { mode: 'fast' }, body: { Text: 'ready' } });
    // @ts-expect-error The parameter accepts only its listed values.
    operations.echo.build({ query: { mode: 'slow' }, body: {} });
    void [mixed, text, flag, whole, constant, nothing];
  `,
  );
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        allowImportingTsExtensions: true,
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

void test('untyped literals stay scalar and alone, and other untyped assertions stay rejected', async () => {
  const rejects = async (
    schema: Record<string, unknown>,
    location: string,
    message: RegExp,
    dialects = [true, false],
  ) => {
    for (const modern of dialects) {
      const document = fixture(modern, false);
      Object.assign(document.components.schemas, { Invalid: schema });
      await assert.rejects(compile(document, selection), (error) => {
        assert.ok(error instanceof ContractError, JSON.stringify(schema));
        assert.equal(error.location, `components.schemas.Invalid${location}`);
        assert.match(error.message, message, JSON.stringify(schema));
        return true;
      });
    }
  };
  const scalar =
    /enum and const values must be strings, finite numbers, booleans or null$/;
  await rejects({ enum: ['a', {}] }, '', scalar);
  await rejects({ enum: [[1]] }, '', scalar);
  await rejects({ const: { a: 1 } }, '', scalar, [true]);
  await rejects({ enum: [] }, '.enum', /expected a nonempty array$/);
  await rejects({ enum: 'a' }, '.enum', /expected a nonempty array$/);
  await rejects({ enum: ['a', 'a'] }, '', /duplicate literal$/);
  await rejects(
    { enum: ['a'], const: 'a' },
    '',
    /const and enum together are unsupported$/,
    [true],
  );
  // Only a declared type says which values another assertion constrains.
  const alone =
    /enum and const fix the type only on their own; declare a type beside this keyword$/;
  await rejects({ enum: ['a'], minLength: 1 }, '.minLength', alone);
  await rejects({ enum: [1], minimum: 0 }, '.minimum', alone);
  await rejects({ enum: ['2020-01-01'], format: 'date' }, '.format', alone);
  await rejects(
    { enum: ['a'], properties: {} },
    '.properties',
    /unsupported keyword/,
  );
  // 3.0 keeps its own rules for the keywords it does not define.
  await rejects(
    { enum: ['a', null], nullable: true },
    '.nullable',
    /nullable: true requires an explicit type in the same schema$/,
    [false],
  );
  await rejects(
    { const: 'a' },
    '.const',
    /unsupported OpenAPI 3\.0 schema keyword$/,
    [false],
  );
  for (const schema of [{ minimum: 1 }, { maxLength: 3 }, { items: {} }])
    await rejects(schema, '.type', /implicit types are unsupported$/);
});
