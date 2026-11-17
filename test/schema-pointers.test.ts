import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { audit, compile } from '../dist/index.js';
import type { CompileWarning } from '../dist/index.js';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const ref = (pointer: string): Schema => ({ $ref: pointer });
const component = (name: string): Schema => ref(`#/components/schemas/${name}`);
const media = (schema: Schema) => ({
  content: { 'application/json': { schema } },
});
const reply = (schema: Schema) => ({
  responses: { 200: { description: 'Synthetic value', ...media(schema) } },
});
function document(
  schemas: Record<string, Schema> = {},
  paths: Record<string, unknown> = {},
  openapi = '3.1.2',
) {
  return {
    openapi,
    info: { title: 'Synthetic local schema pointers', version: '1' },
    paths,
    components: { schemas },
  };
}
const selection = (schema: string) => ({
  clients: [],
  pruneUnusedComponents: true,
  standalone: { value: { schema, usage: 'response' as const } },
});

void test('local pointers compile schema positions in reusable parameters, headers and media without retaining their containers', async (t) => {
  for (const openapi of ['3.0.4', '3.1.2']) {
    const source = {
      ...document({}, {}, openapi),
      components: {
        parameters: {
          BadContainer: {
            name: 7,
            in: 'unsupported',
            schema: { type: 'string', minLength: 2 },
          },
        },
        headers: {
          BadContainer: {
            required: 'invalid',
            schema: { type: 'integer', minimum: 2 },
          },
        },
        responses: {
          BadContainer: { description: 7, ...media({ type: 'boolean' }) },
        },
      },
    };
    const root = await generatedTestWorkspace(
      t,
      await compile(source, {
        clients: [],
        pruneUnusedComponents: true,
        standalone: {
          parameter: {
            schema: '#/components/parameters/BadContainer/schema',
            usage: 'response',
          },
          header: {
            schema: '#/components/headers/BadContainer/schema',
            usage: 'response',
          },
          media: {
            schema:
              '#/components/responses/BadContainer/content/application~1json/schema',
            usage: 'response',
          },
        },
      }),
    );
    for (const [name, valid, invalid] of [
      ['parameter', 'ab', 'a'],
      ['header', 2, 1],
      ['media', true, 'true'],
    ] as const) {
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        `standalone.${name}.ts`,
      );
      assert.equal(schema.safeParse(valid).success, true);
      assert.equal(schema.safeParse(invalid).success, false);
    }
  }
});

void test('URI decoding and JSON Pointer escapes retain exact own-key identity and public component names', async (t) => {
  const source = document({
    Holder: {
      type: 'object',
      properties: Object.fromEntries([
        ['a/b~c%☃', { type: 'string', const: 'escaped' }],
        ['__proto__', { type: 'integer', minimum: 2 }],
      ]),
    },
    A: { type: 'boolean' },
  });
  const before = structuredClone(source);
  const root = await generatedTestWorkspace(
    t,
    await compile(source, {
      clients: [],
      pruneUnusedComponents: true,
      standalone: {
        escaped: {
          schema: '#/components/schemas/Holder/properties/a~1b~0c%25%E2%98%83',
          usage: 'response',
        },
        own: {
          schema: '#/components/schemas/Holder/properties/__proto__',
          usage: 'response',
        },
        named: { schema: '#%2Fcomponents%2Fschemas%2F%41', usage: 'response' },
      },
    }),
  );
  for (const [name, valid, invalid] of [
    ['escaped', 'escaped', 'a/b~c%☃'],
    ['own', 2, 1],
    ['named', false, 0],
  ] as const) {
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      `standalone.${name}.ts`,
    );
    assert.equal(schema.safeParse(valid).success, true);
    assert.equal(schema.safeParse(invalid).success, false);
  }
  assert.deepEqual(source, before);
});

