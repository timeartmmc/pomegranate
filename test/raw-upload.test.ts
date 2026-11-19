import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { compile, ContractError } from '../dist/index.js';
import type { ClientConfig, Success } from '../src/execution-runtime.ts';
import type {
  PreparedRequest,
  RequestValidationError,
  Responses,
} from '../src/runtime.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import {
  rawUploadFixture,
  rawUploadMediaType,
  rawUploadSelection,
} from './raw-upload-fixture.ts';

type Upload = 'upload' | 'uploadOptional';
type RawUploadModule = {
  operations: Record<
    Upload,
    {
      build: (input?: unknown) => PreparedRequest<Responses, 'binary' | 'none'>;
    }
  >;
  createClient: (
    config: ClientConfig,
  ) => Record<
    Upload,
    { call: (input: unknown) => Promise<Success<Responses>> }
  >;
  RequestValidationError: typeof RequestValidationError;
};

async function generated(t: import('node:test').TestContext) {
  const root = await generatedTestWorkspace(
    t,
    await compile(rawUploadFixture(), rawUploadSelection),
  );
  return importGenerated<RawUploadModule>(root, 'client.consumer.ts');
}

void test('raw upload declarations share one generated request format', async () => {
  const baseline = await compile(rawUploadFixture({}), rawUploadSelection);
  for (const openapi of ['3.0.4', '3.1.2'])
    for (const media of [
      {},
      { schema: {} },
      { schema: { type: 'string', format: 'binary' } },
      ...(openapi === '3.1.2'
        ? [
            { schema: { contentMediaType: rawUploadMediaType } },
            { schema: { contentMediaType: 'image/png' } },
            {
              schema: { type: 'string', contentMediaType: rawUploadMediaType },
            },
            {
              schema: {
                type: 'string',
                format: 'binary',
                contentMediaType: 'image/png',
              },
            },
          ]
        : []),
    ])
      assert.deepEqual(
        await compile(rawUploadFixture(media, openapi), rawUploadSelection),
        baseline,
      );
  const alias = rawUploadFixture({
    schema: { $ref: '#/components/schemas/Binary', maxLength: 4 },
  });
  Object.assign(alias, {
    components: { schemas: { Binary: { type: 'string', format: 'binary' } } },
  });
  const bounded = await compile(rawUploadFixture(), rawUploadSelection);
  assert.deepEqual(await compile(alias, rawUploadSelection), bounded);
  assert.deepEqual(
    await compile(
      rawUploadFixture(
        { schema: { type: 'string', format: 'binary', maxLength: 4 } },
        '3.0.4',
      ),
      rawUploadSelection,
    ),
    bounded,
  );
});

void test('raw content declarations ignore inherited schema keywords', async () => {
  const input = rawUploadFixture({
    schema: { type: 'string', contentMediaType: rawUploadMediaType },
  });
  const expected = await compile(input, rawUploadSelection);
  for (const [name, value] of [
    ['format', 'binary'],
    ['maxLength', 1],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, name);
    try {
      Object.defineProperty(Object.prototype, name, {
        configurable: true,
        value,
      });
      assert.deepEqual(await compile(input, rawUploadSelection), expected);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, name, previous);
      else Reflect.deleteProperty(Object.prototype, name);
    }
  }
});

