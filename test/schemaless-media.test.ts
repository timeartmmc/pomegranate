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
import type {
  ObservedResponse,
  PreparedRequest,
  ProtocolResult,
  RequestValidationError,
  Responses,
} from '../src/runtime.ts';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { Schema } from './schema-helpers.ts';

type Media = { schema?: Schema };
// The schema each media entry stands for when it declares none.
const unconstrained = (text: boolean): Schema =>
  text ? { type: 'string' } : {};

function fixture(modern: boolean, explicit: boolean) {
  const media = (text = false): Media =>
    explicit ? { schema: unconstrained(text) } : {};
  const operation = (operationId: string, content: Record<string, Media>) => ({
    operationId,
    requestBody: { required: true, content: structuredClone(content) },
    responses: { 200: { description: 'Echo', content } },
  });
  return {
    openapi: modern ? '3.1.2' : '3.0.4',
    info: { title: 'Synthetic media without schemas', version: '1' },
    paths: {
      '/json': { post: operation('json', { 'application/json': media() }) },
      '/suffix': {
        post: operation('suffix', { 'application/vnd.note+json': media() }),
      },
      '/text': { post: operation('text', { 'text/plain': media(true) }) },
      '/optional': {
        post: {
          operationId: 'optional',
          requestBody: { content: { 'application/json': media() } },
          responses: {
            200: {
              description: 'Any decodable representation',
              content: { '*/*': media() },
            },
          },
        },
      },
    },
  };
}

const selection = {
  clients: ['consumer'],
  surfaces: { consumer: ['json', 'suffix', 'text', 'optional'] },
};

interface Client {
  operations: Record<
    string,
    {
      build(input?: unknown): PreparedRequest<Responses>;
      parseResponse(response: ObservedResponse): ProtocolResult<Responses>;
    }
  >;
  RequestValidationError: typeof RequestValidationError;
}

void test('a media entry without a schema generates its unconstrained schema in both dialects and YAML', async () => {
  for (const modern of [true, false]) {
    const expected = await compile(fixture(modern, true), selection);
    const document = fixture(modern, false);
    const before = structuredClone(document);
    assert.deepEqual(await compile(document, selection), expected);
    assert.deepEqual(document, before);
    assert.deepEqual(
      await compile(parseYaml(stringify(document), 'media.yaml'), selection),
      expected,
    );
  }
  assert.deepEqual(
    await compile(fixture(false, false), selection),
    await compile(fixture(true, false), selection),
  );
});

