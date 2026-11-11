import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compile, ContractError } from '../dist/index.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

function contract(schemas: Record<string, Schema>, openapi = '3.1.2') {
  return {
    openapi,
    info: { title: 'Synthetic composition normalization', version: '1' },
    paths: {},
    components: { schemas },
  };
}

const selection = (name: string) => ({
  clients: [],
  standalone: {
    request: { schema: ref(name).$ref, usage: 'request' as const },
    response: { schema: ref(name).$ref, usage: 'response' as const },
  },
});

function assertSourceLocation(document: unknown, location: string): void {
  let value = document;
  for (const name of location.match(/[^.[\]]+/g) ?? []) {
    assert.ok(value !== null && typeof value === 'object', location);
    assert.equal(Object.hasOwn(value, name), true, location);
    value = Reflect.get(value, name);
  }
}

async function typecheck(root: string, source: string) {
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
    root,
  ]);
}

void test('recomposing annotated scalar unions preserves canonical directional access through references', async (t) => {
  for (const annotation of ['readOnly', 'writeOnly'] as const) {
    const root = await generatedTestWorkspace(
      t,
      await compile(
        contract({
          Annotated: { type: 'string', minLength: 2, [annotation]: true },
          Combined: {
            allOf: [
              ref('Annotated'),
              {
                anyOf: [
                  { type: 'string', pattern: '^a' },
                  { type: 'string', pattern: '^b' },
                ],
              },
            ],
          },
          Reused: {
            allOf: [ref('Combined'), { type: 'string', maxLength: 3 }],
          },
          Holder: {
            type: 'object',
            properties: { value: ref('Reused') },
            required: ['value'],
          },
        }),
        selection('Holder'),
      ),
    );
    const request = (
      await importGenerated<StandaloneModule>(root, 'standalone.request.ts')
    ).schema;
    const response = (
      await importGenerated<StandaloneModule>(root, 'standalone.response.ts')
    ).schema;
    const visible = annotation === 'readOnly' ? response : request;
    assert.deepEqual(visible.parse({ value: 'aa' }), { value: 'aa' });
    for (const value of ['a', 'bbbb', 'cc', null])
      assert.equal(visible.safeParse({ value }).success, false);
    if (annotation === 'readOnly') {
      assert.deepEqual(request.parse({}), {});
      assert.equal(request.safeParse({ value: 'aa' }).success, false);
    } else {
      assert.equal(request.safeParse({}).success, false);
      assert.deepEqual(response.parse({ value: false }), {});
    }
    await typecheck(
      root,
      annotation === 'readOnly'
        ? `
import type { Output as Request } from './standalone.request.ts';
import type { Output as Response } from './standalone.response.ts';
export const request: Request = {};
export const response: Response = { value: 'aa' };
// @ts-expect-error Read-only input remains forbidden after recomposition.
export const invalid: Request = { value: 'aa' };
`
        : `
import type { Output as Request } from './standalone.request.ts';
import type { Output as Response } from './standalone.response.ts';
export const request: Request = { value: 'aa' };
export const response: Response = {};
// @ts-expect-error Write-only input stays required after recomposition.
export const invalid: Request = {};
`,
    );
  }
});

void test('nested single-reference allOf wrappers merge array bounds without losing uniqueness', async (t) => {
  for (const openapi of ['3.0.4', '3.1.2']) {
    const root = await generatedTestWorkspace(
      t,
      await compile(
        contract(
          {
            Codes: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
              uniqueItems: true,
            },
            Value: {
              allOf: [{ allOf: [ref('Codes')], minItems: 1 }],
              maxItems: 2,
            },
          },
          openapi,
        ),
        selection('Value'),
      ),
    );
    for (const usage of ['request', 'response']) {
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        `standalone.${usage}.ts`,
      );
      assert.deepEqual(schema.parse(['a', 'b']), ['a', 'b']);
      for (const value of [[], ['a', 'b', 'c'], ['a', 'a'], ['']])
        assert.equal(schema.safeParse(value).success, false);
    }
  }
});

void test('mixed-type literal assertions narrow allOf while explicit union contradictions remain diagnostic', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(
      contract({
        Status: { type: 'string' },
        Value: { allOf: [ref('Status')], enum: ['active', null] },
        Nullable: { type: ['string', 'null'] },
        Both: { allOf: [ref('Nullable')], enum: ['active', null] },
        Holder: {
          type: 'object',
          properties: { value: ref('Value'), both: ref('Both') },
          required: ['value', 'both'],
        },
      }),
      selection('Holder'),
    ),
  );
  for (const usage of ['request', 'response']) {
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      `standalone.${usage}.ts`,
    );
    for (const both of ['active', null])
      assert.deepEqual(schema.parse({ value: 'active', both }), {
        value: 'active',
        both,
      });
    for (const value of [null, 'other', 1])
      assert.equal(schema.safeParse({ value, both: null }).success, false);
    assert.equal(
      schema.safeParse({ value: 'active', both: 'other' }).success,
      false,
    );
  }
  await typecheck(
    root,
    `
import type { Output } from './standalone.request.ts';
export const valid: Output = { value: 'active', both: null };
// @ts-expect-error Intersection excludes the literal assertion's null member.
export const wrongType: Output = { value: null, both: 'active' };
// @ts-expect-error Literal narrowing survives composition.
export const wrongLiteral: Output = { value: 'other', both: null };
`,
  );
  await assert.rejects(
    compile(
      contract({
        Value: { allOf: [{ type: 'string' }], enum: [1, null] },
      }),
      selection('Value'),
    ),
    /allOf constraints admit no literal value/,
  );
  await assert.rejects(
    compile(
      contract({
        Value: {
          allOf: [
            { type: 'string' },
            { anyOf: [{ type: 'string' }, { type: 'null' }] },
          ],
        },
      }),
      selection('Value'),
    ),
    /incompatible scalar types/,
  );
});

