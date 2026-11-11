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

// With `declared`, every required member also has an empty schema, the
// spelling that required-only members stand for.
function fixture(modern = true, declared = false) {
  const any = (...names: string[]): Record<string, Schema> =>
    declared ? Object.fromEntries(names.map((name) => [name, {}])) : {};
  const schemas: Record<string, Schema> = {
    Mixed: {
      type: 'object',
      properties: { name: { type: 'string' }, ...any('extra', '10') },
      required: ['name', 'extra', '10'],
    },
    Only: {
      type: 'object',
      ...(declared ? { properties: any('id') } : {}),
      required: ['id'],
    },
    Composed: {
      allOf: [
        { $ref: '#/components/schemas/Mixed' },
        {
          ...(declared ? { properties: any('stamp') } : {}),
          required: ['stamp', 'name'],
        },
      ],
    },
    // A bare object assertion is neutral beside the required member.
    Neutral: {
      allOf: [
        { type: 'object' },
        { ...(declared ? { properties: any('id') } : {}), required: ['id'] },
      ],
    },
  };
  const content = (name: string) => ({
    'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
  });
  return {
    openapi: modern ? '3.1.2' : '3.0.4',
    info: { title: 'Synthetic required members', version: '1' },
    components: { schemas },
    paths: Object.fromEntries(
      Object.keys(schemas).map((name) => [
        `/${name.toLowerCase()}`,
        {
          post: {
            operationId: `send${name}`,
            requestBody: { required: true, content: content(name) },
            responses: { 200: { description: 'Echo', content: content(name) } },
          },
        },
      ]),
    ),
  };
}

const selection = {
  clients: ['client'],
  surfaces: {
    client: ['sendMixed', 'sendOnly', 'sendComposed', 'sendNeutral'],
  },
};

void test('a required member without a properties entry generates a required field of any JSON value', async () => {
  for (const modern of [true, false]) {
    const expected = await compile(fixture(modern, true), selection);
    const document = fixture(modern);
    const before = structuredClone(document);
    assert.deepEqual(await compile(document, selection), expected);
    assert.deepEqual(document, before);
    assert.deepEqual(
      await compile(parseYaml(stringify(document), 'required.yaml'), selection),
      expected,
    );
  }
});

interface Schemas {
  requestSchemas: Record<string, Validator<unknown>>;
  responseSchemas: Record<string, Validator<unknown>>;
}

