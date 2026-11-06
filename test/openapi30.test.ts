import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import { record } from './assertions.ts';
import {
  openapi30Consumer,
  openapi30Fixture as fixture,
  openapi30Selection as selection,
  verifyOpenapi30,
} from './openapi30-fixture.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const exec = promisify(execFile);

void test('OpenAPI 3.0 normalizes to identical 3.1 output without changing JSON or YAML inputs', async () => {
  const input = fixture();
  const before = structuredClone(input);
  const expected = await compile(fixture(true), selection);
  assert.deepEqual(await compile(input, selection), expected);
  assert.deepEqual(input, before);
  assert.deepEqual(
    await compile(parseYaml(stringify(input), 'openapi30.yaml'), selection),
    expected,
  );
  for (const version of [
    '3.0.0',
    '3.0.1',
    '3.0.2',
    '3.0.3',
    '3.0.4',
    '3.0.100',
  ]) {
    input.openapi = version;
    assert.deepEqual(await compile(input, selection), expected, version);
  }
});

void test('OpenAPI 3.0 generated runtime and types agree for nullable values, bounds, aliases and directions', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  verifyOpenapi30(
    await importGenerated<RuntimeClient>(root, 'client.consumer.ts'),
    await importGenerated<StandaloneModule>(root, 'standalone.request.ts'),
    await importGenerated<StandaloneModule>(root, 'standalone.response.ts'),
  );
  await writeFile(join(root, 'consumer.ts'), openapi30Consumer);
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
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ['./*.ts'],
    }),
  );
  await exec(process.execPath, [
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
});

void test('OpenAPI 3.0 null-only branch diagnostics provide supported syntax', async () => {
  const input = fixture();
  input.components.schemas.Unused = {
    anyOf: [{ $ref: '#/components/schemas/Text' }, { type: 'null' }],
  };
  await assert.rejects(
    compile(input, selection),
    /Unused\.anyOf\[1\]\.type:.*enum: \[null\].*null-only branch/,
  );
});

void test('OpenAPI 3.0 rejects unsupported dialect syntax even in unused components', async () => {
  const invalid: [Schema, string][] = [
    [{ type: ['string', 'null'] }, 'type'],
    [{ type: 'null' }, 'type'],
    [{ type: 'string', const: 'x' }, 'const'],
    [{ type: 'string', $comment: 'annotation' }, '$comment'],
    [{ type: 'string', examples: ['x'] }, 'examples'],
    [
      { type: 'string', contentMediaType: 'application/octet-stream' },
      'contentMediaType',
    ],
    [{ type: 'number', exclusiveMinimum: 0 }, 'exclusiveMinimum'],
    [{ type: 'number', exclusiveMaximum: 10 }, 'exclusiveMaximum'],
    [{ type: 'number', exclusiveMinimum: true }, 'exclusiveMinimum'],
    [
      { type: 'integer', exclusiveMaximum: true, minimum: 0 },
      'exclusiveMaximum',
    ],
    [{ type: 'string', exclusiveMinimum: true }, 'exclusiveMinimum'],
    [
      { type: 'string', minimum: 0, exclusiveMinimum: true },
      'exclusiveMinimum',
    ],
    [
      { type: 'boolean', maximum: 1, exclusiveMaximum: true },
      'exclusiveMaximum',
    ],
    [{ minimum: 0, exclusiveMinimum: true }, 'exclusiveMinimum'],
    [{ type: 'string', nullable: 'true' }, 'nullable'],
    [{ type: 'number', minimum: '0', exclusiveMinimum: true }, 'minimum'],
    [{ type: 'number', maximum: null, exclusiveMaximum: true }, 'maximum'],
    [{ $ref: '#/components/schemas/Text', minLength: 4 }, 'minLength'],
    [{ $ref: '#/components/schemas/Text', nullable: true }, 'nullable'],
  ];
  for (const [schema, keyword] of invalid) {
    const document = fixture();
    document.components.schemas.Unused = schema;
    const before = structuredClone(document);
    await assert.rejects(compile(document, selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, `components.schemas.Unused.${keyword}`);
      return true;
    });
    assert.deepEqual(document, before);
  }
  const modern = fixture(true);
  modern.components.schemas.Unused = { type: 'string', nullable: true };
  await assert.rejects(compile(modern, selection), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, 'components.schemas.Unused.nullable');
    return true;
  });
});

void test('OpenAPI 3.0 false exclusive flags and nullable false preserve their base schemas', async () => {
  for (const schema of [
    { type: 'number', exclusiveMinimum: false, exclusiveMaximum: false },
    { type: 'string', exclusiveMinimum: false, exclusiveMaximum: false },
    { exclusiveMinimum: false, exclusiveMaximum: false },
    { type: 'number', minimum: 0, exclusiveMinimum: false },
    { type: 'number', nullable: false },
  ] satisfies Schema[]) {
    const input = fixture();
    input.components.schemas.Amount = schema;
    const modern = fixture(true);
    const base: Schema = { ...schema };
    delete base.exclusiveMinimum;
    delete base.exclusiveMaximum;
    delete base.nullable;
    modern.components.schemas.Amount = base;
    assert.deepEqual(
      await compile(input, selection),
      await compile(modern, selection),
    );
  }
});

