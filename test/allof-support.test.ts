import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { entry, present, record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';
import type { Validator } from '../src/runtime.ts';

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

const selection = {
  clients: ['consumer'],
  surfaces: { consumer: ['save'] },
  standalone: {
    request: { schema: '#/components/schemas/Combined', usage: 'request' },
    response: { schema: '#/components/schemas/Combined', usage: 'response' },
  },
} as const;

function document(schemas: Record<string, Schema>) {
  const content = { 'application/json': { schema: ref('Combined') } };
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic allOf composition', version: '1' },
    components: { schemas },
    paths: {
      '/records': {
        post: {
          operationId: 'save',
          requestBody: { required: true, content },
          responses: { 200: { description: 'Validated record', content } },
        },
      },
    },
  };
}

function commonSchemas(): Record<string, Schema> {
  return {
    Code: { type: 'string', minLength: 2, pattern: '^A' },
    Alias: { allOf: [ref('Code')] },
    Base: {
      type: 'object',
      properties: {
        code: ref('Alias'),
        reference: ref('Alias'),
        count: { type: 'number', minimum: 0, maximum: 12, multipleOf: 2 },
        details: {
          type: 'object',
          properties: { left: { type: 'integer', minimum: 1 } },
          required: ['left'],
        },
      },
      required: ['code', 'count', 'details'],
    },
    Combined: {
      allOf: [
        ref('Base'),
        {
          properties: {
            code: { type: 'string', maxLength: 3, pattern: 'Z$' },
            count: { type: 'integer', minimum: 1, multipleOf: 3 },
            details: {
              type: 'object',
              properties: { right: { type: 'string', minLength: 1 } },
              required: ['right'],
            },
          },
          required: ['count'],
        },
      ],
      properties: {
        tags: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
      required: ['tags'],
    },
  };
}
const value = () => ({
  code: 'ABZ',
  count: 6,
  details: { left: 1, right: 'r' },
  tags: ['tag'],
});

void test('identical component references can redeclare inherited container and union properties', async (t) => {
  const cases: readonly { shape: Schema; valid: unknown; invalid: unknown }[] =
    [
      {
        shape: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          minItems: 1,
          uniqueItems: true,
        },
        valid: ['a'],
        invalid: ['a', 'a'],
      },
      {
        shape: {
          type: 'object',
          additionalProperties: { type: 'integer', minimum: 0 },
        },
        valid: { key: 1 },
        invalid: { key: -1 },
      },
      {
        shape: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
        valid: null,
        invalid: '',
      },
      {
        shape: {
          anyOf: [
            { type: 'string', minLength: 1 },
            { type: 'integer', minimum: 0 },
          ],
        },
        valid: 2,
        invalid: false,
      },
      {
        shape: {
          type: 'object',
          properties: {
            value: { type: 'integer', minimum: 0 },
            next: ref('Tag'),
          },
          required: ['value'],
        },
        valid: { value: 1, next: { value: 2 } },
        invalid: { value: -1 },
      },
    ];
  for (const openapi of ['3.0.4', '3.1.2'])
    for (const { shape, valid, invalid } of cases) {
      const schemas = {
        Tag:
          valid === null
            ? openapi.startsWith('3.0.')
              ? { type: 'string', nullable: true, minLength: 1 }
              : { type: ['string', 'null'], minLength: 1 }
            : shape,
        TagAlias: ref('Tag'),
        Base: {
          type: 'object',
          properties: { tags: ref('TagAlias') },
          required: ['tags'],
        },
        Combined: {
          allOf: [
            ref('Base'),
            { type: 'object', properties: { tags: ref('TagAlias') } },
          ],
        },
      };
      const input = { ...document(schemas), openapi };
      const before = structuredClone(input);
      const files = await compile(input, selection);
      assert.deepEqual(input, before);
      const simplified = {
        ...document({
          ...schemas,
          Combined: { allOf: [ref('Base'), { type: 'object' }] },
        }),
        openapi,
      };
      assert.deepEqual(files, await compile(simplified, selection));
      const root = await generatedTestWorkspace(t, files);
      const client = await importGenerated<RuntimeClient>(
        root,
        'client.consumer.ts',
      );
      for (const usage of ['request', 'response']) {
        const { schema } = await importGenerated<StandaloneModule>(
          root,
          `standalone.${usage}.ts`,
        );
        assert.deepEqual(schema.parse({ tags: valid }), { tags: valid });
        assert.equal(schema.safeParse({ tags: invalid }).success, false);
      }
      const operation = entry(client.operations, 'save');
      assert.deepEqual(operation.build({ body: { tags: valid } }).body, {
        tags: valid,
      });
      const response = operation.parseResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tags: valid }),
      });
      assert.equal(response.kind, 'success');
      if (response.kind === 'success')
        assert.deepEqual(response.data, { tags: valid });
    }
});

