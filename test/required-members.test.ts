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
  await typecheckConsumer(
    root,
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
});

void test('declared maps keep every entry and require their listed keys through composition', async (t) => {
  for (const modern of [true, false])
    for (const additionalProperties of [true, {}]) {
      const openMap = { type: 'object', additionalProperties };
      for (const schema of [
        { ...openMap, required: ['id'] },
        { allOf: [openMap, { required: ['id'] }] },
        {
          allOf: [
            { additionalProperties },
            { type: 'object', required: ['id'] },
          ],
        },
        { allOf: [openMap], required: ['id'] },
        {
          allOf: [
            { $ref: '#/components/schemas/OpenMap' },
            { required: ['id'] },
          ],
        },
        // A declared map can itself arrive through a reference.
        {
          allOf: [
            { $ref: '#/components/schemas/OpenMap' },
            { ...openMap, required: ['id'] },
          ],
        },
      ]) {
        const document = fixture(modern);
        Object.assign(document.components.schemas, {
          Only: schema,
          OpenMap: openMap,
        });
        const root = await generatedTestWorkspace(
          t,
          await compile(document, selection),
        );
        const schemas = await importGenerated<Schemas>(
          root,
          'client.client.schemas.ts',
        );
        const value = { id: { any: [1, null] }, unlisted: true, 10: null };
        for (const validator of [
          present(schemas.requestSchemas.Only),
          present(schemas.responseSchemas.Only),
        ]) {
          assert.deepEqual(validator.parse(value), value);
          for (const invalid of [
            {},
            { unlisted: true },
            { ...value, id: undefined },
            { ...value, id: () => true },
            Object.defineProperty({ unlisted: true }, 'id', { value: 1 }),
          ])
            assert.equal(validator.safeParse(invalid).success, false);
        }
      }
    }
});

void test('required map keys are named members of generated types and typed map values', async (t) => {
  for (const modern of [true, false]) {
    const document = fixture(modern);
    Object.assign(document.components.schemas, {
      Need: { type: 'object', required: ['id'] },
      Only: {
        allOf: [
          { type: 'object', additionalProperties: true },
          { $ref: '#/components/schemas/Need' },
        ],
      },
      Neutral: {
        type: 'object',
        additionalProperties: { type: 'integer' },
        required: ['total', 'a-b'],
        minProperties: 3,
      },
    });
    const root = await generatedTestWorkspace(
      t,
      await compile(document, selection),
    );
    const { requestSchemas, responseSchemas } = await importGenerated<Schemas>(
      root,
      'client.client.schemas.ts',
    );
    const counts = { total: 3, 'a-b': 1, other: 2 };
    for (const schemas of [requestSchemas, responseSchemas]) {
      const typed = present(schemas.Neutral);
      assert.deepEqual(typed.parse(counts), counts);
      for (const invalid of [
        { total: 3, other: 2, more: 1 },
        { ...counts, total: 'three' },
        { ...counts, other: 'two' },
        { total: 3, 'a-b': 1 },
      ])
        assert.equal(typed.safeParse(invalid).success, false);
    }
    await typecheckConsumer(
      root,
      `
      import { operations } from './client.client.ts';
      import type { RequestTypes, ResponseTypes } from './client.client.ts';
      import { responseSchemas } from './client.client.schemas.ts';
      import type { JsonValue } from './runtime.ts';
      const map: RequestTypes['Only'] = { id: 1, unlisted: [true] };
      const id: JsonValue = map.id;
      // @ts-expect-error The required key cannot be omitted.
      const missing: ResponseTypes['Only'] = { unlisted: 1 };
      const typed: ResponseTypes['Neutral'] = { total: 1, 'a-b': 2, other: 3 };
      const total: number = typed.total;
      // @ts-expect-error Required keys share the map's value type.
      const wrong: RequestTypes['Neutral'] = { total: '1', 'a-b': 2 };
      // @ts-expect-error Every listed key is required.
      const partial: RequestTypes['Neutral'] = { total: 1 };
      const parsed: ResponseTypes['Only'] = responseSchemas.Only.parse({ id: 1 });
      operations.sendOnly.build({ body: { id: null, more: 'entries' } });
      // @ts-expect-error A request without the required key does not type check.
      operations.sendOnly.build({ body: { more: 'entries' } });
      void [id, missing, total, wrong, partial, parsed];
    `,
    );
  }
});

