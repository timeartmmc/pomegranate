import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { compile } from '../dist/index.js';
import { fixture } from './helpers.mjs';

const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
let root;
let operations;
let RequestValidationError;
let staffOperations;
let consumerSchemas;
let staffSchemas;
let execute;

before(async () => {
  const cache = join(repo, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  root = await mkdtemp(join(cache, 'pom-generated-'));
  await mkdir(join(root, 'generated'));
  const document = fixture();
  document.components.schemas.Widget.properties.details = {
    type: 'object',
    required: ['visible'],
    properties: { visible: { type: 'boolean' } },
  };
  const preparation =
    document.paths['/api/widgets/{widgetId}/preparations'].post;
  preparation.parameters.push(
    { name: 'X-Tab', in: 'header', schema: { type: 'string', const: 'a\tb' } },
    {
      name: 'X-Padded',
      in: 'header',
      schema: { type: 'string', const: ' a ' },
    },
  );
  preparation.responses['202'].headers['X-Tab'] = {
    schema: { type: 'string', const: 'a\tb' },
  };
  document.paths['/api/widgets/{widgetId}'].get.parameters.push(
    { name: 'q', in: 'query', schema: { type: 'string' } },
    { name: '🔍', in: 'query', schema: { type: 'string' } },
    {
      name: 'brokenConst',
      in: 'query',
      schema: { type: 'string', const: '\ud800' },
    },
  );
  for (const [name, source] of Object.entries(
    await compile(document, { clients: ['consumer', 'staff'] }),
  ))
    await writeFile(join(root, 'generated', name), source);
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  const config = JSON.parse(
    await readFile(join(repo, 'examples/json/tsconfig.json'), 'utf8'),
  );
  config.compilerOptions.outDir = 'built';
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify(config));
  await cp(
    join(repo, 'test/consumer-types.ts'),
    join(root, 'consumer-types.ts'),
  );
  await cp(
    join(repo, 'examples/json/transport.ts'),
    join(root, 'transport.ts'),
  );
  await exec(process.execPath, [
    join(repo, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
  ({ operations, RequestValidationError } = await import(
    pathToFileURL(join(root, 'built/generated/client.consumer.js')).href
  ));
  ({ operations: staffOperations } = await import(
    pathToFileURL(join(root, 'built/generated/client.staff.js')).href
  ));
  consumerSchemas = await import(
    pathToFileURL(join(root, 'built/generated/client.consumer.schemas.js')).href
  );
  staffSchemas = await import(
    pathToFileURL(join(root, 'built/generated/client.staff.schemas.js')).href
  );
  ({ execute } = await import(
    pathToFileURL(join(root, 'built/transport.js')).href
  ));
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function options() {
  return {
    path: { widgetId: 'widget' },
    headers: { 'Idempotency-Key': 'attempt' },
    body: { acknowledged: true, label: 'Example' },
  };
}
function observed(status, data, headers = {}) {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Request-ID': 'request-1',
      ...headers,
    },
    body: JSON.stringify(data),
  };
}

test('clients account for exactly their selected operations and directional schema closures', () => {
  assert.deepEqual(Object.keys(operations).sort(), [
    'checkHealth',
    'getWidget',
    'prepareWidget',
    'widgetOptions',
  ]);
  assert.deepEqual(Object.keys(staffOperations).sort(), [
    'checkHealth',
    'getStaffReport',
    'getWidget',
  ]);
  assert.deepEqual(Object.keys(consumerSchemas.requestSchemas).sort(), [
    'PreparationInput',
    'WidgetId',
  ]);
  assert.deepEqual(Object.keys(consumerSchemas.responseSchemas).sort(), [
    'Conflict',
    'Pending',
    'Problem',
    'Refusal',
    'Widget',
    'WidgetId',
  ]);
  assert.deepEqual(Object.keys(staffSchemas.requestSchemas), ['WidgetId']);
  assert.deepEqual(Object.keys(staffSchemas.responseSchemas).sort(), [
    'Problem',
    'StaffPeriod',
    'StaffReport',
    'StaffSummary',
    'Widget',
    'WidgetId',
  ]);
  assert.deepEqual(staffOperations.getStaffReport.build().policy.auth, {
    label: 'partnerStaff',
    transport: 'bearer',
  });
  assert.deepEqual(operations.checkHealth.build().policy.auth, {
    label: 'public',
    transport: 'none',
  });
});

test('application transport resolves bearer labels and sends public overrides without credentials', async () => {
  const request = operations.prepareWidget.build(options());
  const result = await execute(
    request,
    async (_url, init) => {
      assert.equal(
        new Headers(init.headers).get('Authorization'),
        'Bearer app-owned-token',
      );
      return new Response(
        JSON.stringify({ state: 'pending', reference: 'app-ref' }),
        {
          status: 202,
          headers: {
            'Content-Type': 'application/json',
            'X-Request-ID': 'app-request',
          },
        },
      );
    },
    async (label) => {
      assert.equal(label, 'session');
      return 'app-owned-token';
    },
  );
  assert.equal(result.kind, 'success');
  assert.equal(result.status, 202);
  const publicResult = await execute(
    operations.checkHealth.build(),
    async (_url, init) => {
      assert.equal(new Headers(init.headers).has('Authorization'), false);
      return new Response(null, { status: 204 });
    },
    async () => {
      throw new Error('Public requests must not resolve bearer credentials');
    },
  );
  assert.equal(publicResult.kind, 'success');
  assert.equal(publicResult.status, 204);
});

test('header values preserve Fetch wire bytes and allow internal tabs in requests and responses', () => {
  for (const value of ['plain', 'a\tb', 'caf\u00e9', '\u00ff']) {
    const request = operations.prepareWidget.build({
      ...options(),
      headers: { 'Idempotency-Key': value, 'X-Tab': 'a\tb' },
    });
    assert.equal(new Headers(request.headers).get('Idempotency-Key'), value);
    assert.equal(new Headers(request.headers).get('X-Tab'), 'a\tb');
    const result = request.parseResponse(
      observed(
        202,
        { state: 'pending', reference: 'ref' },
        { 'X-Request-ID': value, 'X-Tab': 'a\tb' },
      ),
    );
    assert.equal(result.kind, 'success');
    assert.equal(result.validatedHeaders['x-request-id'], value);
    assert.equal(result.validatedHeaders['x-tab'], 'a\tb');
  }
  for (const value of [
    'a😀b',
    'a\u0000b',
    'a\u0001b',
    'a\nb',
    'a\rb',
    'a\u007fb',
    ' value',
    'value ',
    '\tvalue',
    'value\t',
  ]) {
    assert.throws(
      () =>
        operations.prepareWidget.build({
          ...options(),
          headers: { 'Idempotency-Key': value },
        }),
      RequestValidationError,
    );
    const result = operations.prepareWidget.parseResponse(
      observed(
        202,
        { state: 'pending', reference: 'ref' },
        { 'X-Request-ID': value },
      ),
    );
    assert.equal(result.kind, 'protocol');
    assert.equal(result.headers['x-request-id'], value);
    assert.equal(Object.hasOwn(result.validatedHeaders, 'x-request-id'), false);
  }
  assert.throws(
    () =>
      operations.prepareWidget.build({
        ...options(),
        headers: { 'Idempotency-Key': 'valid', 'X-Padded': ' a ' },
      }),
    RequestValidationError,
  );
});

test('query strings reject malformed Unicode and round-trip valid astral names and values', () => {
  for (const value of ['\ud800', '\udfff', 'a\ud800b']) {
    assert.throws(
      () =>
        operations.getWidget.build({
          path: { widgetId: 'one' },
          query: { q: value },
        }),
      RequestValidationError,
    );
  }
  assert.throws(
    () =>
      operations.getWidget.build({
        path: { widgetId: 'one' },
        query: { brokenConst: '\ud800' },
      }),
    RequestValidationError,
  );
  const request = operations.getWidget.build({
    path: { widgetId: 'one' },
    query: { q: 'a😀b', '🔍': '🔎' },
  });
  const query = new URL(request.url, 'https://synthetic.invalid').searchParams;
  assert.equal(query.get('q'), 'a😀b');
  assert.equal(query.get('🔍'), '🔎');
});

test('builders validate before transport and do not retain mutable input objects', () => {
  const input = options();
  const request = operations.prepareWidget.build(input);
  input.body.label = 'Mutated';
  assert.equal(request.body.label, 'Example');
  assert.deepEqual(request.policy.auth, {
    label: 'session',
    transport: 'bearer',
  });
  assert.equal(request.bodyKind, 'json');
  assert.equal(request.headers['Idempotency-Key'], 'attempt');
  for (const input of [
    undefined,
    null,
    [],
    {},
    { ...options(), extra: true },
    { ...options(), body: { acknowledged: false, label: 'Example' } },
    { ...options(), body: { ...options().body, extra: true } },
    { ...options(), query: { undeclared: true } },
    { ...options(), headers: { 'Idempotency-Key': 'one\r\nInjected: two' } },
  ]) {
    assert.throws(
      () => operations.prepareWidget.build(input),
      RequestValidationError,
    );
  }
});

test('path/query serialization is deterministic, encoded, strict and safe against dot segments', () => {
  const request = operations.prepareWidget.build({
    ...options(),
    path: { widgetId: "a/b?!'" },
    query: { dryRun: false },
  });
  assert.equal(
    request.url,
    '/api/widgets/a%2Fb%3F%21%27/preparations?dryRun=false',
  );
  assert.equal(
    operations.prepareWidget.build({
      ...options(),
      query: { dryRun: undefined },
    }).url,
    '/api/widgets/widget/preparations',
  );
  for (const widgetId of ['', '.', '..', '\ud800'])
    assert.throws(
      () =>
        operations.prepareWidget.build({ ...options(), path: { widgetId } }),
      RequestValidationError,
    );
  for (const limit of [0, 11, 1.5, NaN, Infinity, '2'])
    assert.throws(
      () =>
        operations.getWidget.build({
          path: { widgetId: 'widget' },
          query: { limit },
        }),
      RequestValidationError,
    );
  assert.equal(
    operations.getWidget.build({
      path: { widgetId: '%2e%2e' },
      query: { limit: 2 },
    }).url,
    '/api/widgets/%252e%252e?limit=2',
  );
});

test('string constraints count Unicode characters and preserve boolean literals', () => {
  operations.prepareWidget.build({
    ...options(),
    body: { acknowledged: true, label: '😀'.repeat(40) },
  });
  assert.throws(
    () =>
      operations.prepareWidget.build({
        ...options(),
        body: { acknowledged: true, label: '😀'.repeat(41) },
      }),
    RequestValidationError,
  );
  assert.throws(
    () =>
      operations.prepareWidget.build({
        ...options(),
        body: { acknowledged: true, label: 'x', tags: ['a', 'b', 'c', 'd'] },
      }),
    RequestValidationError,
  );
});

test('validates each success and error against the exact declared status', () => {
  const request = operations.prepareWidget.build(options());
  const pending = request.parseResponse(
    observed(202, { state: 'pending', reference: 'ref-1', added: true }),
  );
  assert.equal(pending.kind, 'success');
  assert.equal(pending.status, 202);
  assert.deepEqual(pending.data, { state: 'pending', reference: 'ref-1' });
  const refusal = request.parseResponse(
    observed(200, { state: 'refused', reason: 'unavailable' }),
  );
  assert.equal(refusal.kind, 'success');
  assert.equal(refusal.data.reason, 'unavailable');
  const problem = request.parseResponse(
    observed(400, { code: 'invalid', detail: 'invalid input' }),
  );
  assert.equal(problem.kind, 'error');
  assert.equal(problem.data.detail, 'invalid input');
  const conflict = request.parseResponse(
    observed(
      409,
      { code: 'conflict', retryable: false },
      { 'Retry-After': '5' },
    ),
  );
  assert.equal(conflict.kind, 'error');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.validatedHeaders['retry-after'], '5');
  for (const [status, data] of [
    [200, { state: 'pending', reference: 'ref-1' }],
    [202, { state: 'refused', reason: 'unavailable' }],
    [400, { code: 'conflict', retryable: false }],
    [409, { code: 'invalid', detail: 'invalid' }],
  ]) {
    const result = request.parseResponse(observed(status, data));
    assert.equal(result.kind, 'protocol');
    assert.equal(result.status, status);
    assert.equal(Object.hasOwn(result, 'data'), false);
  }
});

test('response objects strip additive fields recursively', () => {
  const result = operations.getWidget.parseResponse(
    observed(200, {
      id: 'one',
      label: 'Example',
      added: true,
      details: { visible: true, extra: 'ignored' },
    }),
  );
  assert.equal(result.kind, 'success');
  assert.deepEqual(result.data, {
    id: 'one',
    label: 'Example',
    details: { visible: true },
  });
});

test('protocol failures retain observed status and independently validated headers without body data', () => {
  const request = operations.prepareWidget.build(options());
  const malformed = request.parseResponse({
    status: 409,
    headers: {
      'CONTENT-TYPE': 'application/json',
      'X-Request-ID': 'request-1',
      'Retry-After': '5',
    },
    body: '{',
  });
  assert.equal(malformed.kind, 'protocol');
  assert.equal(malformed.status, 409);
  assert.equal(malformed.headers['x-request-id'], 'request-1');
  assert.equal(malformed.validatedHeaders['x-request-id'], 'request-1');
  assert.equal(malformed.validatedHeaders['retry-after'], '5');
  assert.equal(Object.hasOwn(malformed, 'data'), false);
  const unauthorized = request.parseResponse({
    status: 401,
    headers: { 'X-Request-ID': 'auth-ref' },
    body: '<html>Unauthorized</html>',
  });
  assert.equal(unauthorized.kind, 'protocol');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers['x-request-id'], 'auth-ref');
  assert.deepEqual(Object.keys(unauthorized.validatedHeaders), []);
});

test('content type, required headers and missing body fields fail without synthesized values', () => {
  const request = operations.prepareWidget.build(options());
  const valid = observed(202, { state: 'pending', reference: 'ref-1' });
  for (const response of [
    {
      ...valid,
      headers: { 'Content-Type': 'text/plain', 'X-Request-ID': 'request-1' },
    },
    { ...valid, headers: { 'Content-Type': 'application/json' } },
    observed(202, { state: 'pending' }),
    {
      ...valid,
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': '\r\n' },
    },
  ]) {
    const result = request.parseResponse(response);
    assert.equal(result.kind, 'protocol');
    assert.equal(result.status, 202);
    assert.equal(Object.hasOwn(result, 'data'), false);
  }
});

test('HEAD/OPTIONS builders and bodyless 204 responses work without dummy JSON', () => {
  for (const operation of [operations.checkHealth, operations.widgetOptions]) {
    const request = operation.build();
    assert.equal(request.bodyKind, 'none');
    assert.equal(Object.hasOwn(request, 'body'), false);
    const result = request.parseResponse({
      status: 204,
      headers: {},
      body: '',
    });
    assert.equal(result.kind, 'success');
    assert.equal(result.data, undefined);
    assert.equal(
      request.parseResponse({ status: 204, headers: {}, body: 'null' }).kind,
      'protocol',
    );
    assert.throws(() => operation.build({ body: {} }), RequestValidationError);
  }
});

test('entirely inline contracts typecheck and validate bounded scalar enums, null and arrays', async () => {
  const directory = join(root, 'inline');
  await mkdir(join(directory, 'generated'), { recursive: true });
  const metadata = fixture();
  const inputSchema = {
    type: 'object',
    required: ['flag', 'mode', 'ratio', 'nothing', 'samples'],
    properties: {
      flag: { type: 'boolean', const: false },
      mode: { type: 'string', enum: ['small', 'large'], maxLength: 5 },
      ratio: { type: 'number', enum: [1.25, 2.5], minimum: 1, maximum: 3 },
      nothing: { type: 'null' },
      samples: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        items: { type: 'integer', minimum: 0, maximum: 5 },
      },
    },
  };
  const document = {
    openapi: '3.1.0',
    info: { title: 'Inline scalar example', version: '1' },
    'x-pom-policy': metadata['x-pom-policy'],
    paths: {
      '/values': {
        post: {
          operationId: 'acceptValues',
          'x-pom': metadata.paths['/api/health'].head['x-pom'],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: inputSchema } },
          },
          responses: {
            201: {
              description: 'Accepted',
              content: {
                'application/json': {
                  schema: { type: 'string', const: 'accepted' },
                },
              },
            },
            422: {
              description: 'Invalid field',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['field'],
                    properties: { field: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  for (const [name, source] of Object.entries(
    await compile(document, { clients: ['consumer'] }),
  ))
    await writeFile(join(directory, 'generated', name), source);
  const config = JSON.parse(
    await readFile(join(repo, 'examples/json/tsconfig.json'), 'utf8'),
  );
  config.compilerOptions.outDir = 'built';
  await writeFile(join(directory, 'tsconfig.json'), JSON.stringify(config));
  await writeFile(
    join(directory, 'probe.ts'),
    `
    import {operations} from './generated/client.consumer.js';
    import type {PreparedRequest} from './generated/client.consumer.js';
    const request = operations.acceptValues.build({body:{flag:false,mode:'small',ratio:1.25,nothing:null,samples:[0]}});
    const mode:'small'|'large'=request.body.mode;
    const ratio:1.25|2.5=request.body.ratio;
    const empty:null=request.body.nothing;
    void [mode,ratio,empty];
    const general:PreparedRequest=request;
    const result=general.parseResponse({status:201,headers:{},body:''});
    if(result.kind==='success') void result.data;
  `,
  );
  await exec(process.execPath, [
    join(repo, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(directory, 'tsconfig.json'),
  ]);
  const { operations: inline } = await import(
    pathToFileURL(join(directory, 'built/generated/client.consumer.js')).href
  );
  const body = {
    flag: false,
    mode: 'small',
    ratio: 1.25,
    nothing: null,
    samples: [0, 5],
  };
  inline.acceptValues.build({ body });
  for (const invalid of [
    { ...body, flag: true },
    { ...body, mode: 'other' },
    { ...body, ratio: 2 },
    { ...body, nothing: '' },
    { ...body, samples: [] },
    { ...body, samples: [0, 1, 2] },
    { ...body, samples: [-1] },
    { ...body, samples: [1.5] },
  ]) {
    assert.throws(() => inline.acceptValues.build({ body: invalid }));
  }
  const accepted = inline.acceptValues.parseResponse({
    status: 201,
    headers: { 'Content-Type': 'application/json' },
    body: '"accepted"',
  });
  assert.equal(accepted.kind, 'success');
  assert.equal(accepted.data, 'accepted');
  const invalidField = inline.acceptValues.parseResponse({
    status: 422,
    headers: { 'Content-Type': 'application/json' },
    body: '{"field":"mode"}',
  });
  assert.equal(invalidField.kind, 'error');
  assert.deepEqual(invalidField.data, { field: 'mode' });
});