void test('reference idempotence preserves constraints and access annotations', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(
      document({
        Text: { type: 'string' },
        Prefix: { $ref: '#/components/schemas/Text', pattern: '^a' },
        Both: { $ref: '#/components/schemas/Prefix', pattern: 'z$' },
        Suffix: { $ref: '#/components/schemas/Text', pattern: 'z$' },
        Combined: { allOf: [ref('Suffix'), ref('Both'), ref('Both')] },
      }),
      selection,
    ),
  );
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.request.ts',
  );
  assert.equal(schema.parse('az'), 'az');
  for (const value of ['z', 'a'])
    assert.equal(schema.safeParse(value).success, false);

  const directional = await generatedTestWorkspace(
    t,
    await compile(
      document({
        Tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
        Combined: {
          type: 'object',
          properties: {
            tags: { allOf: [ref('Tags'), { ...ref('Tags'), readOnly: true }] },
          },
          required: ['tags'],
        },
      }),
      selection,
    ),
  );
  const request = (
    await importGenerated<StandaloneModule>(
      directional,
      'standalone.request.ts',
    )
  ).schema;
  const response = (
    await importGenerated<StandaloneModule>(
      directional,
      'standalone.response.ts',
    )
  ).schema;
  assert.deepEqual(request.parse({}), {});
  assert.equal(request.safeParse({ tags: ['x'] }).success, false);
  assert.deepEqual(response.parse({ tags: ['x'] }), { tags: ['x'] });
  assert.equal(response.safeParse({ tags: [] }).success, false);

  const pure = ref('Tags');
  const constrained = { ...pure, minItems: 2 };
  for (const branches of [
    [pure, constrained],
    [constrained, pure],
  ])
    await assert.rejects(
      compile(
        document({
          Tags: { type: 'array', items: { type: 'string' } },
          Combined: { allOf: branches },
        }),
        selection,
      ),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.match(error.message, /combined arrays/);
        return true;
      },
    );
});

void test('allOf folds object branches and sibling declarations without losing reference identity or mutating JSON/YAML inputs', async (t) => {
  const input = document(commonSchemas());
  const before = structuredClone(input);
  const outputs = await compile(input, selection);
  assert.deepEqual(input, before);
  assert.deepEqual(
    await compile(parseYaml(stringify(input), 'allof.yaml'), selection),
    outputs,
  );
  const openapi30 = structuredClone(input);
  openapi30.openapi = '3.0.4';
  assert.deepEqual(await compile(openapi30, selection), outputs);
  assert.deepEqual(
    await compile(parseYaml(stringify(openapi30), 'allof30.yaml'), selection),
    outputs,
  );
  const root = await generatedTestWorkspace(t, outputs);
  const schemas = await importGenerated<{
    requestSchemas: Record<string, Validator<unknown>>;
    responseSchemas: Record<string, Validator<unknown>>;
  }>(root, 'client.consumer.schemas.ts');
  for (const table of [schemas.requestSchemas, schemas.responseSchemas]) {
    assert.ok(Object.hasOwn(table, 'Alias'));
    assert.ok(Object.hasOwn(table, 'Code'));
    assert.equal(entry(table, 'Alias'), entry(table, 'Code'));
  }
});

void test('generated allOf requests, responses and standalone validators agree with independent conjunctive validation', async (t) => {
  const schemas = commonSchemas();
  const input = document(schemas);
  const root = await generatedTestWorkspace(t, await compile(input, selection));
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const request = await importGenerated<StandaloneModule>(
    root,
    'standalone.request.ts',
  );
  const response = await importGenerated<StandaloneModule>(
    root,
    'standalone.response.ts',
  );
  const operation = present(client.operations.save);
  const oracle = new Ajv2020({
    strict: true,
    strictTypes: false,
    keywords: ['components'],
  }).compile({
    components: { schemas },
    $ref: '#/components/schemas/Combined',
  });
  const samples: [unknown, boolean][] = [
    [value(), true],
    [{ ...value(), reference: 'AX' }, true],
    [{ ...value(), code: 'XBZ' }, false],
    [{ ...value(), code: 'AB' }, false],
    [{ ...value(), code: 'AZZZ' }, false],
    [{ ...value(), code: 'Z' }, false],
    [{ ...value(), count: 3 }, false],
    [{ ...value(), count: 4 }, false],
    [{ ...value(), count: 6.5 }, false],
    [{ ...value(), count: 18 }, false],
    [{ ...value(), details: { left: 1 } }, false],
    [{ ...value(), details: { right: 'r' } }, false],
    [{ ...value(), details: { left: 0, right: 'r' } }, false],
    [{ ...value(), details: { left: 1, right: '' } }, false],
    [{ ...value(), tags: [''] }, false],
    [null, false],
  ];
  for (const missing of ['code', 'count', 'details', 'tags']) {
    const absent = { ...value() };
    Reflect.deleteProperty(absent, missing);
    samples.push([absent, false]);
  }
  for (const [sample, expected] of samples) {
    assert.equal(
      oracle(sample),
      expected,
      `Independent source validation: ${JSON.stringify(sample)}`,
    );
    assert.equal(request.schema.safeParse(sample).success, expected);
    assert.equal(response.schema.safeParse(sample).success, expected);
    if (expected)
      assert.deepEqual(operation.build({ body: sample }).body, sample);
    else
      assert.throws(
        () => operation.build({ body: sample }),
        client.RequestValidationError,
      );
    const observed = operation.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sample),
    });
    assert.equal(observed.kind, expected ? 'success' : 'protocol');
    if (observed.kind === 'success') assert.deepEqual(observed.data, sample);
  }
});

void test('composed objects detach nested values and apply existing strict-request and stripped-response behavior once', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(document(commonSchemas()), selection),
  );
  const { operations, RequestValidationError } =
    await importGenerated<RuntimeClient>(root, 'client.consumer.ts');
  const operation = present(operations.save);
  const input = value();
  const built = operation.build({ body: input });
  assert.deepEqual(built.body, input);
  const output = record(built.body);
  assert.notEqual(output, input);
  assert.notEqual(output.details, input.details);
  assert.notEqual(output.tags, input.tags);
  input.details.left = 9;
  input.tags.push('later');
  assert.deepEqual(built.body, value());
  assert.throws(
    () => operation.build({ body: { ...value(), extra: true } }),
    RequestValidationError,
  );
  const response = await importGenerated<StandaloneModule>(
    root,
    'standalone.response.ts',
  );
  const observed = {
    ...value(),
    extra: true,
    details: { ...value().details, extra: true },
  };
  const parsed = response.schema.parse(observed);
  assert.deepEqual(parsed, value());
  assert.notEqual(record(parsed).details, observed.details);
});