void test('required-map composition agrees for inline branches and aliases', async (t) => {
  for (const modern of [true, false]) {
    const need: Schema = { type: 'object', required: ['id'] };
    const needOther: Schema = { type: 'object', required: ['other'] };
    for (const branch of [need, { $ref: '#/components/schemas/NeedAlias' }]) {
      const document = fixture(modern);
      Object.assign(document.components.schemas, {
        Need: need,
        NeedAlias: { $ref: '#/components/schemas/Need' },
        NeedOther: needOther,
        Only: {
          allOf: [
            { type: 'object', additionalProperties: true, maxProperties: 3 },
            branch,
            { $ref: '#/components/schemas/NeedOther' },
          ],
        },
      });
      const root = await generatedTestWorkspace(
        t,
        await compile(document, selection),
      );
      const schemas = await importGenerated<Schemas>(
        root,
        'client.client.schemas.ts',
      );
      for (const validator of [
        present(schemas.requestSchemas.Only),
        present(schemas.responseSchemas.Only),
      ]) {
        const value = { id: 1, other: true, retained: { nested: 'value' } };
        assert.deepEqual(validator.parse(value), value);
        for (const invalid of [
          { other: true },
          { id: 1 },
          { ...value, fourth: 4 },
        ])
          assert.equal(validator.safeParse(invalid).success, false);
      }
    }
  }
});

void test('required-map checks stop observing input when the issue budget is exhausted', async (t) => {
  const document = fixture();
  document.components.schemas.Only = {
    type: 'object',
    additionalProperties: { type: 'string' },
    required: Array.from({ length: 1_000 }, (_, index) => `field${index}`),
  };
  const root = await generatedTestWorkspace(
    t,
    await compile(document, selection),
  );
  const schemas = await importGenerated<Schemas>(
    root,
    'client.client.schemas.ts',
  );
  for (const validator of [
    present(schemas.requestSchemas.Only),
    present(schemas.responseSchemas.Only),
  ]) {
    let descriptors = 0;
    let keys = 0;
    const input = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          descriptors++;
          return undefined;
        },
        ownKeys() {
          keys++;
          return [];
        },
      },
    );
    const result = validator.safeParse(input);
    assert.equal(result.success, false);
    assert.equal(descriptors, 100);
    assert.equal(keys, 0);
  }
});

void test('closed objects and unusable names keep their required diagnostics', async () => {
  // Raw records: some cases are deliberately malformed schemas.
  const rejects = async (
    schema: Record<string, unknown>,
    location: string,
    message: RegExp,
  ) => {
    for (const modern of [true, false]) {
      const document = fixture(modern);
      document.components.schemas.Invalid = schema;
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
    '.allOf[1].required',
    /unknown property "extra"$/,
  );
  await rejects(
    { allOf: [{ $ref: '#/components/schemas/Mixed' }, closed] },
    '.allOf',
    /allOf property "10" is forbidden by branch-local additionalProperties: false/,
  );
  // Declared properties are fixed fields, which a typed map cannot hold.
  await rejects(
    {
      type: 'object',
      properties: { extra: { type: 'string' } },
      additionalProperties: { type: 'string' },
      required: ['extra'],
    },
    '.additionalProperties',
    /mixed fixed properties and typed dynamic maps are unsupported$/,
  );
  // A closed branch forbids the key a composed map requires.
  await rejects(
    {
      allOf: [
        closed,
        { type: 'object', additionalProperties: true, required: ['extra'] },
      ],
    },
    '.allOf[1].required',
    /unknown property "extra"$/,
  );
  // Typed maps still cannot be intersected with other object assertions.
  await rejects(
    {
      allOf: [
        { type: 'object', additionalProperties: { type: 'string' } },
        { required: ['extra'] },
      ],
    },
    '.allOf',
    /cannot combine objects with scalars, arrays, typed maps or binary schemas$/,
  );
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