void test('required-only members must be present, hold any JSON value and survive response parsing', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  const { requestSchemas, responseSchemas } = await importGenerated<Schemas>(
    root,
    'client.client.schemas.ts',
  );
  const cases: [string, Record<string, unknown>, string[]][] = [
    [
      'Mixed',
      { name: 'n', extra: { nested: [1, null] }, 10: false },
      ['10', 'extra'],
    ],
    ['Only', { id: null }, ['id']],
    ['Neutral', { id: [] }, ['id']],
    [
      'Composed',
      { name: 'n', extra: 0, 10: '', stamp: [] },
      ['10', 'extra', 'stamp'],
    ],
  ];
  for (const [name, value, members] of cases)
    for (const schemas of [requestSchemas, responseSchemas]) {
      const schema = present(schemas[name]);
      assert.deepEqual(schema.parse(value), value, name);
      for (const member of members) {
        const { [member]: _, ...missing } = value;
        assert.equal(schema.safeParse(missing).success, false, member);
        // A required member has to be present as JSON, not merely named.
        assert.equal(
          schema.safeParse({ ...value, [member]: undefined }).success,
          false,
          member,
        );
      }
      // The declared sibling keeps its own schema beside the open members.
      if ('name' in value)
        assert.equal(schema.safeParse({ ...value, name: 1 }).success, false);
    }
  // These remain fixed objects: requests reject other members and responses
  // strip them, while every required member is kept.
  for (const [name, value] of cases) {
    const extended = { ...value, unlisted: true };
    assert.equal(
      present(requestSchemas[name]).safeParse(extended).success,
      false,
    );
    assert.deepEqual(present(responseSchemas[name]).parse(extended), value);
  }
  await writeFile(
    join(root, 'consumer.ts'),
    `
    import { operations } from './client.client.ts';
    import type { RequestTypes, ResponseTypes } from './client.client.ts';
    import type { JsonValue } from './runtime.ts';
    const mixed: RequestTypes['Mixed'] = { name: 'n', extra: [1, { a: null }], 10: null };
    const extra: JsonValue = mixed.extra;
    // @ts-expect-error The required member cannot be omitted.
    const missing: RequestTypes['Mixed'] = { name: 'n', 10: 1 };
    // @ts-expect-error Undefined is not a JSON value.
    const absent: RequestTypes['Only'] = { id: undefined };
    // @ts-expect-error Other members are not part of the fixed object.
    const unlisted: RequestTypes['Only'] = { id: 1, other: 2 };
    const composed: ResponseTypes['Composed'] = { name: 'n', extra: 1, 10: 2, stamp: 'x' };
    const name: string = composed.name;
    // @ts-expect-error Any JSON value is not known to be a string.
    const stamp: string = composed.stamp;
    operations.sendOnly.build({ body: { id: { any: 'json' } } });
    void [extra, missing, absent, unlisted, name, stamp];
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

void test('closed objects and unusable names keep their required diagnostics', async () => {
  // Raw records: some cases are deliberately malformed schemas.
  const rejects = async (
    schema: Record<string, unknown>,
    location: string,
    message: RegExp,
    components: Record<string, Schema> = {},
  ) => {
    for (const modern of [true, false]) {
      const document = fixture(modern);
      Object.assign(document.components.schemas, components, {
        Invalid: schema,
      });
      await assert.rejects(compile(document, selection), (error) => {
        assert.ok(error instanceof ContractError, location);
        assert.equal(error.location, `components.schemas.Invalid${location}`);
        assert.match(error.message, message, location);
        return true;
      });
    }
  };
  const closed = {
    type: 'object',
    additionalProperties: false,
    properties: { name: { type: 'string' } },
  };
  // additionalProperties: false forbids the member that required demands.
  await rejects(
    { ...closed, required: ['name', 'extra'] },
    '.required',
    /unknown property "extra"$/,
  );
  await rejects(
    { type: 'object', additionalProperties: false, required: ['extra'] },
    '.required',
    /unknown property "extra"$/,
  );
  await rejects(
    { allOf: [closed, { required: ['extra'] }] },
    '.allOf.required',
    /unknown property "extra"$/,
  );
  await rejects(
    { allOf: [{ $ref: '#/components/schemas/Mixed' }, closed] },
    '.allOf',
    /allOf property "10" is forbidden by branch-local additionalProperties: false/,
  );
  // A typed map has no fixed members to require.
  await rejects(
    {
      type: 'object',
      additionalProperties: { type: 'string' },
      required: ['extra'],
    },
    '.additionalProperties',
    /mixed fixed properties and dynamic maps are unsupported$/,
  );
  // An explicit map keeps its entries. Composing it with a required name is
  // the same mixture as the direct declaration, not a fixed object that would
  // reject or strip every other entry.
  const mixed = /mixed fixed properties and dynamic maps are unsupported$/;
  await rejects(
    { type: 'object', additionalProperties: true, required: ['extra'] },
    '.additionalProperties',
    mixed,
  );
  const openMap = { type: 'object', additionalProperties: true };
  for (const schema of [
    { allOf: [openMap, { required: ['extra'] }] },
    {
      allOf: [
        { additionalProperties: true },
        { type: 'object', required: ['extra'] },
      ],
    },
    { allOf: [openMap], required: ['extra'] },
    {
      allOf: [
        { $ref: '#/components/schemas/OpenMap' },
        { required: ['extra'] },
      ],
    },
    {
      allOf: [
        { $ref: '#/components/schemas/OpenMap' },
        { $ref: '#/components/schemas/Only' },
      ],
    },
  ])
    await rejects(schema, '.allOf', mixed, { OpenMap: openMap });
  for (const [name, message] of [
    ['__proto__', /unsupported object key "__proto__"$/],
    ['constructor', /unsupported object key "constructor"$/],
    ['toString', /Object\.prototype property names are unsupported/],
  ] as const)
    await rejects(
      { type: 'object', properties: { name: {} }, required: [name] },
      '.required',
      message,
    );
  await rejects(
    { type: 'object', required: ['extra', 'extra'] },
    '.required',
    /duplicate required property$/,
  );
  await rejects(
    { type: 'object', required: ['extra', 1] },
    '.required',
    /expected an array of property names$/,
  );
});