void test('schemaless JSON accepts any JSON value and schemaless text any string, in requests and responses', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(true, false), selection),
  );
  const client = await importGenerated<Client>(root, 'client.consumer.ts');
  const operation = (name: string) => present(client.operations[name]);
  const values = [null, false, 0, '', 'text', [], [1, [null]], { a: { b: 1 } }];
  for (const name of ['json', 'suffix'])
    for (const value of values) {
      const request = operation(name).build({ body: value });
      assert.equal(request.bodyKind, 'json');
      if (request.bodyKind === 'json') assert.deepEqual(request.body, value);
      const result = operation(name).parseResponse({
        status: 200,
        headers: {
          'Content-Type':
            name === 'json' ? 'application/json' : 'application/vnd.note+json',
        },
        body: JSON.stringify(value),
      });
      assert.equal(result.kind, 'success');
      assert.deepEqual(result.data, value);
    }
  // Unconstrained still means JSON: values without a JSON form stay invalid.
  for (const body of [undefined, NaN, Infinity, 1n, () => 1, [undefined]])
    assert.throws(
      () => operation('json').build({ body }),
      client.RequestValidationError,
    );
  for (const body of ['{', 'undefined', ''])
    assert.equal(
      operation('json').parseResponse({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body,
      }).kind,
      'protocol',
    );
  for (const value of ['', 'plain', '{"not":"parsed"}', 'line\nbreak']) {
    const request = operation('text').build({ body: value });
    assert.equal(request.bodyKind, 'text');
    if (request.bodyKind === 'text') assert.equal(request.body, value);
    const result = operation('text').parseResponse({
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: value,
    });
    assert.equal(result.kind, 'success');
    assert.equal(result.data, value);
  }
  for (const body of [null, 1, {}, ['text']])
    assert.throws(
      () => operation('text').build({ body }),
      client.RequestValidationError,
    );
  // The request body keeps its declared optionality.
  assert.equal(operation('optional').build().bodyKind, 'none');
  assert.equal(operation('optional').build({ body: null }).bodyKind, 'json');
  assert.throws(() => operation('json').build(), client.RequestValidationError);
  // A schemaless range accepts whatever its decoder produces, and nothing
  // that it cannot decode.
  for (const [contentType, body, data] of [
    ['application/json', '{"a":1}', { a: 1 }],
    ['application/problem+json', '[]', []],
    ['text/plain', '{"a":1}', '{"a":1}'],
    ['text/plain', '', ''],
  ] as const) {
    const result = operation('optional').parseResponse({
      status: 200,
      headers: { 'Content-Type': contentType },
      body,
    });
    assert.equal(result.kind, 'success', contentType);
    assert.deepEqual(result.data, data);
  }
  for (const contentType of ['application/octet-stream', 'text/html'])
    assert.equal(
      operation('optional').parseResponse({
        status: 200,
        headers: { 'Content-Type': contentType },
        body: '{}',
      }).kind,
      'protocol',
    );
  await writeFile(
    join(root, 'consumer.ts'),
    `
    import { operations } from './client.consumer.ts';
    import type { JsonValue } from './runtime.ts';
    operations.json.build({ body: { any: ['json', 1, null] } });
    operations.json.build({ body: null });
    // @ts-expect-error A schemaless JSON body is still required.
    operations.json.build();
    // @ts-expect-error Undefined is not a JSON value.
    operations.json.build({ body: undefined });
    // @ts-expect-error Functions are not JSON values.
    operations.json.build({ body: () => 1 });
    operations.text.build({ body: 'any text' });
    // @ts-expect-error Schemaless text accepts only strings.
    operations.text.build({ body: 1 });
    operations.optional.build();
    const observed = { status: 200, headers: {}, body: '' };
    const json = operations.json.parseResponse(observed);
    if (json.kind === 'success') {
      const data: JsonValue = json.data;
      // @ts-expect-error Any JSON value is not known to be an object.
      void json.data.field;
      void data;
    }
    const text = operations.text.parseResponse(observed);
    if (text.kind === 'success') { const data: string = text.data; void data; }
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

void test('a declared schema must still be a schema, and multipart fields still need one', async () => {
  const rejects = async (
    change: (document: ReturnType<typeof fixture>) => void,
    location: string,
    message: RegExp,
  ) => {
    for (const modern of [true, false]) {
      const document = fixture(modern, false);
      change(document);
      await assert.rejects(compile(document, selection), (error) => {
        assert.ok(error instanceof ContractError, location);
        assert.equal(error.location, location);
        assert.match(error.message, message, location);
        return true;
      });
    }
  };
  const content = 'paths./json.post.requestBody.content';
  // Presence decides: only an absent schema is unconstrained.
  for (const schema of [null, undefined, 1, 'string', []])
    await rejects(
      (document) => {
        Object.assign(
          document.paths['/json'].post.requestBody.content['application/json']!,
          { schema },
        );
      },
      `${content}.application/json.schema`,
      /expected an object$/,
    );
  await rejects(
    (document) => {
      document.paths['/json'].post.requestBody.content['multipart/form-data'] =
        {};
    },
    `${content}.multipart/form-data.schema`,
    /expected an object$/,
  );
  await rejects(
    (document) => {
      Object.assign(
        document.paths['/json'].post.requestBody.content['application/json']!,
        { encoding: {} },
      );
    },
    `${content}.application/json.encoding`,
    /unsupported keyword/,
  );
});