void test('overlapping scalar assertions evaluate a stable field value rather than accepting incompatible getter results', async (t) => {
  const input = document({
    Combined: {
      allOf: [
        {
          type: 'object',
          properties: { code: { type: 'string', pattern: '^[A-Z]+$' } },
          required: ['code'],
        },
        { properties: { code: { type: 'string', maxLength: 1 } } },
      ],
    },
  });
  const root = await generatedTestWorkspace(t, await compile(input, selection));
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.request.ts',
  );
  let reads = 0;
  const unstable = {
    get code() {
      return ++reads === 1 ? 'AB' : 'a';
    },
  };
  assert.equal(schema.safeParse(unstable).success, false);
  assert.deepEqual(schema.parse({ code: 'A' }), { code: 'A' });
});

void test('scalar allOf keeps independent patterns, enums, bounds, multiples and integer semantics', async (t) => {
  const cases: { schema: Schema; samples: [unknown, boolean][] }[] = [
    {
      schema: {
        allOf: [
          { type: 'string', enum: ['AB', 'AZ', 'AZZ'], pattern: '^A' },
          { type: 'string', maxLength: 2, pattern: 'Z$' },
        ],
      },
      samples: [
        ['AZ', true],
        ['AB', false],
        ['AZZ', false],
        ['BZ', false],
        [null, false],
        [1, false],
      ],
    },
    {
      schema: {
        allOf: [
          { type: 'number', minimum: 0, multipleOf: 2 },
          { type: 'integer', maximum: 8, multipleOf: 3 },
        ],
      },
      samples: [
        [0, true],
        [6, true],
        [2, false],
        [3, false],
        [6.5, false],
        [9, false],
        [-6, false],
        ['6', false],
      ],
    },
  ];
  for (const { schema, samples } of cases) {
    const root = await generatedTestWorkspace(
      t,
      await compile(document({ Combined: schema }), selection),
    );
    const request = await importGenerated<StandaloneModule>(
      root,
      'standalone.request.ts',
    );
    const response = await importGenerated<StandaloneModule>(
      root,
      'standalone.response.ts',
    );
    const oracle = new Ajv2020({ strict: true, strictTypes: false }).compile(
      schema,
    );
    for (const [sample, expected] of samples) {
      assert.equal(oracle(sample), expected);
      assert.equal(request.schema.safeParse(sample).success, expected);
      assert.equal(response.schema.safeParse(sample).success, expected);
      if (expected) assert.equal(request.schema.parse(sample), sample);
    }
  }
});

void test('readOnly and writeOnly annotations accumulate through allOf aliases before directional projection', async (t) => {
  const input = document({
    Id: { type: 'string', minLength: 1, readOnly: true },
    IdAlias: { allOf: [ref('Id')], readOnly: false },
    Secret: { type: 'string', minLength: 1, writeOnly: true },
    SecretAlias: { allOf: [ref('Secret')], writeOnly: false },
    Base: {
      type: 'object',
      properties: {
        id: ref('IdAlias'),
        secret: ref('SecretAlias'),
        label: { type: 'string' },
      },
      required: ['id', 'secret', 'label'],
    },
    Combined: {
      allOf: [
        ref('Base'),
        { properties: { count: { type: 'integer' } }, required: ['count'] },
      ],
    },
  });
  const root = await generatedTestWorkspace(t, await compile(input, selection));
  const request = await importGenerated<StandaloneModule>(
    root,
    'standalone.request.ts',
  );
  const response = await importGenerated<StandaloneModule>(
    root,
    'standalone.response.ts',
  );
  const supplied = { secret: 'private', label: 'visible', count: 1 };
  assert.deepEqual(request.schema.parse(supplied), supplied);
  assert.equal(
    request.schema.safeParse({ ...supplied, id: 'forbidden' }).success,
    false,
  );
  assert.equal(
    request.schema.safeParse({ label: 'visible', count: 1 }).success,
    false,
  );
  const observed = { id: 'record-id', label: 'visible', count: 1 };
  assert.deepEqual(
    response.schema.parse({ ...observed, secret: false }),
    observed,
  );
  assert.equal(
    response.schema.safeParse({ label: 'visible', count: 1 }).success,
    false,
  );
  await typecheckConsumer(
    root,
    `
    import {operations} from './client.consumer.ts';
    import type {RequestTypes, ResponseTypes} from './client.consumer.ts';
    const input: RequestTypes['Combined'] = {secret:'private',label:'visible',count:1};
    const output: ResponseTypes['Combined'] = {id:'record-id',label:'visible',count:1};
    operations.save.build({body:input});
    // @ts-expect-error Read-only fields remain forbidden through a composed alias.
    operations.save.build({body:{...input,id:'forbidden'}});
    // @ts-expect-error Required input fields from the base remain required.
    const missingSecret: RequestTypes['Combined'] = {label:'visible',count:1};
    // @ts-expect-error Required sibling fields remain required.
    const missingCount: RequestTypes['Combined'] = {secret:'private',label:'visible'};
    // @ts-expect-error Write-only fields do not enter response types.
    const leaked: ResponseTypes['Combined'] = {...output,secret:'private'};
    void [output,missingSecret,missingCount,leaked];
  `,
  );
});

