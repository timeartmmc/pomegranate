import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { json, present, record } from './assertions.ts';
import { generatedWorkspace, importGenerated } from './generated-workspace.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import {
  propertyCountConsumer,
  propertyCountFixture as fixture,
  propertyCountSelection as selection,
  verifyPropertyCounts,
} from './property-count-fixture.ts';
import type { PropertyCountSchemas } from './property-count-fixture.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const exec = promisify(execFile);
let files: Readonly<Record<string, string>>;
let root: string;
let client: RuntimeClient;
let schemas: PropertyCountSchemas;
before(async () => {
  files = await compile(fixture(), selection);
  root = await generatedWorkspace(files);
  client = await importGenerated<RuntimeClient>(root, 'client.consumer.ts');
  schemas = await importGenerated<PropertyCountSchemas>(
    root,
    'client.consumer.schemas.ts',
  );
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

async function rejectsAt(document: unknown, location: string, message: RegExp) {
  const before = structuredClone(document);
  await assert.rejects(compile(document, selection), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, location);
    assert.match(error.message, message);
    return true;
  });
  assert.deepEqual(document, before);
}

void test('property bounds preserve JSON/YAML behavior, input values and deterministic complete output', async () => {
  const document = fixture();
  const before = structuredClone(document);
  assert.deepEqual(await compile(document, selection), files);
  assert.deepEqual(document, before);
  assert.deepEqual(
    await compile(parseYaml(stringify(document), 'counts.yaml'), selection),
    files,
  );
  document.components.schemas = Object.fromEntries(
    Object.entries(document.components.schemas).reverse(),
  );
  assert.deepEqual(await compile(document, selection), files);
});

void test('property bounds hold in generated requests, responses, aliases, maps, nullable and wide objects', () => {
  verifyPropertyCounts(client, schemas);
});

void test('property constraints agree with Ajv on typed and arbitrary JSON maps and nullable objects', () => {
  const oracle = new Ajv2020({ strict: false });
  const definitions = fixture().components.schemas;
  const samples = [
    null,
    false,
    1,
    'object',
    [],
    {},
    { one: 1 },
    { one: 1, two: 2 },
    { one: 1, two: 2, three: 3 },
    { one: -1 },
    { one: 'one' },
    { one: 'one', two: 'two' },
    { one: 'one', two: 'two', three: 'three' },
    { nested: { value: [null, 1, 'x'] } },
    json('{"__proto__":1}'),
  ] as const;
  for (const name of ['CountedMap', 'AnyMap', 'Nullable']) {
    const validate = oracle.compile(present(definitions[name]));
    for (const value of samples) {
      const expected = validate(value);
      assert.equal(
        present(schemas.requestSchemas[name]).safeParse(value).success,
        expected,
        `${name} request ${JSON.stringify(value)}`,
      );
      assert.equal(
        present(schemas.responseSchemas[name]).safeParse(value).success,
        expected,
        `${name} response ${JSON.stringify(value)}`,
      );
    }
  }
});

void test('fixed-object counts inspect original own enumerable keys before response stripping and alias parsing', () => {
  const response = present(schemas.responseSchemas.Alias);
  assert.deepEqual(response.parse({ ignored: 1, other: 2 }), {});
  assert.equal(response.safeParse({ a: 'a' }).success, false);
  assert.equal(
    response.safeParse({ a: 'a', b: 'b', ignored: 3 }).success,
    false,
  );
  const hidden = Object.defineProperty({ a: 'a' }, 'b', { value: 'b' });
  assert.equal(response.safeParse(hidden).success, false);
  const inherited: unknown = Object.create({ a: 'a', b: 'b' });
  assert.equal(response.safeParse(inherited).success, false);
  const symbols = { a: 'a', [Symbol('unrelated')]: 1 };
  assert.equal(response.safeParse(symbols).success, false);
  Object.assign(symbols, { b: 'b' });
  assert.deepEqual(response.parse(symbols), { a: 'a', b: 'b' });
  const unread = Object.defineProperty({ a: 'a' }, 'ignored', {
    enumerable: true,
    get() {
      throw new Error('stripped fields are not read for property counts');
    },
  });
  assert.deepEqual(response.parse(unread), { a: 'a' });
});

