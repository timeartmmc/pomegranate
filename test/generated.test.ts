import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { compile } from '../dist/index.js';
import {
  entry,
  invalidOptions,
  json,
  record,
  runtimeInput,
} from './assertions.ts';
import { fixture, generatedFixture } from './helpers.ts';
import type { RuntimeClient } from './runtime-types.ts';

type Consumer = typeof import('./.generated/runtime/client.consumer.ts');
type ConsumerSchemas =
  typeof import('./.generated/runtime/client.consumer.schemas.ts');
type Staff = typeof import('./.generated/runtime/client.staff.ts');
type StaffSchemas =
  typeof import('./.generated/runtime/client.staff.schemas.ts');
type Transport = typeof import('../examples/json/transport.ts');

const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
let root: string;
let operations: Consumer['operations'];
let RequestValidationError: Consumer['RequestValidationError'];
let staffOperations: Staff['operations'];
let consumerSchemas: ConsumerSchemas;
let staffSchemas: StaffSchemas;
let execute: Transport['execute'];

void test('JSON example refuses unsupported bodies before token resolution or sending', async () => {
  const request = {
    ...operations.checkHealth.build(),
    bodyKind: 'multipart',
    body: { file: { uri: 'file:///local' } },
    multipart: [],
  };
  const unexpected = async () => {
    throw new Error('Transport must not be called');
  };
  await assert.rejects(
    execute(
      // @ts-expect-error Exercise the runtime guard for a non-JSON body.
      request,
      unexpected,
      unexpected,
      'https://example.invalid',
    ),
    /does not support multipart/,
  );
});