void test('closed object conjuncts remain supported when each closed declaration covers the complete property set', async (t) => {
  const input = document({
    Combined: {
      allOf: [
        {
          type: 'object',
          properties: { code: { type: 'string' }, count: { type: 'integer' } },
          required: ['code'],
          additionalProperties: false,
        },
        {
          properties: {
            code: { type: 'string', minLength: 1 },
            count: { type: 'integer', minimum: 1 },
          },
          required: ['count'],
        },
      ],
    },
  });
  const root = await generatedTestWorkspace(t, await compile(input, selection));
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.request.ts',
  );
  assert.deepEqual(schema.parse({ code: 'A', count: 1 }), {
    code: 'A',
    count: 1,
  });
  assert.equal(schema.safeParse({ code: '', count: 1 }).success, false);
  assert.equal(
    schema.safeParse({ code: 'A', count: 1, extra: true }).success,
    false,
  );
  const response = await importGenerated<StandaloneModule>(
    root,
    'standalone.response.ts',
  );
  assert.deepEqual(
    response.schema.parse({ code: 'A', count: 1, extra: true }),
    {
      code: 'A',
      count: 1,
    },
  );
});

void test('required-only conjuncts and outer required lists can name fields declared by another object conjunct', async (t) => {
  const input = document({
    Base: {
      type: 'object',
      properties: { id: { type: 'string' }, label: { type: 'string' } },
    },
    Combined: {
      allOf: [ref('Base'), { required: ['id'] }],
      required: ['label'],
    },
  });
  const root = await generatedTestWorkspace(t, await compile(input, selection));
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.request.ts',
  );
  assert.deepEqual(schema.parse({ id: 'id', label: 'visible' }), {
    id: 'id',
    label: 'visible',
  });
  assert.equal(schema.safeParse({ id: 'id' }).success, false);
  assert.equal(schema.safeParse({ label: 'visible' }).success, false);
});

void test('object count bounds from every conjunct apply before response fields are stripped', async (t) => {
  const input = document({
    Combined: {
      allOf: [
        {
          properties: { left: { type: 'integer' }, right: { type: 'integer' } },
          minProperties: 1,
        },
        { type: 'object', maxProperties: 1 },
      ],
    },
  });
  const root = await generatedTestWorkspace(t, await compile(input, selection));
  for (const name of ['request', 'response']) {
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      `standalone.${name}.ts`,
    );
    assert.deepEqual(schema.parse({ left: 1 }), { left: 1 });
    assert.equal(schema.safeParse({}).success, false);
    assert.equal(schema.safeParse({ left: 1, right: 2 }).success, false);
    assert.equal(schema.safeParse({ left: 1, extra: true }).success, false);
  }
});

const sparse: Schema[] = [];
sparse.length = 1;
const invalid: readonly [string, Schema, RegExp][] = [
  ['empty branches', { allOf: [] }, /allOf.*nonempty|allOf.*at least/],
  ['non-array branches', { allOf: {} }, /allOf.*array/],
  ['null branch', { allOf: [null] }, /allOf\[0\].*object/],
  ['sparse branch', { allOf: sparse }, /allOf\[0\].*object/],
  [
    'missing reference',
    { allOf: [ref('Missing')] },
    /unresolved reference Missing/,
  ],
  [
    'array intersection',
    {
      allOf: [
        { type: 'array', items: { type: 'string' } },
        { type: 'array', items: { type: 'string' } },
      ],
    },
    /allOf.*array|allOf.*fixed.object|allOf.*unsupported/,
  ],
  [
    'mixed object and scalar',
    {
      allOf: [{ properties: { id: { type: 'integer' } } }, { type: 'string' }],
    },
    /allOf.*unsupported|allOf.*incompatible|allOf.*cannot combine/,
  ],
  [
    'closed branch extended elsewhere',
    {
      allOf: [
        {
          type: 'object',
          properties: { id: { type: 'integer' } },
          additionalProperties: false,
        },
        { properties: { label: { type: 'string' } } },
      ],
    },
    /additionalProperties|closed/,
  ],
  [
    'open mixed fixed properties',
    {
      allOf: [
        {
          type: 'object',
          properties: { id: { type: 'integer' } },
          additionalProperties: true,
        },
        { properties: { label: { type: 'string' } } },
      ],
    },
    /additionalProperties|dynamic maps/,
  ],
  [
    'unknown branch assertion',
    { allOf: [{}, { type: 'string', not: { type: 'null' } }] },
    /not.*unsupported keyword/,
  ],
  [
    'untyped object fragments without an object conjunct',
    {
      allOf: [
        { properties: { id: { type: 'integer' } } },
        { properties: { label: { type: 'string' } } },
      ],
    },
    /explicit type: object/,
  ],
  [
    'contradictory access annotations',
    {
      allOf: [
        { type: 'string', readOnly: true },
        { type: 'string', writeOnly: true },
      ],
    },
    /readOnly and writeOnly cannot both be true/,
  ],
  [
    'contradictory scalar bounds',
    {
      allOf: [
        { type: 'number', minimum: 2 },
        { type: 'number', maximum: 1 },
      ],
    },
    /bounds admit no finite number/,
  ],
  [
    'empty scalar literal intersection',
    {
      allOf: [
        { type: 'string', enum: ['A', 'B'] },
        { type: 'string', enum: ['C'] },
      ],
    },
    /admit no literal value/,
  ],
  [
    'untyped scalar branch',
    { allOf: [ref('Combined'), { maxLength: 3 }] },
    /allOf members without object keywords require an explicit type/,
  ],
  [
    'nullable type beside object branches',
    {
      type: ['object', 'null'],
      allOf: [{ type: 'object', properties: { id: { type: 'integer' } } }],
    },
    /nullable type.*outer anyOf with a null-only branch/,
  ],
];
for (const [name, schema, message] of invalid) {
  void test(`unsupported allOf ${name} diagnoses before selection`, async () => {
    const input = document({ Combined: { type: 'string' }, Unused: schema });
    const before = structuredClone(input);
    await assert.rejects(compile(input, selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.match(error.location, /^components\.schemas\.Unused/);
      assert.match(error.message, message);
      return true;
    });
    assert.deepEqual(input, before);
  });
}