void test('request bounds count serialized snapshots and structural fields', () => {
  const fixed = present(schemas.requestSchemas.Fixed);
  const alias = present(schemas.requestSchemas.Alias);
  assert.equal(fixed.safeParse({ a: undefined }).success, false);
  const omitted = alias.parse({ a: undefined, b: 'b', c: 'c' });
  assert.deepEqual(alias.parse(json(JSON.stringify(omitted))), {
    b: 'b',
    c: 'c',
  });
  const inherited: unknown = Object.create({ a: 'a', b: 'b' });
  const hidden = Object.defineProperties(
    {},
    {
      a: { value: 'a' },
      b: { value: 'b' },
    },
  );
  for (const source of [inherited, hidden]) {
    const output = alias.parse(source);
    assert.deepEqual(output, { a: 'a', b: 'b' });
    assert.deepEqual(alias.parse(json(JSON.stringify(output))), output);
  }
  const tooWide: unknown = Object.create({ a: 'a', b: 'b', c: 'c' });
  assert.equal(alias.safeParse(tooWide).success, false);
  assert.equal(
    present(schemas.requestSchemas.AnyMap).safeParse({ a: undefined }).success,
    false,
  );
});

void test('directional projection preserves object bounds and counts stripped fields without reading them', async () => {
  const request = present(schemas.requestSchemas.Directional);
  const response = present(schemas.responseSchemas.Directional);
  assert.deepEqual(request.parse({ visible: 'visible', secret: 'secret' }), {
    visible: 'visible',
    secret: 'secret',
  });
  assert.equal(
    request.safeParse({ visible: 'visible', secret: 'secret', id: 'forbidden' })
      .success,
    false,
  );
  assert.deepEqual(response.parse({ visible: 'visible', id: 'id' }), {
    visible: 'visible',
    id: 'id',
  });
  assert.equal(
    response.safeParse({ visible: 'visible', id: 'id', secret: 7 }).success,
    false,
  );
  assert.equal(
    present(schemas.requestSchemas.OnlyRead).safeParse({}).success,
    false,
  );
  assert.equal(
    present(schemas.responseSchemas.OnlyWrite).safeParse({}).success,
    false,
  );
  const unread = Object.defineProperty({}, 'secret', {
    enumerable: true,
    get() {
      throw new Error('write-only response fields are not read');
    },
  });
  assert.deepEqual(
    present(schemas.responseSchemas.OnlyWrite).parse(unread),
    {},
  );
  const standaloneRequest = await importGenerated<StandaloneModule>(
    root,
    'standalone.request.ts',
  );
  const standaloneResponse = await importGenerated<StandaloneModule>(
    root,
    'standalone.response.ts',
  );
  assert.deepEqual(
    standaloneRequest.schema.parse({ visible: 'visible', secret: 'secret' }),
    { visible: 'visible', secret: 'secret' },
  );
  assert.equal(
    standaloneRequest.schema.safeParse({
      visible: 'visible',
      secret: 'secret',
      id: 'id',
    }).success,
    false,
  );
  assert.equal(
    standaloneResponse.schema.safeParse({
      visible: 'visible',
      id: 'id',
      extra: 1,
    }).success,
    false,
  );
});

void test('wide object parsers apply total property counts', () => {
  for (const direction of [schemas.requestSchemas, schemas.responseSchemas]) {
    const wide = present(direction.Wide);
    assert.deepEqual(wide.parse({ field0: 0, field139: 139 }), {
      field0: 0,
      field139: 139,
    });
    assert.equal(wide.safeParse({}).success, false);
    assert.equal(
      wide.safeParse({ field0: 0, field64: 64, field139: 139 }).success,
      false,
    );
  }
});