void test('OpenAPI 3.0 validates version-specific metadata, reference siblings and request methods', async () => {
  const cases: [ReturnType<typeof fixture>, string][] = [];
  const summary = fixture();
  Object.assign(summary.info, { summary: '3.1 annotation' });
  cases.push([summary, 'info.summary']);
  const license = fixture();
  Object.assign(license.info, { license: { name: 'MIT', identifier: 'MIT' } });
  cases.push([license, 'info.license.identifier']);
  const response = fixture();
  Object.assign(response.components.responses.ReplyAlias, {
    description: 'Ignored in 3.0',
  });
  cases.push([response, 'components.responses.ReplyAlias.description']);
  for (const [section, name] of [
    ['parameters', 'SearchAlias'],
    ['requestBodies', 'BodyAlias'],
    ['headers', 'ModeAlias'],
    ['examples', 'SearchAlias'],
    ['securitySchemes', 'SessionAlias'],
    ['schemas', 'Alias'],
  ] as const) {
    const input = fixture();
    const component = record(record(input.components[section])[name]);
    Object.assign(component, { description: 'Ignored in OpenAPI 3.0' });
    cases.push([input, `components.${section}.${name}.description`]);
  }
  const deletion = fixture();
  const operation = deletion.paths['/round-trip'].post;
  Object.assign(deletion.paths['/round-trip'], { delete: operation });
  Reflect.deleteProperty(deletion.paths['/round-trip'], 'post');
  cases.push([deletion, 'paths./round-trip.delete.requestBody']);
  for (const [document, location] of cases)
    await assert.rejects(compile(document, selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, location);
      return true;
    });
});

void test('OpenAPI 3.0 lowers inline array item nullability and exclusive bounds', async (t) => {
  const document = (modern: boolean) => ({
    openapi: modern ? '3.1.2' : '3.0.4',
    info: { title: 'Synthetic nested dialect assertions', version: '1' },
    paths: {},
    components: {
      schemas: {
        Values: {
          type: 'array',
          items: modern
            ? { type: ['number', 'null'], exclusiveMinimum: 0 }
            : {
                type: 'number',
                nullable: true,
                minimum: 0,
                exclusiveMinimum: true,
              },
        },
      },
    },
  });
  const options = {
    clients: [],
    standalone: {
      values: { schema: '#/components/schemas/Values', usage: 'request' },
    },
  } as const;
  const files = await compile(document(false), options);
  assert.deepEqual(files, await compile(document(true), options));
  const root = await generatedTestWorkspace(t, files);
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.values.ts',
  );
  assert.deepEqual(schema.parse([null, 1]), [null, 1]);
  for (const value of [[0], [-1], ['1']])
    assert.equal(schema.safeParse(value).success, false);
});

void test('dialect lowering preserves application names and opaque annotation payloads', async () => {
  const input = fixture();
  const modern = fixture(true);
  for (const document of [input, modern]) {
    document.components.schemas.Named = {
      type: 'object',
      properties: {
        nullable: { type: 'string' },
        const: { type: 'boolean' },
        examples: { type: 'integer' },
        exclusiveMinimum: { type: 'number' },
      },
      example: { nullable: true, const: 'example', exclusiveMinimum: true },
      default: { nullable: true, type: ['string', 'null'], examples: [] },
    };
    Object.assign(document.components.examples.Search, {
      value: { nullable: true, const: 'opaque', exclusiveMinimum: true },
    });
  }
  assert.deepEqual(
    await compile(input, selection),
    await compile(modern, selection),
  );
});

void test('removing unsupported untyped nullable preserves composite assertions', async (t) => {
  const input = fixture();
  input.components.schemas.Text = {
    nullable: true,
    anyOf: [{ type: 'string' }, { type: 'integer' }],
  };
  const modern = fixture(true);
  modern.components.schemas.Text = {
    anyOf: [{ type: 'string' }, { type: 'integer' }],
  };
  await assert.rejects(compile(input, selection), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, 'components.schemas.Text.nullable');
    return true;
  });
  delete input.components.schemas.Text.nullable;
  const files = await compile(input, selection);
  assert.deepEqual(files, await compile(modern, selection));
  const root = await generatedTestWorkspace(t, files);
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const operation = client.operations.checkText;
  assert.ok(operation);
  assert.equal(operation.build({ body: 'text' }).body, 'text');
  assert.equal(operation.build({ body: 1 }).body, 1);
  assert.throws(
    () => operation.build({ body: null }),
    client.RequestValidationError,
  );
});

void test('OpenAPI 3.0 dialect errors leave generated outputs unchanged in generate and check', async (t) => {
  const root = await temporary(t);
  const input = join(root, 'openapi.yaml');
  const config = join(root, 'pom.json');
  const output = join(root, 'generated');
  await writeFile(input, stringify(fixture()));
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.yaml',
      output: './generated',
      ...selection,
    }),
  );
  await runProject(config);
  const before = await fileSnapshot(output);
  const invalid = fixture();
  invalid.components.schemas.Unused = { type: 'number', exclusiveMinimum: 1 };
  const source = stringify(invalid);
  await writeFile(input, source);
  for (const check of [false, true]) {
    await assert.rejects(runProject(config, { check }), ContractError);
    assert.deepEqual(await fileSnapshot(output), before);
    assert.equal(await readFile(input, 'utf8'), source);
  }
});