void test('allOf component cycles diagnose without recursive traversal or silently dropping operations', async () => {
  const input = document({
    Combined: { allOf: [ref('Other')] },
    Other: { allOf: [ref('Combined')] },
  });
  await assert.rejects(compile(input, selection), /cycl|recurs/);
});

void test('deep allOf composition through recursive components stops with a diagnostic before the call stack', async () => {
  const count = 2000;
  // Dependency order starts mid-cycle, so composition must resolve members
  // that are not yet composed, structurally or at the same value.
  const name = (index: number) =>
    `N${String((index + count / 2) % count).padStart(4, '0')}`;
  for (const sameValue of [false, true]) {
    const schemas: Record<string, Schema> = { Combined: { type: 'string' } };
    for (let index = 0; index < count - 1; index++) {
      const composed = {
        allOf: [
          ref(name(index + 1)),
          { type: 'object', properties: { [`p${index}`]: { type: 'string' } } },
        ],
      };
      schemas[name(index)] = sameValue
        ? composed
        : { type: 'object', properties: { next: composed } };
    }
    schemas[name(count - 1)] = {
      type: 'object',
      properties: { back: ref(name(0)) },
    };
    await assert.rejects(compile(document(schemas), selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.match(
        error.message,
        /allOf composition exceeds the supported limit of 256 nested schemas/,
      );
      return true;
    });
  }
});

void test('allOf sibling constraints restrict one referenced value in OpenAPI 3.0 and 3.1', async (t) => {
  for (const openapi of ['3.0.3', '3.1.2']) {
    const contract = (schemas: Record<string, Schema>) => ({
      openapi,
      info: { title: 'Synthetic constrained allOf references', version: '1' },
      paths: {},
      components: {
        schemas: {
          Code: { type: 'string', pattern: '^A' },
          Fixed: { type: 'object', properties: { id: { type: 'integer' } } },
          ...schemas,
        },
      },
    });
    await assert.rejects(
      compile(
        contract({
          Nullable: {
            ...(openapi === '3.0.3'
              ? { type: 'object', nullable: true }
              : { type: ['object', 'null'] }),
            allOf: [ref('Fixed')],
          },
        }),
        {
          clients: [],
          standalone: {
            fixed: { schema: ref('Fixed').$ref, usage: 'request' },
          },
        },
      ),
      /nullable type.*outer anyOf with a null-only branch/,
    );
    const input = contract({
      Short: { allOf: [ref('Code')], maxLength: 2, pattern: 'Z$' },
      Codes: { type: 'array', items: ref('Code') },
      Pair: { allOf: [ref('Codes')], maxItems: 2 },
    });
    const root = await generatedTestWorkspace(
      t,
      await compile(input, {
        clients: [],
        standalone: {
          short: { schema: ref('Short').$ref, usage: 'request' },
          pair: { schema: ref('Pair').$ref, usage: 'request' },
        },
      }),
    );
    const [short, pair] = await Promise.all(
      ['short', 'pair'].map(
        async (name) =>
          (
            await importGenerated<StandaloneModule>(
              root,
              `standalone.${name}.ts`,
            )
          ).schema,
      ),
    );
    assert.equal(present(short).parse('AZ'), 'AZ');
    for (const value of ['AZZ', 'BZ', 'AB'])
      assert.equal(present(short).safeParse(value).success, false);
    assert.deepEqual(present(pair).parse(['A1', 'A2']), ['A1', 'A2']);
    for (const value of [['A1', 'A2', 'A3'], ['B1']])
      assert.equal(present(pair).safeParse(value).success, false);
  }
});

void test('oversized unused scalar composition graphs receive an actionable compilation limit', async () => {
  const schemas: Record<string, Schema> = {
    Combined: { type: 'string' },
    S0: { type: 'string', minLength: 1 },
  };
  for (let index = 1; index < 1800; index++)
    schemas[`S${index}`] = {
      allOf: [ref(`S${index - 1}`), { type: 'string', maxLength: 10000 }],
    };
  await assert.rejects(compile(document(schemas), selection), (error) => {
    assert.ok(error instanceof ContractError);
    assert.match(
      error.message,
      /schema nesting exceeds.*128|allOf composition work exceeds.*1000000/,
    );
    assert.match(error.message, /reduce/);
    return true;
  });
});