void test('allOf fragment targets retain independent non-object semantics and normalize each source once', async (t) => {
  const fragment: Schema = {
    properties: { value: { type: 'string', minLength: 2, uniqueItems: true } },
    required: ['value'],
    additionalProperties: false,
    minProperties: 1,
    maxProperties: 1,
  };
  const source = document({
    Whole: { allOf: [{ type: 'object' }, fragment] },
    Reused: ref('#/components/schemas/Whole/allOf/1'),
  });
  const warnings: CompileWarning[] = [];
  const root = await generatedTestWorkspace(
    t,
    await compile(source, {
      clients: [],
      standalone: {
        fragment: {
          schema: '#/components/schemas/Whole/allOf/1',
          usage: 'response',
        },
        whole: { schema: '#/components/schemas/Whole', usage: 'response' },
        reused: { schema: '#/components/schemas/Reused', usage: 'response' },
      },
      onWarning: (warning) => warnings.push(warning),
    }),
  );
  assert.equal(warnings.length, 1);
  assert.equal(
    present(warnings[0]).path,
    'components.schemas.Whole.allOf[1].properties.value.uniqueItems',
  );
  assert.doesNotMatch(present(warnings[0]).message, /occurrences/);
  const oracle = new Ajv2020({ strict: false }).compile(fragment);
  const samples: unknown[] = [
    'text',
    1,
    true,
    null,
    [],
    ['x'],
    {},
    { value: 'ab' },
    { value: 'a' },
    { value: 'ab', extra: true },
  ];
  for (const name of ['fragment', 'reused', 'whole']) {
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      `standalone.${name}.ts`,
    );
    for (const input of samples)
      assert.equal(
        schema.safeParse(input).success,
        Boolean(oracle(input)) &&
          (name !== 'whole' ||
            (input !== null &&
              typeof input === 'object' &&
              !Array.isArray(input))),
        `${name}: ${JSON.stringify(input)}`,
      );
  }
});

void test('retained schema references survive an excluded containing operation and preserve recursive validation', async (t) => {
  const target =
    '#/paths/~1source/post/requestBody/content/application~1json/schema';
  for (const openapi of ['3.0.4', '3.1.2']) {
    const value: Schema = {
      type: 'object',
      properties: { value: { type: 'integer', minimum: 1 }, next: ref(target) },
      required: ['value'],
    };
    const source = document(
      {},
      {
        '/source': {
          post: {
            operationId: 'drop',
            unsupported: true,
            requestBody: media(value),
            ...reply({ type: 'string' }),
          },
        },
        '/kept': {
          post: {
            operationId: 'keep',
            requestBody: { required: true, ...media(ref(target)) },
            ...reply(ref(target)),
          },
        },
      },
      openapi,
    );
    const settings = {
      clients: ['consumer'],
      surfaces: { consumer: ['keep', 'drop'] },
      excludeOperations: ['drop'],
    };
    const root = await generatedTestWorkspace(
      t,
      await compile(source, settings),
    );
    const client = await importGenerated<RuntimeClient>(
      root,
      'client.consumer.ts',
    );
    const operation = present(client.operations.keep);
    const valid = { value: 1, next: { value: 2 } };
    assert.deepEqual(operation.build({ body: valid }).body, valid);
    assert.throws(
      () => operation.build({ body: { value: 1, next: { value: 0 } } }),
      client.RequestValidationError,
    );
    const parsed = operation.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(valid),
    });
    assert.equal(parsed.kind, 'success');
    const report = await audit(source, settings);
    assert.equal(report.complete, true);
    assert.deepEqual(report.supportedOperations, ['keep']);
    assert.deepEqual(report.failedOperations, []);
  }
});

void test('audit attributes invalid detached targets to direct and containing users with exact dotted source identities', async () => {
  const bad = '#/components/schemas/A/properties/leaf';
  const source = document(
    {
      A: {
        type: 'object',
        properties: { leaf: { type: 'string', minLength: -1 } },
      },
      'A.properties.leaf': { type: 'string' },
    },
    {
      '/direct': { get: { operationId: 'direct', ...reply(ref(bad)) } },
      '/container': {
        get: { operationId: 'container', ...reply(component('A')) },
      },
      '/healthy': {
        get: {
          operationId: 'healthy',
          ...reply(component('A.properties.leaf')),
        },
      },
    },
  );
  const settings = {
    clients: ['consumer'],
    surfaces: { consumer: ['direct', 'container', 'healthy'] },
    pruneUnusedComponents: true,
  };
  const report = await audit(source, settings);
  assert.equal(report.complete, true);
  assert.deepEqual(report.failedOperations, ['container', 'direct']);
  assert.deepEqual(report.supportedOperations, ['healthy']);
  await compile(source, {
    ...settings,
    excludeOperations: report.excludeOperations,
  });
});

void test('retained unsupported pointer forms fail actionably while excluded uses remain removable', async () => {
  const badTargets: [string, RegExp][] = [
    ['other.json#/schema', /only local JSON Pointer/],
    ['#anchor', /anchors are unsupported/],
    [
      '#/components/schemas/Container/properties/missing',
      /unresolved local schema reference/,
    ],
    [
      '#/components/schemas/Container/properties/flag',
      /boolean schema targets are unsupported/,
    ],
    ['#/info', /does not target a supported schema position/],
    [
      '#/components/schemas/Container/properties/bad~2escape',
      /malformed JSON Pointer escape/,
    ],
    [
      '#/components/schemas/Container/properties/%ZZ',
      /malformed URI fragment encoding/,
    ],
  ];
  for (const [pointer, message] of badTargets) {
    const source = document(
      { Container: { type: 'object' } },
      {
        '/bad': { get: { operationId: 'bad', ...reply(ref(pointer)) } },
        '/good': { get: { operationId: 'good', ...reply({ type: 'string' }) } },
      },
    );
    Object.assign(present(source.components.schemas.Container), {
      properties: { flag: false },
    });
    const settings = {
      clients: ['consumer'],
      surfaces: { consumer: ['bad', 'good'] },
      pruneUnusedComponents: true,
    };
    await assert.rejects(compile(source, settings), message);
    await compile(source, { ...settings, excludeOperations: ['bad'] });
    await assert.rejects(compile(source, selection(pointer)), message);
    const report = await audit(source, settings);
    assert.equal(report.complete, true);
    assert.deepEqual(report.failedOperations, ['bad']);
    assert.deepEqual(report.supportedOperations, ['good']);
  }
});