void test('raw builders copy only the supplied byte view and distinguish empty from absent', async (t) => {
  const { operations } = await generated(t);
  const backing = Buffer.from([99, 0, 255, 13, 10, 77]);
  const input = backing.subarray(1, 5);
  const request = operations.upload.build({ body: input });
  assert.equal(request.bodyKind, 'binary');
  assert.equal(request.contentType, rawUploadMediaType);
  assert.ok(request.body.buffer instanceof ArrayBuffer);
  assert.equal(request.body.buffer.byteLength, 4);
  assert.notEqual(request.body.buffer, input.buffer);
  input.fill(8);
  assert.deepEqual([...request.body], [0, 255, 13, 10]);

  const foreign: unknown = runInNewContext('new Uint8Array([7, 255])');
  const crossRealm = operations.upload.build({ body: foreign });
  assert.equal(crossRealm.bodyKind, 'binary');
  assert.deepEqual([...crossRealm.body], [7, 255]);

  for (const getRequest of [
    operations.upload.build,
    operations.uploadOptional.build,
  ]) {
    const empty = getRequest({ body: new Uint8Array() });
    assert.equal(empty.bodyKind, 'binary');
    assert.equal(empty.contentType, rawUploadMediaType);
    assert.equal(empty.body.byteLength, 0);
  }
  for (const input of [undefined, { body: undefined }]) {
    const absent = operations.uploadOptional.build(input);
    assert.equal(absent.bodyKind, 'none');
    assert.equal(Object.hasOwn(absent, 'body'), false);
    assert.equal(Object.hasOwn(absent, 'contentType'), false);
  }

  const result = request.parseResponse({
    status: 413,
    headers: { 'content-type': 'text/plain' },
    body: 'too large',
  });
  assert.equal(result.kind, 'error');
  assert.equal(result.data, 'too large');
});

void test('raw calls snapshot bytes before delegation and reject invalid bodies before invoking transport', async (t) => {
  const { createClient, RequestValidationError } = await generated(t);
  const received: number[][] = [];
  const client = createClient({
    namespace: 'synthetic-raw-upload',
    execute: async (request) => {
      await Promise.resolve();
      assert.equal(request.bodyKind, 'binary');
      const bytes = [...request.body];
      received.push(bytes);
      return {
        status: 201,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ size: bytes.length }),
      };
    },
  });
  const input = Uint8Array.of(255, 0, 13);
  const pending = client.upload.call({ context: {}, input: { body: input } });
  input.fill(8);
  const result = await pending;
  assert.equal(result.status, 201);
  assert.deepEqual(result.data, { size: 3 });

  const detached = Uint8Array.of(3);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  const fake: unknown = Object.create(Uint8Array.prototype);
  for (const body of [
    undefined,
    null,
    'bytes',
    [1],
    new ArrayBuffer(1),
    new Uint8ClampedArray(1),
    new Uint8Array(5),
    new Uint8Array(new SharedArrayBuffer(1)),
    new Proxy(Uint8Array.of(1), {}),
    fake,
    detached,
  ])
    await assert.rejects(
      client.upload.call({ context: {}, input: { body } }),
      RequestValidationError,
    );
  const oversized = new Uint8Array(5);
  Object.defineProperty(oversized, 'byteLength', { value: 0 });
  await assert.rejects(
    client.upload.call({ context: {}, input: { body: oversized } }),
    (error) => {
      assert.ok(error instanceof RequestValidationError);
      assert.deepEqual(error.issues, [
        { path: ['body'], message: 'expected at most 4 bytes' },
      ]);
      return true;
    },
  );
  const reason = new Error('Upload cancelled');
  await assert.rejects(
    client.upload.call({
      context: {},
      input: { body: Uint8Array.of(1) },
      signal: AbortSignal.abort(reason),
    }),
    (error) => error === reason,
  );
  assert.deepEqual(received, [[255, 0, 13]]);
});

void test('raw uploads reject incompatible schemas, binary response media, and media parameters', async () => {
  for (const schema of [
    { type: 'string' },
    { type: 'object' },
    { type: 'string', format: 'binary', maxLength: -1 },
    { contentMediaType: 123 },
    { contentMediaType: 'not a media type' },
    { contentEncoding: 'base64' },
  ])
    await assert.rejects(
      compile(rawUploadFixture({ schema }), rawUploadSelection),
      ContractError,
    );
  const response = rawUploadFixture();
  Object.assign(response.paths['/upload'].post.responses[201].content, {
    [rawUploadMediaType]: {},
  });
  await assert.rejects(compile(response, rawUploadSelection), ContractError);
  const request = rawUploadFixture();
  Object.assign(request.paths['/upload'].post.requestBody, {
    content: { [rawUploadMediaType + '; charset=utf-8']: {} },
  });
  await assert.rejects(compile(request, rawUploadSelection), ContractError);
});