void test('property bounds report nested issue paths and do not mutate or retain caller objects', () => {
  const nested = present(schemas.requestSchemas.Nested);
  const input = { child: { a: 'a', b: 'b' }, entries: { one: 1 } };
  const before = structuredClone(input);
  const output = record(nested.parse(input));
  assert.deepEqual(input, before);
  assert.notEqual(output, input);
  assert.notEqual(output.child, input.child);
  assert.notEqual(output.entries, input.entries);
  const result = nested.safeParse({ child: { a: 'a' }, entries: {} });
  assert.equal(result.success, false);
  if (!result.success) {
    assert.ok(
      result.error.issues.some((issue) => issue.path.join('.') === 'child'),
    );
    assert.ok(
      result.error.issues.some((issue) => issue.path.join('.') === 'entries'),
    );
  }
});

void test('property bound syntax is eagerly validated in unused schemas before selection', async () => {
  for (const keyword of ['minProperties', 'maxProperties'])
    for (const value of [
      null,
      -1,
      0.5,
      '1',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
    ]) {
      const document = fixture();
      document.components.schemas.Unused = { type: 'object', [keyword]: value };
      await rejectsAt(
        document,
        `components.schemas.Unused.${keyword}`,
        /nonnegative safe integer/,
      );
    }
  for (const invalid of [
    { type: 'object', minProperties: 2, maxProperties: 1 },
    { type: ['object', 'null'], minProperties: 2, maxProperties: 1 },
    {
      type: 'object',
      additionalProperties: { type: 'integer' },
      minProperties: 2,
      maxProperties: 1,
    },
  ]) {
    const document = fixture();
    document.components.schemas.Unused = invalid;
    await rejectsAt(
      document,
      'components.schemas.Unused',
      /minProperties exceeds maxProperties/,
    );
  }
  for (const bounds of [
    { minProperties: 0, maxProperties: 0 },
    { minProperties: Number.MAX_SAFE_INTEGER },
    { maxProperties: Number.MAX_SAFE_INTEGER },
  ]) {
    const document = fixture();
    document.components.schemas.Unused = { type: 'object', ...bounds };
    assert.deepEqual(await compile(document, selection), files);
  }
});

void test('object reference bounds intersect through aliases and reject contradictory or misplaced constraints', async () => {
  const document = fixture();
  document.components.schemas.Unused = {
    $ref: '#/components/schemas/Alias',
    minProperties: 3,
  };
  await rejectsAt(
    document,
    'components.schemas.Unused',
    /minProperties exceeds maxProperties/,
  );
  for (const schema of [
    { type: 'string' },
    { type: 'array', items: { type: 'string' } },
    { anyOf: [{ type: 'string' }, { type: 'null' }] },
  ]) {
    const invalid = fixture();
    invalid.components.schemas.Unused = { ...schema, minProperties: 1 };
    await rejectsAt(
      invalid,
      'components.schemas.Unused.minProperties',
      /unsupported keyword/,
    );
  }
  const wrongReference = fixture();
  wrongReference.components.schemas.Text = { type: 'string' };
  wrongReference.components.schemas.Unused = {
    $ref: '#/components/schemas/Text',
    maxProperties: 1,
  };
  await rejectsAt(
    wrongReference,
    'components.schemas.Unused.maxProperties',
    /unsupported on referenced string/,
  );
});

void test('property bounds remain enforced for multipart request object schemas', async (t) => {
  const document = fixture();
  document.components.schemas.Upload = {
    type: 'object',
    properties: {
      caption: { type: 'string' },
      file: { type: 'string', format: 'binary' },
    },
    minProperties: 2,
    maxProperties: 2,
  };
  const paths = {
    '/upload': {
      post: {
        operationId: 'upload',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: { $ref: '#/components/schemas/Upload' },
            },
          },
        },
        responses: { 204: { description: 'Uploaded' } },
      },
    },
  };
  const uploadRoot = await generatedWorkspace(
    await compile(
      { ...document, paths },
      {
        clients: ['browser', 'native'],
        targets: { browser: 'browser', native: 'native' },
        surfaces: { browser: ['upload'], native: ['upload'] },
      },
    ),
  );
  t.after(() => rm(uploadRoot, { recursive: true, force: true }));
  for (const [name, file] of [
    ['browser', new File(['file'], 'file.txt')],
    ['native', { uri: 'file:///synthetic/file.txt' }],
  ] as const) {
    const module = await importGenerated<RuntimeClient>(
      uploadRoot,
      `client.${name}.ts`,
    );
    const upload = present(module.operations.upload);
    assert.equal(
      upload.build({ body: { caption: 'caption', file } }).bodyKind,
      'multipart',
    );
    assert.throws(
      () => upload.build({ body: { file } }),
      module.RequestValidationError,
    );
  }
});