void test('composed discriminator literals agree across runtime validation and request/response type narrowing', async (t) => {
  const input = document({
    A: {
      type: 'object',
      properties: {
        kind: {
          allOf: [
            { type: 'string', enum: ['a', 'b'] },
            { type: 'string', pattern: '^a$' },
          ],
        },
        a: { type: 'string' },
      },
      required: ['kind', 'a'],
    },
    B: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['b'] },
        b: { type: 'integer' },
      },
      required: ['kind', 'b'],
    },
    Combined: {
      oneOf: [ref('A'), ref('B')],
      discriminator: {
        propertyName: 'kind',
        mapping: { a: '#/components/schemas/A', b: '#/components/schemas/B' },
      },
    },
  });
  const root = await generatedTestWorkspace(t, await compile(input, selection));
  const { operations, RequestValidationError } =
    await importGenerated<RuntimeClient>(root, 'client.consumer.ts');
  const operation = present(operations.save);
  for (const sample of [
    { kind: 'a', a: 'alpha' },
    { kind: 'b', b: 1 },
  ]) {
    assert.deepEqual(operation.build({ body: sample }).body, sample);
    const parsed = operation.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sample),
    });
    assert.equal(parsed.kind, 'success');
    if (parsed.kind === 'success') assert.deepEqual(parsed.data, sample);
  }
  for (const sample of [
    { kind: 'b', a: 'alpha' },
    { kind: 'a', b: 1 },
  ]) {
    assert.throws(
      () => operation.build({ body: sample }),
      RequestValidationError,
    );
    assert.equal(
      operation.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sample),
      }).kind,
      'protocol',
    );
  }
  await typecheckConsumer(
    root,
    `
    import {operations} from './client.consumer.ts';
    import type {RequestTypes, ResponseTypes} from './client.consumer.ts';
    import {scalarIntersection, stringValue} from './runtime.ts';
    import type {Parse} from './runtime.ts';
    function requestBranch(input: RequestTypes['Combined']) {
      if (input.kind === 'b') { const value: number = input.b; return value; }
      const value: string = input.a; return value;
    }
    function responseBranch(output: ResponseTypes['Combined']) {
      if (output.kind === 'b') { const value: number = output.b; return value; }
      const value: string = output.a; return value;
    }
    // @ts-expect-error The allOf tag is narrowed by every scalar assertion.
    operations.save.build({body:{kind:'b',a:'alpha'}});
    // @ts-expect-error Response branches retain the same narrowed tag.
    const wrong: ResponseTypes['Combined'] = {kind:'b',a:'alpha'};
    const text: Parse<string> = scalarIntersection(stringValue, []);
    // @ts-expect-error The return type must follow the base parser's output.
    const number: Parse<number> = scalarIntersection(stringValue, []);
    void [requestBranch, responseBranch, wrong, text, number];
  `,
  );
});

void test('open empty object conjuncts preserve arbitrary JSON fields and apply property bounds', async (t) => {
  for (const open of [{ type: 'object' }, { type: 'object', properties: {} }]) {
    const input = document({
      Combined: { allOf: [open, { minProperties: 1 }] },
    });
    const root = await generatedTestWorkspace(
      t,
      await compile(input, selection),
    );
    const request = await importGenerated<StandaloneModule>(
      root,
      'standalone.request.ts',
    );
    const response = await importGenerated<StandaloneModule>(
      root,
      'standalone.response.ts',
    );
    const client = await importGenerated<RuntimeClient>(
      root,
      'client.consumer.ts',
    );
    const value = { arbitrary: { nested: [1, true, null] }, text: 'preserved' };
    for (const schema of [request.schema, response.schema]) {
      const parsed = schema.parse(value);
      assert.deepEqual(parsed, value);
      assert.notEqual(parsed, value);
      assert.notEqual(record(parsed).arbitrary, value.arbitrary);
      assert.equal(schema.safeParse({}).success, false);
      assert.equal(schema.safeParse({ invalid: () => true }).success, false);
    }
    const operation = present(client.operations.save);
    assert.deepEqual(operation.build({ body: value }).body, value);
    const parsed = operation.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    assert.equal(parsed.kind, 'success');
    if (parsed.kind === 'success') assert.deepEqual(parsed.data, value);
    await typecheckConsumer(
      root,
      `
      import {operations} from './client.consumer.ts';
      import type {RequestTypes, ResponseTypes} from './client.consumer.ts';
      const input: RequestTypes['Combined'] = {arbitrary:{nested:[1,true,null]},text:'preserved'};
      const output: ResponseTypes['Combined'] = input;
      operations.save.build({body:input});
      // @ts-expect-error Open object values still require valid JSON.
      const invalid: RequestTypes['Combined'] = {invalid:()=>true};
      void [output,invalid];
    `,
    );
  }
});

void test('closed empty objects and directionally emptied fixed objects retain their declared field boundary', async (t) => {
  for (const fixed of [
    { type: 'object', additionalProperties: false },
    {
      type: 'object',
      properties: { id: { type: 'string', readOnly: true } },
      required: ['id'],
    },
  ]) {
    const root = await generatedTestWorkspace(
      t,
      await compile(document({ Combined: { allOf: [fixed, {}] } }), selection),
    );
    const request = await importGenerated<StandaloneModule>(
      root,
      'standalone.request.ts',
    );
    const response = await importGenerated<StandaloneModule>(
      root,
      'standalone.response.ts',
    );
    assert.deepEqual(request.schema.parse({}), {});
    assert.equal(request.schema.safeParse({ extra: true }).success, false);
    assert.equal(request.schema.safeParse({ id: 'forbidden' }).success, false);
    const observed = { id: 'server', extra: true };
    assert.deepEqual(
      response.schema.parse(observed),
      'properties' in fixed ? { id: 'server' } : {},
    );
  }
});

