import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import {
  defineOperation,
  nativeFile,
  RequestValidationError,
} from '../src/runtime.ts';
import {
  executionConfig,
  ResponseError,
  QueryResponseError,
} from '../src/execution-runtime.ts';
import type { Executor } from '../src/execution-runtime.ts';
import { defineCall } from '../src/call-runtime.ts';
import type { ExecutionClient } from '../src/call-runtime.ts';

const policy = {
  auth: { label: 'public', transport: 'none' },
  retry: 'never',
  timeout: 'interactive',
} as const;
const problem = {
  bodyKind: 'json',
  headers: {},
  schema: z.object({ detail: z.string() }),
} as const;
const read = defineOperation({
  operationId: 'read',
  method: 'GET',
  path: '/items/{id}',
  policy,
  bodyKind: 'none',
  parameters: [{ name: 'id', in: 'path', required: true }],
  options: z.object({ path: z.object({ id: z.string().min(1) }) }).strict(),
  headers: {},
  responses: {
    200: {
      bodyKind: 'json',
      headers: {},
      schema: z.object({ label: z.string() }),
    },
    404: problem,
  },
});
const write = defineOperation({
  operationId: 'write',
  method: 'POST',
  path: '/items',
  policy,
  bodyKind: 'json',
  parameters: [],
  options: z
    .object({ body: z.object({ labels: z.array(z.string()) }).strict() })
    .strict(),
  headers: {},
  responses: { 204: { bodyKind: 'none', headers: {} }, 409: problem },
});
const upload = defineOperation({
  operationId: 'upload',
  method: 'PUT',
  path: '/upload',
  policy,
  bodyKind: 'multipart',
  parameters: [],
  multipart: [{ name: 'file', kind: 'file', multiple: false, required: true }],
  options: z.object({ body: z.object({ file: nativeFile }) }).strict(),
  headers: {},
  responses: { 204: { bodyKind: 'none', headers: {} } },
});
const health = defineOperation({
  operationId: 'health',
  method: 'HEAD',
  path: '/health',
  policy,
  bodyKind: 'none',
  parameters: [],
  options: z.object({}).strict().optional(),
  headers: {},
  responses: { 204: { bodyKind: 'none', headers: {} } },
});

function createPrototype(execute: Executor, namespace = 'prototype') {
  const config = executionConfig({ namespace, execute });
  const client: ExecutionClient<{
    read: typeof read;
    write: typeof write;
    upload: typeof upload;
    health: typeof health;
  }> = {
    read: defineCall({
      ...config,
      operation: read,
      client: 'sample',
      operationId: 'read',
    }),
    write: defineCall({
      ...config,
      operation: write,
      client: 'sample',
      operationId: 'write',
    }),
    upload: defineCall({
      ...config,
      operation: upload,
      client: 'sample',
      operationId: 'upload',
    }),
    health: defineCall({
      ...config,
      operation: health,
      client: 'sample',
      operationId: 'health',
    }),
  };
  return client;
}

// Check the shared runtime's generic contracts independently of the emitter.
// This function is compiled but never called; expected errors must stay errors.
export async function prototypeTypes(execute: Executor, error: unknown) {
  const client = createPrototype(execute);
  const result = await client.read.call({
    context: {},
    input: { path: { id: 'item' } },
  });
  const status: 200 = result.status;
  const label: string = result.data.label;
  const empty = await client.write.call({
    context: {},
    input: { body: { labels: ['one'] } },
  });
  const noData: undefined = empty.data;
  await client.health.call({ context: {} });
  await client.upload.call({
    context: {},
    input: { body: { file: { uri: 'native://file', name: 'item' } } },
  });
  void [status, label, noData];
  // @ts-expect-error Required paths remain required.
  await client.read.call({ context: {} });
  // @ts-expect-error Context is required even for a bodyless call.
  await client.health.call({});
  // @ts-expect-error A JSON body retains its schema.
  await client.write.call({ context: {}, input: { body: { labels: [1] } } });
  await client.upload.call({
    context: {},
    // @ts-expect-error Native files require a URI.
    input: { body: { file: { name: 'item' } } },
  });
  // @ts-expect-error HTTP failures cannot be returned as successful commands.
  const failureStatus: 409 = empty.status;
  void failureStatus;
  if (client.write.isError(error) && error.result.kind === 'error') {
    const conflict: 409 = error.result.status;
    const detail: string = error.result.data.detail;
    void [conflict, detail];
    // @ts-expect-error The failure body has no success fields.
    void error.result.data.label;
  }
}