void test('bounded multipart optional file arrays require an effective nonempty constraint before generation', async (t) => {
  const options = {
    clients: ['browser', 'native'],
    targets: { browser: 'browser', native: 'native' },
    surfaces: { browser: ['upload'], native: ['upload'] },
  } as const;
  const array: Schema = {
    type: 'array',
    items: { type: 'string', format: 'binary' },
  };
  const upload = (files: Schema, bounded = true, required = false): Schema => ({
    type: 'object',
    properties: { caption: { type: 'string' }, files },
    required: required ? ['caption', 'files'] : ['caption'],
    ...(bounded ? { minProperties: 1, maxProperties: 2 } : {}),
  });
  const document = (
    schema: Schema,
    definitions: Record<string, Schema> = {},
  ) => ({
    openapi: '3.1.1',
    info: { title: 'Synthetic multipart counts', version: '1' },
    components: { schemas: definitions },
    paths: {
      '/upload': {
        post: {
          operationId: 'upload',
          requestBody: {
            required: true,
            content: { 'multipart/form-data': { schema } },
          },
          responses: { 204: { description: 'Uploaded' } },
        },
      },
    },
  });
  const message =
    /multipart property-count bounds require optional file arrays to declare minItems >= 1/;
  const invalid = [
    document(upload(array)),
    document(upload({ ...array, minItems: 0 })),
    document(
      { $ref: '#/components/schemas/Bounded' },
      {
        Upload: upload(array, false),
        Bounded: { $ref: '#/components/schemas/Upload', minProperties: 1 },
      },
    ),
    document(
      { $ref: '#/components/schemas/Upload' },
      {
        Files: array,
        FilesAlias: { $ref: '#/components/schemas/Files', minItems: 0 },
        Upload: upload({ $ref: '#/components/schemas/FilesAlias' }),
      },
    ),
  ];
  for (const input of invalid) {
    const before = structuredClone(input);
    const schema =
      input.paths['/upload'].post.requestBody.content['multipart/form-data']
        .schema;
    const source =
      'paths./upload.post.requestBody.content.multipart/form-data.schema';
    await assert.rejects(compile(input, options), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(
        error.location,
        Object.hasOwn(schema, 'properties')
          ? `${source}.properties.files`
          : source,
      );
      if (!Object.hasOwn(schema, 'properties'))
        assert.match(error.message, /field "files"/);
      assert.match(error.message, message);
      return true;
    });
    assert.deepEqual(input, before);
  }
  const unused = fixture();
  Object.assign(unused.components, {
    requestBodies: {
      Unused: {
        required: true,
        content: { 'multipart/form-data': { schema: upload(array) } },
      },
    },
  });
  await rejectsAt(
    unused,
    'components.requestBodies.Unused.content.multipart/form-data.schema.properties.files',
    message,
  );
  const accepted = [
    {
      input: document(upload({ ...array, minItems: 1 })),
      empty: false,
      required: false,
    },
    {
      input: document(
        { $ref: '#/components/schemas/Bounded' },
        {
          Files: { ...array, minItems: 1 },
          FilesAlias: { $ref: '#/components/schemas/Files' },
          Upload: upload({ $ref: '#/components/schemas/FilesAlias' }, false),
          Bounded: { $ref: '#/components/schemas/Upload', maxProperties: 2 },
        },
      ),
      empty: false,
      required: false,
    },
    {
      input: document(upload({ $ref: '#/components/schemas/FilesAlias' }), {
        Files: array,
        FilesAlias: { $ref: '#/components/schemas/Files', minItems: 1 },
      }),
      empty: false,
      required: false,
    },
    {
      input: document(upload(array, true, true)),
      empty: false,
      required: true,
    },
    { input: document(upload(array, false)), empty: true, required: false },
  ];
  for (const { input, empty, required } of accepted) {
    const output = await generatedWorkspace(await compile(input, options));
    t.after(() => rm(output, { recursive: true, force: true }));
    for (const [name, file] of [
      ['browser', new File(['file'], 'file.txt')],
      ['native', { uri: 'file:///synthetic/file.txt' }],
    ] as const) {
      const module = await importGenerated<RuntimeClient>(
        output,
        `client.${name}.ts`,
      );
      const operation = present(module.operations.upload);
      const built = operation.build({
        body: { caption: 'caption', files: [file] },
      });
      assert.equal(built.bodyKind, 'multipart');
      assert.deepEqual(built.body, { caption: 'caption', files: [file] });
      if (empty) {
        assert.deepEqual(
          operation.build({ body: { caption: 'caption', files: [] } }).body,
          { caption: 'caption', files: [] },
        );
      } else {
        assert.throws(
          () => operation.build({ body: { caption: 'caption', files: [] } }),
          module.RequestValidationError,
        );
      }
      if (!required) {
        assert.deepEqual(
          operation.build({ body: { caption: 'caption' } }).body,
          { caption: 'caption' },
        );
      }
    }
  }
});