void test('shared scalar ancestry is checked once while independent patterns, formats and bounds remain enforced', async (t) => {
  const probe = '^POM-SHARED-[A-Z]+$';
  const input = document({
    Ancestor: { type: 'string', pattern: probe },
    Left: { allOf: [ref('Ancestor'), { type: 'string', minLength: 14 }] },
    Right: {
      allOf: [
        ref('Ancestor'),
        { type: 'string', maxLength: 16, format: 'contains-b' },
      ],
    },
    Combined: {
      allOf: [ref('Left'), ref('Right'), { type: 'string', pattern: 'Z$' }],
    },
  });
  const root = await generatedTestWorkspace(
    t,
    await compile(input, {
      ...selection,
      formats: {
        'contains-b': { type: 'string', pattern: 'POM-SHARED-.*B.*' },
      },
    }),
  );
  const request = await importGenerated<StandaloneModule>(
    root,
    'standalone.request.ts',
  );
  const response = await importGenerated<StandaloneModule>(
    root,
    'standalone.response.ts',
  );
  // oxlint-disable-next-line typescript/unbound-method -- Call with the original RegExp receiver and restore the method in finally.
  const original = RegExp.prototype.test;
  let checks = 0;
  RegExp.prototype.test = function (value: string) {
    if (this.source === probe) checks++;
    return original.call(this, value);
  };
  try {
    for (const schema of [request.schema, response.schema]) {
      checks = 0;
      assert.equal(schema.parse('POM-SHARED-ABZ'), 'POM-SHARED-ABZ');
      assert.equal(
        checks,
        1,
        'The shared ancestor pattern must run once per parsed value',
      );
      for (const value of [
        'POM-SHARED-aBZ',
        'POM-SHARED-BZ',
        'POM-SHARED-ABBBBBBZ',
        'POM-SHARED-ACZ',
        'POM-SHARED-ABY',
      ])
        assert.equal(schema.safeParse(value).success, false);
    }
  } finally {
    RegExp.prototype.test = original;
  }
});

void test('shared numeric ancestry preserves every independent multipleOf assertion', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(
      document({
        Ancestor: { type: 'number', minimum: 0, multipleOf: 2 },
        Left: { allOf: [ref('Ancestor'), { type: 'number', multipleOf: 3 }] },
        Right: { allOf: [ref('Ancestor'), { type: 'integer', maximum: 60 }] },
        Combined: {
          allOf: [ref('Left'), ref('Right'), { type: 'number', multipleOf: 5 }],
        },
      }),
      selection,
    ),
  );
  for (const name of ['request', 'response']) {
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      `standalone.${name}.ts`,
    );
    for (const value of [0, 30, 60]) assert.equal(schema.parse(value), value);
    for (const value of [2, 3, 5, 6, 10, 15, 30.5, 90, -30])
      assert.equal(schema.safeParse(value).success, false);
  }
});

void test('explicit dynamic additionalProperties remains unsupported beside fixed fields through aliases and composition', async () => {
  for (const dynamic of [true, {}]) {
    const fixed = {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    };
    const forms: readonly [string, Schema][] = [
      ['direct', { ...fixed, additionalProperties: dynamic }],
      [
        'typed branch',
        {
          allOf: [
            ref('Fixed'),
            { type: 'object', additionalProperties: dynamic },
          ],
        },
      ],
      [
        'untyped branch',
        { allOf: [ref('Fixed'), { additionalProperties: dynamic }] },
      ],
      ['local alias', { allOf: [ref('Fixed'), ref('DynamicAlias')] }],
      [
        'nested empty composition',
        {
          allOf: [
            ref('Fixed'),
            { allOf: [{ type: 'object', additionalProperties: dynamic }, {}] },
          ],
        },
      ],
    ];
    for (const [name, mixed] of forms) {
      const input = document({
        Combined: { type: 'string' },
        Fixed: fixed,
        Dynamic: { type: 'object', additionalProperties: dynamic },
        DynamicAlias: ref('Dynamic'),
        UnusedMixed: mixed,
      });
      const before = structuredClone(input);
      await assert.rejects(
        compile(input, selection),
        (error) => {
          assert.ok(error instanceof ContractError, name);
          assert.match(error.location, /^components\.schemas\./, name);
          assert.match(
            error.message,
            /additionalProperties|dynamic maps|dynamic.*fixed|typed maps/,
            name,
          );
          return true;
        },
        `${name} with additionalProperties ${dynamic === true ? 'true' : '{}'}`,
      );
      assert.deepEqual(input, before);
    }
  }
});

void test('bare object conjuncts remain neutral while pure explicit JSON maps retain fields and property-count bounds', async (t) => {
  const fixedRoot = await generatedTestWorkspace(
    t,
    await compile(
      document({
        Fixed: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
        Combined: { allOf: [ref('Fixed'), { type: 'object' }] },
      }),
      selection,
    ),
  );
  const fixedRequest = await importGenerated<StandaloneModule>(
    fixedRoot,
    'standalone.request.ts',
  );
  const fixedResponse = await importGenerated<StandaloneModule>(
    fixedRoot,
    'standalone.response.ts',
  );
  assert.deepEqual(fixedRequest.schema.parse({ id: 'id' }), { id: 'id' });
  assert.equal(
    fixedRequest.schema.safeParse({ id: 'id', extra: true }).success,
    false,
  );
  assert.deepEqual(fixedResponse.schema.parse({ id: 'id', extra: true }), {
    id: 'id',
  });
  const maps: readonly [Schema, boolean][] = [
    [
      {
        allOf: [
          { type: 'object', additionalProperties: true },
          { minProperties: 1 },
        ],
      },
      false,
    ],
    [{ type: 'object', additionalProperties: {} }, true],
    [{ allOf: [{ type: 'object', additionalProperties: {} }] }, true],
  ];
  for (const [map, acceptsEmpty] of maps) {
    const root = await generatedTestWorkspace(
      t,
      await compile(document({ Combined: map }), selection),
    );
    const value = {
      arbitrary: { nested: [1, true, null] },
      other: 'preserved',
    };
    for (const name of ['request', 'response']) {
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        `standalone.${name}.ts`,
      );
      const parsed = schema.parse(value);
      assert.deepEqual(parsed, value);
      assert.notEqual(record(parsed).arbitrary, value.arbitrary);
      assert.equal(schema.safeParse({}).success, acceptsEmpty);
      assert.equal(schema.safeParse({ invalid: () => true }).success, false);
    }
  }
});

