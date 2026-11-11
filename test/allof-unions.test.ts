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

const fixed = (
  properties: Record<string, Schema>,
  required: readonly string[] = [],
  extra: Schema = {},
): Schema => ({
  type: 'object',
  properties,
  // OpenAPI 3.0 rejects an empty required list.
  ...(required.length ? { required: [...required] } : {}),
  ...extra,
});

function contract(openapi: string, schemas: Record<string, Schema>) {
  return {
    openapi,
    info: { title: 'Synthetic allOf unions', version: '1' },
    paths: {},
    components: {
      schemas: {
        A: fixed(
          { kind: { type: 'string', enum: ['a'] }, a: { type: 'integer' } },
          ['kind', 'a'],
        ),
        B: fixed(
          { kind: { type: 'string', enum: ['b'] }, b: { type: 'string' } },
          ['kind', 'b'],
        ),
        Tagged: {
          oneOf: [ref('A'), ref('B')],
          discriminator: {
            propertyName: 'kind',
            mapping: {
              a: '#/components/schemas/A',
              b: '#/components/schemas/B',
            },
          },
        },
        ...schemas,
      },
    },
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
        noUnusedLocals: true,
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

void test('allOf distributes shared fields over tagged and anyOf unions in OpenAPI 3.0 and 3.1', async (t) => {
  for (const openapi of ['3.0.3', '3.1.2']) {
    const shared = fixed({ id: { type: 'string' } }, ['id']);
    const root = await generatedTestWorkspace(
      t,
      await compile(
        contract(openapi, {
          Record: { allOf: [ref('Tagged'), shared] },
          Either: {
            allOf: [
              {
                anyOf: [
                  fixed({ p: { type: 'integer' } }, ['p']),
                  fixed({ q: { type: 'integer' } }, ['q']),
                ],
              },
              ref('Tagged'),
            ],
          },
          Holder: fixed({
            value: {
              allOf: [ref('Tagged'), fixed({}, [], { readOnly: true })],
            },
            label: { type: 'string' },
          }),
        }),
        {
          clients: [],
          standalone: Object.fromEntries(
            ['Record', 'Either', 'Holder'].flatMap((name) =>
              (['request', 'response'] as const).map((usage) => [
                `${name.toLowerCase()}-${usage}`,
                { schema: ref(name).$ref, usage },
              ]),
            ),
          ),
        },
      ),
    );
    const load = async (name: string) =>
      (await importGenerated<StandaloneModule>(root, `standalone.${name}.ts`))
        .schema;
    const record = await load('record-request');
    assert.deepEqual(record.parse({ kind: 'a', a: 1, id: 'x' }), {
      a: 1,
      id: 'x',
      kind: 'a',
    });
    assert.deepEqual(record.parse({ kind: 'b', b: 's', id: 'y' }), {
      b: 's',
      id: 'y',
      kind: 'b',
    });
    for (const value of [
      { kind: 'a', a: 1 },
      { kind: 'a', b: 's', id: 'x' },
      { kind: 'c', id: 'x' },
    ])
      assert.equal(record.safeParse(value).success, false);
    assert.deepEqual(
      (await load('record-response')).parse({
        kind: 'a',
        a: 1,
        id: 'x',
        b: 'stripped',
      }),
      { a: 1, id: 'x', kind: 'a' },
    );
    // Untagged unions distribute outside tagged ones, which keep dispatching.
    const either = await load('either-request');
    assert.deepEqual(either.parse({ q: 1, kind: 'b', b: 's' }), {
      b: 's',
      kind: 'b',
      q: 1,
    });
    assert.equal(either.safeParse({ p: 1, kind: 'b', a: 1 }).success, false);
    // A root annotation from one conjunct applies to the whole union.
    const holder = await load('holder-request');
    assert.deepEqual(holder.parse({ label: 'x' }), { label: 'x' });
    assert.equal(
      holder.safeParse({ label: 'x', value: { kind: 'a', a: 1 } }).success,
      false,
    );
    assert.deepEqual(
      (await load('holder-response')).parse({ value: { kind: 'b', b: 's' } }),
      { value: { b: 's', kind: 'b' } },
    );
    await typecheckConsumer(
      root,
      `import type { Output } from './standalone.record-request.ts';
export function describe(value: Output): string {
  return value.kind === 'a' ? value.id + value.a : value.id + value.b;
}
// @ts-expect-error The shared required field reaches every tagged branch.
export const missing: Output = { kind: 'a', a: 1 };
`,
    );
  }
});

void test('scalar union composition applies conjunct access annotations to the whole property through aliases', async (t) => {
  for (const openapi of ['3.0.4', '3.1.2'])
    for (const annotation of ['readOnly', 'writeOnly'] as const) {
      const value: Schema = {
        allOf: [
          {
            anyOf: [
              { type: 'string', pattern: '^a' },
              { type: 'string', pattern: '^b' },
            ],
          },
          {
            type: 'string',
            minLength: 2,
            maxLength: 4,
            [annotation]: true,
          },
        ],
      };
      const root = await generatedTestWorkspace(
        t,
        await compile(
          contract(openapi, {
            Value: value,
            Alias: {
              ...ref('Value'),
              ...(openapi.startsWith('3.1') ? { [annotation]: false } : {}),
            },
            AliasAgain: ref('Alias'),
            Holder: fixed(
              {
                label: { type: 'string' },
                inline: value,
                alias: ref('AliasAgain'),
              },
              ['label', 'inline', 'alias'],
            ),
          }),
          {
            clients: [],
            standalone: {
              request: { schema: ref('Holder').$ref, usage: 'request' },
              response: { schema: ref('Holder').$ref, usage: 'response' },
            },
          },
        ),
      );
      const load = async (direction: string) =>
        (
          await importGenerated<StandaloneModule>(
            root,
            `standalone.${direction}.ts`,
          )
        ).schema;
      const request = await load('request');
      const response = await load('response');
      const full = { label: 'visible', inline: 'aa', alias: 'bbb' };
      const visible = annotation === 'readOnly' ? response : request;
      assert.deepEqual(visible.parse(full), full);
      for (const key of ['inline', 'alias'])
        for (const bad of ['a', 'bbbbb', 'cc', 5])
          assert.equal(
            visible.safeParse({ ...full, [key]: bad }).success,
            false,
          );
      if (annotation === 'readOnly') {
        assert.deepEqual(request.parse({ label: 'visible' }), {
          label: 'visible',
        });
        for (const key of ['inline', 'alias'])
          assert.equal(
            request.safeParse({ label: 'visible', [key]: 'aa' }).success,
            false,
          );
      } else {
        assert.equal(request.safeParse({ label: 'visible' }).success, false);
        assert.deepEqual(
          response.parse({ label: 'visible', inline: 5, alias: false }),
          { label: 'visible' },
        );
      }
      await typecheckConsumer(
        root,
        annotation === 'readOnly'
          ? `import type { Output as Request } from './standalone.request.ts';
import type { Output as Response } from './standalone.response.ts';
export const request: Request = { label: 'visible' };
export const response: Response = { label: 'visible', inline: 'aa', alias: 'bbb' };
// @ts-expect-error A read-only field remains forbidden through an alias.
export const forbidden: Request = { label: 'visible', alias: 'aa' };
// @ts-expect-error Read-only fields remain required in responses.
export const missing: Response = { label: 'visible' };
`
          : `import type { Output as Request } from './standalone.request.ts';
import type { Output as Response } from './standalone.response.ts';
export const request: Request = { label: 'visible', inline: 'aa', alias: 'bbb' };
export const response: Response = { label: 'visible' };
// @ts-expect-error Write-only fields remain required in requests.
export const missing: Request = { label: 'visible' };
// @ts-expect-error A write-only field is absent from the response type.
export const excluded = response.alias;
`,
      );
    }
});

void test('allOf union distribution diagnoses contradictions, untagged object oneOf and constrained union references', async () => {
  for (const [name, schema, location, message] of [
    [
      'contradictory alternative',
      {
        allOf: [
          { anyOf: [{ type: 'string' }, { type: 'integer' }] },
          { type: 'string', maxLength: 3 },
        ],
      },
      'components.schemas.Value.allOf[0].anyOf[1]',
      /incompatible scalar types/,
    ],
    [
      'conflicting tag',
      {
        allOf: [
          ref('Tagged'),
          fixed({ kind: { type: 'string', enum: ['z'] } }),
        ],
      },
      'components.schemas.Tagged.oneOf[0].$ref',
      /admit no literal value/,
    ],
    [
      'untagged object oneOf',
      {
        allOf: [
          {
            oneOf: [
              fixed({ a: { type: 'integer' } }, ['a']),
              fixed({ b: { type: 'integer' } }, ['b']),
            ],
          },
          fixed({ id: { type: 'string' } }),
        ],
      },
      'components.schemas.Value',
      /disjoint JSON types; several accept object values/,
    ],
    [
      'constrained union reference',
      {
        allOf: [
          { $ref: '#/components/schemas/Tagged', maxProperties: 3 },
          fixed({ id: { type: 'string' } }),
        ],
      },
      'components.schemas.Value.allOf[0].$ref',
      /constraints on a union reference are unsupported/,
    ],
  ] satisfies [string, Schema, string, RegExp][]) {
    await assert.rejects(
      compile(contract('3.1.2', { Value: schema }), {
        clients: [],
        standalone: { a: { schema: ref('A').$ref, usage: 'request' } },
      }),
      (error) => {
        assert.ok(error instanceof ContractError, name);
        assert.equal(error.location, location, name);
        assert.match(error.message, message, name);
        return true;
      },
    );
  }
});

void test('allOf distribution keeps unsupported annotations on union alternatives visible', async () => {
  for (const openapi of ['3.0.4', '3.1.2'])
    for (const annotation of ['readOnly', 'writeOnly'] as const)
      for (const scalar of [false, true])
        for (const inline of [false, true]) {
          const annotated: Schema = scalar
            ? { type: 'string', minLength: 1, [annotation]: true }
            : fixed({ a: { type: 'integer' } }, [], { [annotation]: true });
          const input = contract(openapi, {
            Annotated: annotated,
            Plain: scalar
              ? { type: 'string' }
              : fixed({ b: { type: 'integer' } }),
            Value: {
              allOf: [
                {
                  anyOf: [inline ? annotated : ref('Annotated'), ref('Plain')],
                },
                scalar
                  ? { type: 'string', maxLength: 4 }
                  : fixed({ common: { type: 'integer' } }),
              ],
            },
          });
          await assert.rejects(
            compile(input, {
              clients: [],
              standalone: {
                value: { schema: ref('Value').$ref, usage: 'request' },
              },
            }),
            /readOnly and writeOnly on union branches are not supported/,
          );
        }
});