void test('fragment discriminator branches require explicit tags and mapping selects their runtime schemas', async (t) => {
  const pointer = '#/components/schemas/Holder/properties/branch';
  const schemas = {
    Holder: {
      type: 'object',
      properties: {
        branch: {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'text' },
            value: { type: 'string' },
          },
          required: ['kind', 'value'],
        },
      },
    },
    Value: {
      oneOf: [ref(pointer)],
      discriminator: { propertyName: 'kind', mapping: { text: pointer } },
    },
  };
  const root = await generatedTestWorkspace(
    t,
    await compile(document(schemas), selection('#/components/schemas/Value')),
  );
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.value.ts',
  );
  assert.equal(schema.safeParse({ kind: 'text', value: 'ok' }).success, true);
  assert.equal(schema.safeParse({ kind: pointer, value: 'ok' }).success, false);
  const implicit = {
    ...schemas,
    Value: { oneOf: [ref(pointer)], discriminator: { propertyName: 'kind' } },
  };
  await assert.rejects(
    compile(document(implicit), selection('#/components/schemas/Value')),
    /fragment oneOf branches require an explicit discriminator mapping/,
  );
});

void test('generated types and public schema registries contain only declared component names', async (t) => {
  const pointer = '#/components/schemas/Holder/properties/value';
  const source = document(
    {
      Holder: {
        type: 'object',
        properties: { value: { type: 'string', minLength: 2 } },
      },
      Named: ref(pointer),
      _rIy9jb21wb25lbnRz: { type: 'integer' },
    },
    {
      '/value': {
        post: {
          operationId: 'save',
          requestBody: { required: true, ...media(component('Named')) },
          ...reply(component('Named')),
        },
        get: {
          operationId: 'number',
          ...reply(component('_rIy9jb21wb25lbnRz')),
        },
      },
    },
  );
  const root = await generatedTestWorkspace(
    t,
    await compile(source, {
      clients: ['consumer'],
      surfaces: { consumer: ['save', 'number'] },
      standalone: { value: { schema: pointer, usage: 'response' } },
    }),
  );
  await writeFile(
    join(root, 'consumer.ts'),
    `import { operations } from './client.consumer.ts';
import type { RequestTypes, ResponseTypes } from './client.consumer.ts';
import type { Output } from './standalone.value.ts';
const value: Output = 'ok';
const named: RequestTypes['Named'] = value;
const response: ResponseTypes['Named'] = named;
const ordinary: ResponseTypes['_rIy9jb21wb25lbnRz'] = 2;
void ordinary;
operations.save.build({ body: response });
// @ts-expect-error fragment identifiers are private dependency identities.
type Private = ResponseTypes['${pointer}'];
// @ts-expect-error the referenced fragment is a string.
const invalid: Output = 2;
void invalid;
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
});

void test('opaque extensions and non-element array metadata cannot become schema declarations', async () => {
  const source = {
    ...document(),
    paths: {
      'x-note': {
        get: { responses: { 200: { ...media({ type: 'string' }) } } },
      },
    },
    components: {
      schemas: {
        'x-note': {
          type: 'object',
          properties: { 'x-note': { type: 'string' } },
        },
      },
      responses: {
        Container: {
          description: 'Value',
          content: {
            'x-note': { schema: { type: 'string' } },
            'x-foo/json': { schema: { type: 'string' } },
          },
        },
      },
    },
  };
  for (const pointer of [
    '#/paths/x-note/get/responses/200/content/application~1json/schema',
    '#/components/responses/Container/content/x-note/schema',
  ])
    await assert.rejects(
      compile(source, selection(pointer)),
      /does not target a supported schema position/,
    );
  for (const pointer of [
    '#/components/schemas/x-note/properties/x-note',
    '#/components/responses/Container/content/x-foo~1json/schema',
  ])
    await compile(source, {
      ...selection(pointer),
      ignoreExtensions: ['x-note'],
    });

  const branches = [{ type: 'string' }];
  Object.defineProperty(branches, '4294967295', {
    value: ref('external.json'),
    enumerable: true,
  });
  const arraySource = document({ Value: { anyOf: branches } });
  await compile(arraySource, selection('#/components/schemas/Value'));
  await assert.rejects(
    compile(
      arraySource,
      selection('#/components/schemas/Value/anyOf/4294967295'),
    ),
    /unresolved local schema reference/,
  );
});

void test('OpenAPI 3.0 targets are selected from original Reference Object siblings before lowering', async (t) => {
  const source = document(
    {
      Alias: {
        ...component('Other'),
        properties: { hidden: { type: 'string', minLength: 2 } },
      },
      Other: { type: 'integer' },
    },
    {},
    '3.0.4',
  );
  const root = await generatedTestWorkspace(
    t,
    await compile(
      source,
      selection('#/components/schemas/Alias/properties/hidden'),
    ),
  );
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.value.ts',
  );
  assert.equal(schema.safeParse('ab').success, true);
  assert.equal(schema.safeParse('a').success, false);
  assert.equal(schema.safeParse(2).success, false);
});

void test('same-value cycles through fragment aliases remain explicit contract errors', async () => {
  const pointer = '#/components/schemas/Holder/properties/loop';
  await assert.rejects(
    compile(
      document({
        Holder: { type: 'object', properties: { loop: ref(pointer) } },
      }),
      selection(pointer),
    ),
    /same value|cyclic|cycle|recursive/i,
  );
});

void test('programmatic shared schema identities normalize once regardless of which inline occurrence is visited first', async (t) => {
  for (const order of [
    ['target', 'other'],
    ['other', 'target'],
  ])
    for (const nested of [false, true]) {
      const shared: Schema = {
        type: 'string',
        minLength: 2,
        uniqueItems: true,
      };
      const occurrence: Schema = nested
        ? { type: 'object', properties: { value: shared }, required: ['value'] }
        : shared;
      const suffix = nested ? '/properties/value' : '';
      const source = document({
        Holder: {
          type: 'object',
          properties: Object.fromEntries(
            order.map((name) => [name, occurrence]),
          ),
        },
      });
      const warnings: CompileWarning[] = [];
      const root = await generatedTestWorkspace(
        t,
        await compile(source, {
          clients: [],
          standalone: {
            holder: {
              schema: '#/components/schemas/Holder',
              usage: 'response',
            },
            target: {
              schema: '#/components/schemas/Holder/properties/target' + suffix,
              usage: 'response',
            },
            other: {
              schema: '#/components/schemas/Holder/properties/other' + suffix,
              usage: 'response',
            },
          },
          onWarning: (warning) => warnings.push(warning),
        }),
      );
      assert.equal(warnings.length, 1);
      assert.doesNotMatch(present(warnings[0]).message, /occurrences/);
      for (const name of ['target', 'other']) {
        const { schema } = await importGenerated<StandaloneModule>(
          root,
          `standalone.${name}.ts`,
        );
        assert.equal(schema.safeParse('ab').success, true);
        assert.equal(schema.safeParse('a').success, false);
      }
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        'standalone.holder.ts',
      );
      const value = (input: string) => (nested ? { value: input } : input);
      assert.equal(
        schema.safeParse({ target: value('ab'), other: value('cd') }).success,
        true,
      );
      assert.equal(
        schema.safeParse({ target: value('ab'), other: value('c') }).success,
        false,
      );
    }
});

void test('audit follows a targeted descendant through every shared parent alias', async () => {
  for (const order of [
    ['First', 'Second'],
    ['Second', 'First'],
  ]) {
    const shared: Schema = {
      type: 'object',
      properties: { value: { type: 'string', minLength: -1 } },
    };
    const pointer = '#/components/schemas/First/properties/value';
    const source = document(
      Object.fromEntries(order.map((name) => [name, shared])),
      {
        '/first': {
          get: { operationId: 'first', ...reply(component('First')) },
        },
        '/second': {
          get: { operationId: 'second', ...reply(component('Second')) },
        },
        '/direct': { get: { operationId: 'direct', ...reply(ref(pointer)) } },
        '/healthy': {
          get: { operationId: 'healthy', ...reply({ type: 'string' }) },
        },
      },
    );
    const settings = {
      clients: ['consumer'],
      surfaces: { consumer: ['first', 'second', 'direct', 'healthy'] },
      pruneUnusedComponents: true,
    };
    const report = await audit(source, settings);
    assert.equal(report.complete, true);
    assert.deepEqual(report.failedOperations, ['direct', 'first', 'second']);
    assert.deepEqual(report.supportedOperations, ['healthy']);
    await compile(source, {
      ...settings,
      excludeOperations: report.excludeOperations,
    });
  }
});