void test('schema-valued map composition with additional property bounds remains explicitly unsupported', async () => {
  const input = document({
    Combined: { type: 'string' },
    UnusedTypedMap: {
      allOf: [
        { type: 'object', additionalProperties: {} },
        { minProperties: 1 },
      ],
    },
  });
  await assert.rejects(compile(input, selection), (error) => {
    assert.ok(error instanceof ContractError);
    assert.match(error.location, /^components\.schemas\.UnusedTypedMap/);
    assert.match(error.message, /typed (?:dynamic )?maps/);
    return true;
  });
});

void test('idempotent recursive references retain inherited constraints and directional fields', async (t) => {
  for (const openapi of ['3.0.4', '3.1.2']) {
    const recursive = ref('Combined');
    const variants: readonly [Schema, boolean][] = [
      [recursive, true],
      [{ allOf: [recursive, recursive] }, false],
      [{ allOf: [recursive, {}] }, false],
      [{ allOf: [{}, recursive] }, false],
      [{ allOf: [recursive, ref('EmptyAlias')] }, false],
      [{ allOf: [ref('EmptyAlias'), recursive] }, false],
    ];
    for (const [next, redeclare] of variants) {
      const input = {
        ...document({
          Empty: {},
          EmptyAlias: ref('Empty'),
          Base: {
            type: 'object',
            properties: {
              value: { type: 'integer', minimum: 1 },
              next,
              id: { type: 'string', readOnly: true },
              secret: { type: 'string', writeOnly: true },
            },
            required: ['value'],
          },
          Combined: {
            allOf: [
              ref('Base'),
              {
                type: 'object',
                properties: {
                  label: { type: 'string', minLength: 1 },
                  ...(redeclare ? { next: recursive } : {}),
                },
                required: ['label'],
              },
            ],
          },
        }),
        openapi,
      };
      const root = await generatedTestWorkspace(
        t,
        await compile(input, selection),
      );
      const client = await importGenerated<RuntimeClient>(
        root,
        'client.consumer.ts',
      );
      for (const usage of ['request', 'response']) {
        const { schema } = await importGenerated<StandaloneModule>(
          root,
          `standalone.${usage}.ts`,
        );
        const visible = usage === 'request' ? 'secret' : 'id';
        const child = { value: 2, label: 'child', [visible]: 'child-value' };
        const value = {
          value: 1,
          label: 'root',
          [visible]: 'root-value',
          next: child,
        };
        const parsed = record(schema.parse(value));
        assert.deepEqual(parsed, value);
        assert.notEqual(parsed.next, child);
        assert.equal(
          schema.safeParse({ ...value, next: { ...child, value: 0 } }).success,
          false,
        );
        assert.equal(
          schema.safeParse({ ...value, next: { value: 2 } }).success,
          false,
        );
        if (usage === 'request') {
          assert.equal(
            schema.safeParse({ ...value, id: 'forbidden' }).success,
            false,
          );
          assert.deepEqual(
            entry(client.operations, 'save').build({ body: value }).body,
            value,
          );
        } else {
          assert.deepEqual(schema.parse({ ...value, secret: 'hidden' }), value);
          const response = entry(client.operations, 'save').parseResponse({
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(value),
          });
          assert.equal(response.kind, 'success');
          if (response.kind === 'success')
            assert.deepEqual(response.data, value);
        }
        const cyclic: Record<string, unknown> = { ...value };
        cyclic.next = cyclic;
        assert.equal(schema.safeParse(cyclic).success, false);
        assert.deepEqual(schema.parse(value), value);
      }
    }
  }
});

void test('neutral recursive wrappers preserve access inherited from aliases', async (t) => {
  for (const access of ['readOnly', 'writeOnly']) {
    const input = document({
      Alias: { allOf: [ref('Combined')], [access]: true },
      Combined: {
        allOf: [
          {
            type: 'object',
            properties: {
              value: { type: 'integer' },
              next: { allOf: [ref('Alias'), {}, ref('Alias')] },
            },
            required: ['value'],
          },
          { type: 'object', properties: { label: { type: 'string' } } },
        ],
      },
    });
    const root = await generatedTestWorkspace(
      t,
      await compile(input, selection),
    );
    const request = await importGenerated<StandaloneModule>(
      root,
      'standalone.request.ts',
    );
    const response = await importGenerated<StandaloneModule>(
      root,
      'standalone.response.ts',
    );
    const value = { value: 1, next: { value: 2 } };
    if (access === 'readOnly') {
      assert.equal(request.schema.safeParse(value).success, false);
      assert.deepEqual(response.schema.parse(value), value);
    } else {
      assert.deepEqual(request.schema.parse(value), value);
      assert.deepEqual(response.schema.parse(value), { value: 1 });
    }
    const conflicted = document({
      ...input.components.schemas,
      Alias: {
        allOf: [
          ref('Combined'),
          { [access === 'readOnly' ? 'writeOnly' : 'readOnly']: true },
        ],
        [access]: true,
      },
    });
    await assert.rejects(
      compile(conflicted, selection),
      /readOnly and writeOnly cannot both be true/,
    );
  }
});