before(async () => {
  const cache = join(repo, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  root = await mkdtemp(join(cache, 'pom-generated-'));
  await mkdir(join(root, 'generated'));
  const document = generatedFixture();
  for (const [name, source] of Object.entries(
    await compile(document, { clients: ['consumer', 'staff'] }),
  ))
    await writeFile(join(root, 'generated', name), source);
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  const config = record(
    json(await readFile(join(repo, 'examples/json/tsconfig.json'), 'utf8')),
  );
  record(config.compilerOptions).outDir = 'built';
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
  ({ operations, RequestValidationError } = (await import(
    pathToFileURL(join(root, 'built/generated/client.consumer.js')).href
  )) as Consumer);
  ({ operations: staffOperations } = (await import(
    pathToFileURL(join(root, 'built/generated/client.staff.js')).href
  )) as Staff);
  consumerSchemas = (await import(
    pathToFileURL(join(root, 'built/generated/client.consumer.schemas.js')).href
  )) as ConsumerSchemas;
  staffSchemas = (await import(
    pathToFileURL(join(root, 'built/generated/client.staff.schemas.js')).href
  )) as StaffSchemas;
  ({ execute } = (await import(
    pathToFileURL(join(root, 'built/transport.js')).href
  )) as Transport);
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

void test('empty request options reject every undeclared own key', () => {
  assert.throws(
    () => runtimeInput(operations.checkHealth.build, json('{"__proto__":1}')),
    RequestValidationError,
  );
});

function options() {
  return {
    path: { widgetId: 'widget' },
    headers: { 'Idempotency-Key': 'attempt' },
    body: { acknowledged: true as const, label: 'Example' },
  };
}
function observed(
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
) {
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

void test('clients account for exactly their selected operations and directional schema closures', () => {
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

void test('application transport resolves bearer labels and sends public overrides without credentials', async () => {
  const request = operations.prepareWidget.build(options());
  const result = await execute(
    request,
    async (_url, init) => {
      assert.equal(
        new Headers(init?.headers).get('Authorization'),
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
    'https://example.invalid',
  );
  assert.equal(result.kind, 'success');
  assert.equal(result.status, 202);
  const publicResult = await execute(
    operations.checkHealth.build(),
    async (_url, init) => {
      assert.equal(new Headers(init?.headers).has('Authorization'), false);
      return new Response(null, { status: 204 });
    },
    async () => {
      throw new Error('Public requests must not resolve bearer credentials');
    },
    'https://example.invalid',
  );
  assert.equal(publicResult.kind, 'success');
  assert.equal(publicResult.status, 204);
});

void test('the example transport resolves relative requests for real Node fetch', async (t) => {
  const server = createServer((incoming, outgoing) => {
    assert.equal(incoming.url, '/api/health');
    assert.equal(incoming.method, 'HEAD');
    outgoing.writeHead(204);
    outgoing.end();
  });
  server.listen(0, '127.0.0.1');
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  const result = await execute(
    operations.checkHealth.build(),
    fetch,
    async () => {
      throw new Error('public request must not resolve credentials');
    },
    origin,
  );
  assert.equal(result.kind, 'success');
  assert.equal(result.status, 204);
});

void test('header values preserve Fetch wire bytes and allow internal tabs in requests and responses', () => {
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
    'a\u0100b',
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
    const request = operations.prepareWidget.build(options());
    assert.throws(
      () =>
        request.validateHeaders({
          ...request.headers,
          'Idempotency-Key': value,
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

void test('query strings reject malformed Unicode and round-trip valid astral names and values', () => {
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

void test('builders validate before transport and do not retain mutable input objects', () => {
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
      () => runtimeInput(operations.prepareWidget.build, input),
      RequestValidationError,
    );
  }
});

void test('path/query serialization is deterministic, encoded, strict and safe against dot segments', () => {
  const request = operations.prepareWidget.build({
    ...options(),
    path: { widgetId: "a/b?!'()*" },
    query: { dryRun: false },
  });
  assert.equal(
    request.url,
    '/api/widgets/a%2Fb%3F%21%27%28%29%2A/preparations?dryRun=false',
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
        runtimeInput(operations.getWidget.build, {
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

void test('string constraints count Unicode characters and preserve boolean literals', () => {
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

void test('validates each success and error against the exact declared status', () => {
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
  assert.equal(refusal.status, 200);
  assert.equal(refusal.data.reason, 'unavailable');
  const problem = request.parseResponse(
    observed(400, { code: 'invalid', detail: 'invalid input' }),
  );
  assert.equal(problem.kind, 'error');
  assert.equal(problem.status, 400);
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
  ] satisfies [number, unknown][]) {
    const result = request.parseResponse(observed(status, data));
    assert.equal(result.kind, 'protocol');
    assert.equal(result.status, status);
    assert.equal(Object.hasOwn(result, 'data'), false);
  }
});

void test('declared redirects retain error status, payload and validated headers', () => {
  const result = operations.prepareWidget.parseResponse(
    observed(
      303,
      { code: 'redirect', detail: 'see-other' },
      { Location: '/next' },
    ),
  );
  assert.equal(result.kind, 'error');
  assert.equal(result.status, 303);
  assert.deepEqual(result.data, { code: 'redirect', detail: 'see-other' });
  assert.equal(result.validatedHeaders['location'], '/next');
  const wrongBody = operations.prepareWidget.parseResponse(
    observed(
      303,
      { state: 'pending', reference: 'ref' },
      { Location: '/next' },
    ),
  );
  assert.equal(wrongBody.kind, 'protocol');
  assert.equal(wrongBody.status, 303);
  assert.equal(Object.hasOwn(wrongBody, 'data'), false);
});

void test('builders reject extra arguments even when the first argument is valid', () => {
  assert.throws(
    () => invalidOptions(operations.prepareWidget.build, options(), {}),
    (error) => {
      assert.ok(error instanceof RequestValidationError);
      assert.equal(error.operationId, 'prepareWidget');
      assert.deepEqual(error.issues, [
        { path: [], message: 'expected at most one options argument' },
      ]);
      return true;
    },
  );
});

void test('response objects strip additive fields recursively', () => {
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

void test('protocol failures retain observed status and independently validated headers without body data', () => {
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

void test('protocol schema failures retain body paths and declared header names', () => {
  const missing = operations.prepareWidget.parseResponse({
    status: 202,
    headers: { 'Content-Type': 'application/json' },
    body: '{"state":"pending"}',
  });
  assert.equal(missing.kind, 'protocol');
  assert.ok(
    missing.issues.some(
      (issue) => issue.part === 'headers' && issue.path?.[0] === 'x-request-id',
    ),
  );
  assert.ok(
    missing.issues.some(
      (issue) => issue.part === 'body' && issue.path?.[0] === 'reference',
    ),
  );
  const nested = operations.getWidget.parseResponse(
    observed(200, {
      id: 'one',
      label: 'Example',
      details: { visible: 'true' },
    }),
  );
  assert.equal(nested.kind, 'protocol');
  const issue = nested.issues.find((issue) => issue.part === 'body');
  assert.ok(issue);
  assert.deepEqual(issue.path, ['details', 'visible']);
  assert.match(issue.message, /boolean/);
  assert.equal(Object.hasOwn(nested, 'data'), false);
});

void test('content type, required headers and missing body fields fail without synthesized values', () => {
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

void test('JSON response media types preserve valid token and quoted parameters', () => {
  for (const mediaType of [
    'application/json',
    'APPLICATION/JSON; Charset="utf-8"',
    'application/json\t;\tcharset=utf-8',
    'application/json; note="comma, semi; quote\\\" slash\\\\ end"',
    'application/json; empty=""',
    'application/json; note="caf\u00e9\t"; charset=utf-8',
    'application/json;;charset=utf-8;',
  ]) {
    const result = operations.prepareWidget.parseResponse(
      observed(
        202,
        { state: 'pending', reference: 'ref' },
        {
          'Content-Type': mediaType,
        },
      ),
    );
    assert.equal(result.kind, 'success', mediaType);
    assert.equal(result.status, 202);
    assert.equal(result.data.reference, 'ref');
  }
});

void test('malformed or combined response media types fail with observed evidence intact', () => {
  for (const mediaType of [
    'application/json; charset=utf-8, text/plain',
    'application/json, application/json',
    'application/json; charset=utf-8, application/json',
    'application/json; invalid',
    'application/json; charset=',
    'application/json; =utf-8',
    'application/json; charset =utf-8',
    'application/json; charset= utf-8',
    'application/json; charset="unterminated',
    'application/json; note="unterminated\\',
    'application/json; note="closed"extra',
    'application/json; note="closed", text/plain',
    'application/json; note=caf\u00e9',
    'application/json; charset=utf-8 trailing',
    'application/jsonp',
  ]) {
    const result = operations.prepareWidget.parseResponse(
      observed(
        202,
        { state: 'pending', reference: 'ref' },
        {
          'Content-Type': mediaType,
        },
      ),
    );
    assert.equal(result.kind, 'protocol', mediaType);
    assert.equal(result.status, 202);
    assert.equal(result.headers['content-type'], mediaType);
    assert.equal(result.validatedHeaders['x-request-id'], 'request-1');
    assert.ok(result.issues.some((issue) => issue.part === 'content-type'));
    assert.equal(Object.hasOwn(result, 'data'), false);
  }
});

void test('joining response fields cannot promote invalid raw values into validated headers', () => {
  const result = operations.prepareWidget.parseResponse(
    observed(
      202,
      { state: 'pending', reference: 'ref' },
      {
        'X-Request-ID': 'request-1 ',
        'x-request-id': 'request-2',
        'X-Key': 'independent',
      },
    ),
  );
  assert.equal(result.kind, 'protocol');
  assert.equal(result.headers['x-request-id'], 'request-1 , request-2');
  assert.equal(Object.hasOwn(result.validatedHeaders, 'x-request-id'), false);
  assert.equal(result.validatedHeaders['x-key'], 'independent');
  assert.equal(Object.hasOwn(result, 'data'), false);
});

void test('response Content-Type is a singleton even when joining fields repairs a quoted parameter', () => {
  for (const headers of [
    { 'content-type': 'text/plain' },
    { 'content-type': 'application/json; charset=utf-8' },
    {
      'Content-Type': 'application/json; note="first',
      'content-type': 'last"',
    },
  ]) {
    const input = observed(
      202,
      { state: 'pending', reference: 'ref' },
      headers,
    );
    const result = operations.prepareWidget.parseResponse(input);
    assert.equal(result.kind, 'protocol');
    assert.equal(
      result.headers['content-type'],
      `${input.headers['Content-Type']}, ${entry(input.headers, 'content-type')}`,
    );
    assert.equal(result.validatedHeaders['x-request-id'], 'request-1');
    assert.ok(result.issues.some((issue) => issue.part === 'content-type'));
    assert.equal(Object.hasOwn(result, 'data'), false);
  }
});

void test('response header names must be HTTP tokens before Unicode case folding', () => {
  const data = { state: 'pending', reference: 'ref' };
  const token = "X-!#$%&'*+-.^_`|~09AZaz";
  const valid = operations.prepareWidget.parseResponse(
    observed(202, data, { [token]: 'allowed', 'X-Key': 'ascii' }),
  );
  assert.equal(valid.kind, 'success');
  assert.equal(valid.headers[token.toLowerCase()], 'allowed');
  assert.equal(valid.validatedHeaders['x-key'], 'ascii');
  for (const name of [
    '',
    'Bad Header',
    'Bad:Header',
    'Bad\tHeader',
    'Bad\r\nHeader',
    'Bad\r',
    'Bad\n',
    'Bad\u2028',
    'Bad\u0000Header',
    'X-Caf\u00e9',
    'X-\u212Aey',
    'X-\ud83d\ude00',
  ]) {
    const result = operations.prepareWidget.parseResponse(
      observed(202, data, { [name]: 'observed' }),
    );
    assert.equal(result.kind, 'protocol', JSON.stringify(name));
    assert.equal(result.status, 202);
    assert.equal(result.headers[name.toLowerCase()], 'observed');
    assert.equal(result.validatedHeaders['x-request-id'], 'request-1');
    assert.equal(Object.hasOwn(result.validatedHeaders, 'x-key'), false);
    assert.ok(result.issues.some((issue) => issue.part === 'headers'));
    assert.equal(Object.hasOwn(result, 'data'), false);
  }
  const bodyless = operations.checkHealth.parseResponse({
    status: 204,
    headers: { 'Bad Header': 'observed' },
    body: '',
  });
  assert.equal(bodyless.kind, 'protocol');
  assert.equal(bodyless.status, 204);
  assert.equal(bodyless.headers['bad header'], 'observed');
});

void test('HEAD/OPTIONS builders and bodyless 204 responses work without dummy JSON', () => {
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
    assert.throws(
      () => runtimeInput(operation.build, { body: {} }),
      RequestValidationError,
    );
  }
});

void test('entirely inline contracts typecheck and validate bounded scalar enums, null and arrays', async () => {
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
  const config = record(
    json(await readFile(join(repo, 'examples/json/tsconfig.json'), 'utf8')),
  );
  record(config.compilerOptions).outDir = 'built';
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
  const { operations: inline } = (await import(
    pathToFileURL(join(directory, 'built/generated/client.consumer.js')).href
  )) as RuntimeClient;
  const acceptValues = entry(inline, 'acceptValues');
  const body = {
    flag: false,
    mode: 'small',
    ratio: 1.25,
    nothing: null,
    samples: [0, 5],
  };
  acceptValues.build({ body });
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
    assert.throws(() => acceptValues.build({ body: invalid }));
  }
  const accepted = acceptValues.parseResponse({
    status: 201,
    headers: { 'Content-Type': 'application/json' },
    body: '"accepted"',
  });
  assert.equal(accepted.kind, 'success');
  assert.equal(accepted.data, 'accepted');
  const invalidField = acceptValues.parseResponse({
    status: 422,
    headers: { 'Content-Type': 'application/json' },
    body: '{"field":"mode"}',
  });
  assert.equal(invalidField.kind, 'error');
  assert.deepEqual(invalidField.data, { field: 'mode' });
});