void test('closed allOf branch diagnostics identify the actual required declaration', async () => {
  await assert.rejects(
    compile(
      contract({
        Value: {
          allOf: [
            { type: 'object' },
            {
              type: 'object',
              additionalProperties: false,
              required: ['missing'],
            },
          ],
        },
      }),
      selection('Value'),
    ),
    (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(
        error.location,
        'components.schemas.Value.allOf[1].required',
      );
      return true;
    },
  );
});

void test('finite literal assertions intersect by value and retain narrowing through nullable and composed aliases', async (t) => {
  for (const openapi of ['3.0.4', '3.1.2']) {
    const nullable: Schema = openapi.startsWith('3.0')
      ? { type: 'string', nullable: true }
      : { type: ['string', 'null'] };
    const schemas: Record<string, Schema> = {
      NullOnly: {
        allOf: [{ ...nullable, enum: ['ready', null] }],
        enum: ['active', null],
      },
      NumberOnly: { allOf: [{ enum: ['a', 1] }, { enum: ['b', 1] }] },
      Nullable: { allOf: [nullable], enum: ['active', null] },
      Active: { allOf: [ref('Nullable')], enum: ['active', 1] },
      Finite: { allOf: [{ enum: ['a', 1] }, { enum: ['a', 1] }] },
      Letter: { allOf: [ref('Finite'), { type: 'string' }] },
      NonNull: { allOf: [nullable], enum: ['active', 1] },
      TripleNumber: {
        allOf: [
          { enum: ['a', 'b', 1] },
          { enum: ['b', 'c', 1] },
          { enum: ['a', 'c', 1] },
        ],
      },
      ConstrainedNull: {
        allOf: [{ ...nullable, minLength: 2 }],
        enum: ['a', null],
      },
      Single: { allOf: [nullable], enum: ['active'] },
      OnlyNull: {
        allOf: [nullable],
        ...(openapi.startsWith('3.0') ? { enum: [null] } : { const: null }),
      },
    };
    const cases = [
      ['NullOnly', null, 'active'],
      ['NumberOnly', 1, 'a'],
      ['Active', 'active', null],
      ['Letter', 'a', 1],
      ['NonNull', 'active', 1],
      ['TripleNumber', 1, 'a'],
      ['ConstrainedNull', null, 'a'],
      ['Single', 'active', null],
      ['OnlyNull', null, 'active'],
    ] as const;
    const root = await generatedTestWorkspace(
      t,
      await compile(contract(schemas, openapi), {
        clients: [],
        standalone: Object.fromEntries(
          cases.map(([name]) => [
            name.toLowerCase(),
            { schema: ref(name).$ref, usage: 'request' as const },
          ]),
        ),
      }),
    );
    let consumer = '';
    for (const [name, expected, rejected] of cases) {
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        `standalone.${name.toLowerCase()}.ts`,
      );
      assert.equal(schema.parse(expected), expected);
      assert.equal(schema.safeParse(rejected).success, false);
      consumer += `import type { Output as ${name} } from './standalone.${name.toLowerCase()}.ts';
export const value${name}: ${name} = ${JSON.stringify(expected)};
// @ts-expect-error Finite intersection excludes the other literal.
export const wrong${name}: ${name} = ${JSON.stringify(rejected)};
`;
    }
    await typecheck(root, consumer);
  }
});

void test('composition diagnostics stay within real source declarations after distribution and merging', async () => {
  for (const schemas of [
    {
      Value: {
        allOf: [
          {
            type: 'object',
            properties: { a: { type: 'string' } },
            additionalProperties: false,
          },
          { required: ['b'] },
        ],
      },
    },
    {
      Choice: {
        anyOf: [
          { type: 'object', properties: { x: { type: 'string' } } },
          { type: 'object', properties: { x: { type: 'string' } } },
        ],
      },
      Base: {
        allOf: [
          ref('Choice'),
          { type: 'object', properties: { y: { type: 'string' } } },
        ],
      },
      Value: {
        allOf: [
          ref('Base'),
          { type: 'object', properties: { x: { type: 'integer' } } },
        ],
      },
    },
    {
      Value: {
        allOf: [
          { type: 'string' },
          { anyOf: [{ type: 'string' }, { type: 'null' }] },
        ],
      },
    },
    {
      Choice: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      Value: { allOf: [ref('Choice'), { type: 'string' }] },
    },
    {
      Value: { allOf: [{ type: 'boolean' }], enum: ['active', null] },
    },
    {
      Text: { type: 'string' },
      Value: {
        allOf: [{ ...ref('Text'), pattern: '^A' }],
        pattern: 'Z$',
        minItems: 1,
      },
    },
    {
      Value: {
        allOf: [
          {
            type: 'object',
            properties: { x: { type: 'string', minLength: 3 } },
          },
          {
            type: 'object',
            properties: { x: { type: 'string', maxLength: 2 } },
          },
        ],
      },
    },
    {
      Value: {
        allOf: [
          { type: 'object', properties: { x: { type: 'string' } } },
          { type: 'object', properties: { x: { type: 'integer' } } },
        ],
      },
    },
  ] satisfies Record<string, Schema>[]) {
    const document = contract(schemas);
    await assert.rejects(compile(document, selection('Value')), (error) => {
      assert.ok(error instanceof ContractError);
      assertSourceLocation(document, error.location);
      return true;
    });
  }
});
