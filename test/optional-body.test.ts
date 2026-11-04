import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { compile } from '../dist/index.js';
import { execute } from '../examples/json/transport.ts';
import type { RequestValidationError } from '../src/runtime.ts';
import { entry } from './assertions.ts';
import { generatedWorkspace } from './generated-workspace.ts';

type ClientModule = {
  operations: Record<
    string,
    { build: (input?: unknown) => Parameters<typeof execute>[0] }
  >;
  RequestValidationError: typeof RequestValidationError;
};
const json = (schema: unknown) => ({
  content: { 'application/json': { schema } },
});
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({ type: 'object', properties, required });
function operation(operationId: string, schema: unknown) {
  return {
    operationId,
    'x-pom': {
      auth: 'public',
      retry: 'never',
      timeout: 'interactive',
      surfaces: ['consumer'],
    },
    requestBody: json(schema),
    responses: { 204: { description: 'Accepted' } },
  };
}
function fixture() {
  const directional = object(
    {
      id: { type: 'string', readOnly: true },
      secret: { type: 'string', writeOnly: true },
      label: { type: 'string' },
    },
    ['id', 'secret', 'label'],
  );
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic optional JSON bodies', version: '1' },
    'x-pom-policy': {
      version: 3,
      auth: { public: { transport: 'none' } },
      fields: {
        retry: { type: 'string', enum: ['never'] },
        timeout: { type: 'string', enum: ['interactive'] },
      },
      required: ['auth', 'retry', 'timeout'],
      surfaces: ['consumer'],
    },
    components: { schemas: { Directional: directional } },
    paths: {
      '/nullable': {
        post: operation('nullable', { type: ['string', 'null'] }),
      },
      '/string': { post: operation('string', { type: 'string' }) },
      '/boolean': { post: operation('boolean', { type: 'boolean' }) },
      '/integer': { post: operation('integer', { type: 'integer' }) },
      '/defaults': {
        post: operation('defaults', {
          ...object(
            {
              required: { type: 'boolean', default: true },
              count: { type: 'integer', default: 4 },
            },
            ['required'],
          ),
          default: { required: true, count: 4 },
        }),
      },
      '/empty': {
        post: operation(
          'empty',
          object({ id: { type: 'string', readOnly: true } }, ['id']),
        ),
      },
      '/directional': {
        post: {
          ...operation('directional', {
            $ref: '#/components/schemas/Directional',
          }),
          responses: {
            200: {
              description: 'Projected response',
              ...json({ $ref: '#/components/schemas/Directional' }),
            },
          },
        },
      },
    },
  };
}
let root: string;
let module: ClientModule;
const build = (id: string, input?: unknown) =>
  entry(module.operations, id).build(input);
before(async () => {
  root = await generatedWorkspace(
    await compile(fixture(), { clients: ['consumer'] }),
  );
  module = (await import(
    pathToFileURL(join(root, 'client.consumer.ts')).href
  )) as ClientModule;
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

void test('optional JSON preserves falsy values, annotation defaults and directional projection', () => {
  for (const [id, value] of [
    ['nullable', null],
    ['string', ''],
    ['boolean', false],
    ['integer', 0],
  ] as const) {
    const request = build(id, { body: value });
    assert.equal(request.bodyKind, 'json');
    assert.equal(request.bodyKind === 'json' && request.body, value);
    if (id !== 'nullable')
      assert.throws(
        () => build(id, { body: null }),
        module.RequestValidationError,
      );
  }
  for (const id of ['defaults', 'empty', 'directional']) {
    assert.equal(build(id).bodyKind, 'none');
    const request = build(id, { body: undefined });
    assert.equal(request.bodyKind, 'none');
    assert.equal(Object.hasOwn(request, 'body'), false);
  }
  assert.throws(
    () => build('defaults', { body: {} }),
    module.RequestValidationError,
  );
  const defaults = build('defaults', { body: { required: false } });
  assert.deepEqual(defaults.bodyKind === 'json' && defaults.body, {
    required: false,
  });
  const empty = build('empty', { body: {} });
  assert.deepEqual(empty.bodyKind === 'json' && empty.body, {});
  assert.throws(
    () => build('empty', { body: { id: 'forbidden' } }),
    module.RequestValidationError,
  );
  const directional = build('directional', {
    body: { secret: 'request-only', label: 'value' },
  });
  assert.deepEqual(directional.bodyKind === 'json' && directional.body, {
    secret: 'request-only',
    label: 'value',
  });
  assert.throws(
    () =>
      build('directional', {
        body: { id: 'forbidden', secret: 'value', label: 'value' },
      }),
    module.RequestValidationError,
  );
  const response = build('directional').parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: '{"id":"response-only","label":"value"}',
  });
  assert.equal(response.kind, 'success');
  assert.deepEqual(response.data, { id: 'response-only', label: 'value' });
  assert.equal(
    build('directional').parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '',
    }).kind,
    'protocol',
  );
  const inherited = Object.getOwnPropertyDescriptor(Object.prototype, 'body');
  try {
    Object.defineProperty(Object.prototype, 'body', {
      configurable: true,
      value: 'inherited',
    });
    const request = build('nullable', {});
    assert.equal(request.bodyKind, 'none');
    assert.equal(Object.hasOwn(request, 'body'), false);
  } finally {
    if (inherited) Object.defineProperty(Object.prototype, 'body', inherited);
    else Reflect.deleteProperty(Object.prototype, 'body');
  }
});