void test('execution prototype validates before transport and snapshots JSON, native files and scalar context', async () => {
  const labels = ['original'];
  const context = { revision: 'first', count: -0 };
  const file = { uri: 'native://original' };
  const requests: Parameters<Executor>[0][] = [];
  const contexts: Parameters<Executor>[1][] = [];
  const client = createPrototype(async (request, execution) => {
    requests.push(request);
    contexts.push(execution);
    await Promise.resolve();
    return { status: 204, headers: {}, body: '' };
  });
  const writing = client.write.call({ context, input: { body: { labels } } });
  const uploading = client.upload.call({ context, input: { body: { file } } });
  labels.push('changed');
  context.revision = 'changed';
  file.uri = 'native://changed';
  assert.equal((await writing).data, undefined);
  await uploading;
  assert.deepEqual(requests[0]?.bodyKind === 'json' && requests[0].body, {
    labels: ['original'],
  });
  assert.deepEqual(requests[1]?.bodyKind === 'multipart' && requests[1].body, {
    file: { uri: 'native://original' },
  });
  for (const execution of contexts) {
    assert.deepEqual(execution.context, { count: 0, revision: 'first' });
    assert.equal(Object.is(execution.context['count'], -0), false);
    assert.ok(Object.isFrozen(execution.context));
    assert.ok(Object.isFrozen(execution));
    assert.equal(execution.signal.aborted, false);
  }
  await assert.rejects(
    client.read.call({ context: {}, input: { path: { id: '' } } }),
    RequestValidationError,
  );
  assert.equal(requests.length, 2);
});

void test('execution prototype keeps exact failure provenance and application errors', async () => {
  const execute: Executor = async () => ({
    status: 409,
    headers: { 'Content-Type': 'application/json' },
    body: '{"detail":"conflict"}',
  });
  const client = createPrototype(execute);
  assert.equal(ResponseError, QueryResponseError);
  let failure: unknown;
  try {
    await client.write.call({ context: {}, input: { body: { labels: [] } } });
  } catch (error) {
    failure = error;
  }
  assert.ok(client.write.isError(failure));
  assert.ok(failure instanceof ResponseError);
  assert.ok(createPrototype(execute).write.isError(failure));
  assert.equal(client.read.isError(failure), false);
  assert.equal(
    createPrototype(execute, 'different').write.isError(failure),
    false,
  );
  assert.equal(client.write.isError(new ResponseError(failure.result)), false);
  const applicationError = new Error('synthetic session recovery exhausted');
  await assert.rejects(
    createPrototype(async () => {
      throw applicationError;
    }).health.call({ context: {} }),
    (error) => error === applicationError,
  );
});

void test('execution prototype reads final evidence and validates its schema once', async () => {
  let reads = 0;
  let validations = 0;
  const operation = defineOperation({
    operationId: 'counted',
    method: 'GET',
    path: '/counted',
    policy,
    bodyKind: 'none',
    parameters: [],
    options: z.object({}).optional(),
    headers: {},
    responses: {
      200: {
        bodyKind: 'json',
        headers: {},
        schema: z.object({ value: z.string() }).superRefine(() => {
          validations++;
        }),
      },
    },
  });
  const client = defineCall({
    operation,
    operationId: 'counted',
    client: 'sample',
    namespace: 'prototype',
    execute: async () => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      get body() {
        reads++;
        return '{"value":"once"}';
      },
    }),
  });
  assert.equal((await client.call({ context: {} })).data.value, 'once');
  assert.equal(reads, 1);
  assert.equal(validations, 1);
});

void test('execution prototype preserves abort reasons before transport, after late completion and during evidence reads', async () => {
  let calls = 0;
  const reason = { cancelled: true };
  const controller = new AbortController();
  controller.abort(reason);
  const client = createPrototype(async () => {
    calls++;
    return { status: 204, headers: {}, body: '' };
  });
  await assert.rejects(
    client.health.call({ context: {}, signal: controller.signal }),
    (error) => error === reason,
  );
  assert.equal(calls, 0);
  const late = new AbortController();
  const pending = createPrototype(async () => {
    late.abort(reason);
    return { status: 204, headers: {}, body: '' };
  }).health.call({ context: {}, signal: late.signal });
  await assert.rejects(pending, (error) => error === reason);
  const reading = new AbortController();
  await assert.rejects(
    createPrototype(async () => ({
      status: 204,
      headers: {},
      get body() {
        reading.abort(reason);
        return '';
      },
    })).health.call({ context: {}, signal: reading.signal }),
    (error) => error === reason,
  );
});