void test('property bounds preserve source and emitted files on invalid generation and read-only checks', async (t) => {
  const directory = await temporary(t);
  const input = join(directory, 'openapi.json');
  const config = join(directory, 'pom.json');
  const output = join(directory, 'generated');
  await writeFile(input, JSON.stringify(fixture()));
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      ...selection,
    }),
  );
  await runProject(config);
  const snapshot = await fileSnapshot(output);
  const documents = [];
  for (const invalid of [
    { type: 'object', minProperties: -1 },
    { $ref: '#/components/schemas/Alias', minProperties: 3 },
  ]) {
    const document = fixture();
    document.components.schemas.Unused = invalid;
    documents.push(document);
  }
  const multipart = fixture();
  Object.assign(multipart.components, {
    requestBodies: {
      Unused: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              minProperties: 1,
              properties: {
                files: {
                  type: 'array',
                  items: { type: 'string', format: 'binary' },
                },
              },
            },
          },
        },
      },
    },
  });
  documents.push(multipart);
  for (const document of documents) {
    const source = JSON.stringify(document);
    await writeFile(input, source);
    for (const check of [false, true])
      await assert.rejects(runProject(config, { check }), ContractError);
    assert.deepEqual(await fileSnapshot(output), snapshot);
    assert.equal(await readFile(input, 'utf8'), source);
  }
});

void test('object bound types retain structural fields through source and declaration-only consumers', async () => {
  await writeFile(join(root, 'consumer.ts'), propertyCountConsumer);
  const options = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    exactOptionalPropertyTypes: true,
    types: [],
  };
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        ...options,
        allowImportingTsExtensions: true,
        declaration: true,
        emitDeclarationOnly: true,
        isolatedDeclarations: true,
        outDir: './declarations',
      },
      include: ['./*.ts'],
    }),
  );
  const tsc = fileURLToPath(
    new URL('../node_modules/typescript/bin/tsc', import.meta.url),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')]);
  await writeFile(
    join(root, 'published.ts'),
    `
    import { build } from './declarations/consumer.js';
    build({body:{a:'a',b:'b'}});
    // @ts-expect-error Declaration emit retains field types.
    build({body:{a:1,b:'b'}});
  `,
  );
  await writeFile(
    join(root, 'published.json'),
    JSON.stringify({
      compilerOptions: { ...options, noEmit: true },
      include: ['./published.ts', './declarations/*.d.ts'],
    }),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'published.json')]);
});