void test('the JSON example transport omits content type and bytes for absent optional bodies through Fetch', async () => {
  const observed: { contentType: string | undefined; body: string }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      observed.push({
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString(),
      });
      response.writeHead(204).end();
    })().catch((error) => {
      response.writeHead(500).end(String(error));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const tokenFor = async () => {
      assert.fail('public requests do not resolve tokens');
    };
    for (const input of [undefined, {}, { body: undefined }, { body: null }])
      assert.equal(
        (
          await execute(
            build('nullable', input),
            fetch,
            tokenFor,
            `http://127.0.0.1:${address.port}`,
          )
        ).kind,
        'success',
      );
    for (const [id, value] of [
      ['string', ''],
      ['boolean', false],
      ['integer', 0],
    ] as const)
      await execute(
        build(id, { body: value }),
        fetch,
        tokenFor,
        `http://127.0.0.1:${address.port}`,
      );
  } finally {
    server.close();
    await once(server, 'close');
  }
  assert.deepEqual(observed, [
    { contentType: undefined, body: '' },
    { contentType: undefined, body: '' },
    { contentType: undefined, body: '' },
    { contentType: 'application/json', body: 'null' },
    { contentType: 'application/json', body: '""' },
    { contentType: 'application/json', body: 'false' },
    { contentType: 'application/json', body: '0' },
  ]);
});

void test('optional JSON keeps unsupported body forms and query selections explicit', async () => {
  for (const required of [undefined, null, 'false', 0]) {
    const document = fixture();
    Object.assign(document.paths['/nullable'].post.requestBody, { required });
    await assert.rejects(
      compile(document, { clients: ['consumer'] }),
      /requestBody.required.*expected a boolean/,
    );
  }
  for (const required of [undefined, false]) {
    const document = fixture();
    Object.assign(document.paths['/nullable'].post, {
      requestBody: {
        ...(required === undefined ? {} : { required }),
        content: {
          'multipart/form-data': {
            schema: object({ caption: { type: 'string' } }),
          },
        },
      },
    });
    await assert.rejects(
      compile(document, { clients: ['consumer'] }),
      /requestBody.required.*multipart/,
    );
  }
  for (const method of ['get', 'head']) {
    const document = fixture();
    Object.assign(document.paths['/nullable'], {
      [method]: document.paths['/nullable'].post,
    });
    Reflect.deleteProperty(document.paths['/nullable'], 'post');
    await assert.rejects(
      compile(document, { clients: ['consumer'] }),
      new RegExp(
        `${method}\\.requestBody: ${method.toUpperCase()} bodies are unsupported`,
      ),
    );
  }
  const rootReadOnly = fixture();
  Object.assign(rootReadOnly.paths['/nullable'].post, {
    requestBody: json({ type: 'string', readOnly: true }),
  });
  await assert.rejects(
    compile(rootReadOnly, { clients: ['consumer'] }),
    /readOnly schemas may only be omitted as object properties/,
  );
  await assert.rejects(
    compile(fixture(), {
      clients: ['consumer'],
      queries: { consumer: ['nullable'] },
    }),
    /queries support only bodyless GET and HEAD/,
  );
  await assert.rejects(
    compile(fixture(), {
      clients: ['consumer'],
      infiniteQueries: {
        consumer: {
          nullable: { cursor: 'cursor', nextCursor: 'next', items: 'items' },
        },
      },
    }),
    /infinite queries require a bodyless GET/,
  );
});