void test('OpenAPI 3.0 preserves nullable directional properties and context-specific shared values', async (t) => {
  const input = fixture();
  const modern = fixture(true);
  const variants: [ReturnType<typeof fixture>, Schema][] = [
    [input, { type: 'string', nullable: true }],
    [modern, { type: ['string', 'null'] }],
  ];
  for (const [document, nullable] of variants) {
    document.components.schemas.Record = {
      type: 'object',
      properties: {
        id: { ...nullable, readOnly: true },
        secret: { ...nullable, writeOnly: true },
      },
      required: ['id', 'secret'],
    };
    // The same object used as schema and payload must retain each interpretation.
    document.components.schemas.Shared = nullable;
    Object.assign(document.components.examples.Search, { value: nullable });
  }
  const before = structuredClone(input);
  const files = await compile(input, selection);
  assert.deepEqual(input, before);
  assert.equal(
    input.components.schemas.Shared,
    input.components.examples.Search.value,
  );
  assert.deepEqual(files, await compile(modern, selection));
  const root = await generatedTestWorkspace(t, files);
  const request = await importGenerated<StandaloneModule>(
    root,
    'standalone.request.ts',
  );
  const response = await importGenerated<StandaloneModule>(
    root,
    'standalone.response.ts',
  );
  assert.deepEqual(request.schema.parse({ secret: null }), { secret: null });
  assert.equal(request.schema.safeParse({}).success, false);
  assert.equal(
    request.schema.safeParse({ id: null, secret: null }).success,
    false,
  );
  assert.deepEqual(response.schema.parse({ id: null, secret: 'private' }), {
    id: null,
  });
  assert.equal(response.schema.safeParse({}).success, false);
});

void test('OpenAPI 3.0 lowers schemas after ignored extensions and retains format binary uploads', async (t) => {
  const input = fixture();
  const modern = fixture(true);
  assert.ok(input.components.schemas.Amount);
  Object.assign(input.components.schemas.Amount, {
    'x-note': { nullable: 'opaque' },
  });
  assert.deepEqual(
    await compile(input, { ...selection, ignoreExtensions: ['x-note'] }),
    await compile(modern, selection),
  );
  await assert.rejects(compile(input, selection), /ignoreExtensions/);
  const document = {
    openapi: '3.0.4',
    info: { title: 'Synthetic 3.0 upload', version: '1' },
    paths: {
      '/upload': {
        post: {
          operationId: 'upload',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: { file: { type: 'string', format: 'binary' } },
                  required: ['file'],
                },
              },
            },
          },
          responses: { 201: { description: 'Stored' } },
        },
      },
    },
  };
  const options = {
    clients: ['native'],
    surfaces: { native: ['upload'] },
    targets: { native: 'native' },
  } as const;
  const files = await compile(document, options);
  assert.deepEqual(
    files,
    await compile({ ...document, openapi: '3.1.2' }, options),
  );
  const root = await generatedTestWorkspace(t, files);
  const client = await importGenerated<RuntimeClient>(root, 'client.native.ts');
  const upload = client.operations.upload;
  assert.ok(upload);
  const native = {
    uri: 'file:///synthetic.txt',
    name: 'synthetic.txt',
    mediaType: 'text/plain',
  };
  assert.doesNotThrow(() => upload.build({ body: { file: native } }));
  assert.throws(
    () => upload.build({ body: { file: 'text' } }),
    client.RequestValidationError,
  );
});

void test('OpenAPI 3.0 singleton enums discriminate tagged unions', async (t) => {
  const document = fixture();
  document.components.schemas.Text = {
    oneOf: [
      { $ref: '#/components/schemas/TaggedText' },
      { $ref: '#/components/schemas/TaggedCount' },
    ],
    discriminator: {
      propertyName: 'kind',
      mapping: {
        text: '#/components/schemas/TaggedText',
        count: '#/components/schemas/TaggedCount',
      },
    },
  };
  document.components.schemas.TaggedText = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['text'] },
      value: { type: 'string', nullable: true },
    },
    required: ['kind', 'value'],
  };
  document.components.schemas.TaggedCount = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['count'] },
      value: { type: 'integer', minimum: 0, exclusiveMinimum: true },
    },
    required: ['kind', 'value'],
  };
  const root = await generatedTestWorkspace(
    t,
    await compile(document, selection),
  );
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const operation = client.operations.checkText;
  assert.ok(operation);
  assert.deepEqual(
    operation.build({ body: { kind: 'text', value: null } }).body,
    { kind: 'text', value: null },
  );
  assert.deepEqual(
    operation.build({ body: { kind: 'count', value: 1 } }).body,
    { kind: 'count', value: 1 },
  );
  assert.throws(
    () => operation.build({ body: { kind: 'count', value: 0 } }),
    client.RequestValidationError,
  );
});
