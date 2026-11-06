import assert from 'node:assert/strict';
import test from 'node:test';
import { defineOperation, stringValue } from '../src/runtime.ts';
import type { ObservedResponse } from '../src/runtime.ts';
import { defineCall } from '../src/call-runtime.ts';
import { executionConfig } from '../src/execution-runtime.ts';
import type {
  CancellationMapper,
  ClientConfig,
} from '../src/execution-runtime.ts';
import { queryConfig } from '../src/query-runtime.ts';
import { runtimeInput } from './assertions.ts';

const response: ObservedResponse = {
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '"declared"',
};
const execute = async () => response;
const operation = defineOperation({
  operationId: 'structural',
  method: 'GET',
  path: '/structural',
  bodyKind: 'none',
  security: { transport: 'none' },
  policy: {},
  parameters: [],
  headers: {},
  options: () => undefined,
  responses: {
    200: {
      bodyKind: 'content',
      headers: {},
      content: {
        'application/json': { bodyKind: 'json', schema: stringValue },
      },
    },
  },
});

function polluted<T>(values: Record<string, unknown>, check: () => T): T {
  const before = Object.keys(values).map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(Object.prototype, name)] as const,
  );
  try {
    for (const [name, value] of Object.entries(values))
      Object.defineProperty(Object.prototype, name, {
        value,
        configurable: true,
        writable: true,
      });
    return check();
  } finally {
    for (const [name, descriptor] of before)
      if (descriptor) Object.defineProperty(Object.prototype, name, descriptor);
      else Reflect.deleteProperty(Object.prototype, name);
  }
}

void test('public execution and query configuration retain class executors', () => {
  class Adapter {
    namespace = 'class-adapter';
    execute(this: void) {
      return execute();
    }
  }
  for (const normalize of [executionConfig, queryConfig]) {
    const adapter = new Adapter();
    const normalized = normalize(adapter);
    assert.equal(normalized.namespace, adapter.namespace);
    assert.equal(normalized.execute, adapter.execute);
    for (const name of ['namespace', 'execute', 'mapCancellation'])
      assert.ok(Object.hasOwn(normalized, name));
    assert.equal(normalized.mapCancellation, undefined);
  }
});

void test('configuration captures structural getters once and retains the captured values', async () => {
  const captured = new Error('captured cancellation');
  const replacement = new Error('replacement cancellation');
  for (const normalize of [executionConfig, queryConfig]) {
    const reads = { namespace: 0, execute: 0, mapCancellation: 0 };
    const first: CancellationMapper = () => ({ error: captured });
    const later: CancellationMapper = () => ({ error: replacement });
    const current = { namespace: 'captured', execute, mapCancellation: first };
    const prototype = {
      get namespace() {
        reads.namespace++;
        return current.namespace;
      },
      get execute() {
        reads.execute++;
        return current.execute;
      },
      get mapCancellation() {
        reads.mapCancellation++;
        return current.mapCancellation;
      },
    };
    const supplied = Object.create(prototype) as ClientConfig;
    Object.defineProperty(supplied, 'unrelated', {
      enumerable: true,
      get() {
        assert.fail('unrelated configuration getter must not be read');
      },
    });
    const normalized = polluted(
      {
        namespace: 'global',
        execute: () => {
          assert.fail('global executor');
        },
        mapCancellation: later,
      },
      () => normalize(supplied),
    );
    assert.deepEqual(reads, { namespace: 1, execute: 1, mapCancellation: 1 });
    current.namespace = 'changed';
    current.execute = async () => {
      throw new Error('changed executor');
    };
    current.mapCancellation = later;
    assert.equal(normalized.namespace, 'captured');
    assert.equal(normalized.execute, execute);
    assert.equal(normalized.mapCancellation, first);
    const call = defineCall({
      ...normalized,
      execute,
      operation,
      client: 'consumer',
      operationId: 'structural',
    });
    assert.equal((await call.call({ context: {} })).data, 'declared');
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await assert.rejects(
      call.call({ context: {}, signal: controller.signal }),
      (error) => error === captured,
    );
    assert.deepEqual(reads, { namespace: 1, execute: 1, mapCancellation: 1 });
  }
});

void test('configuration rejects global required defaults and preserves own undefined settings', () => {
  polluted(
    {
      namespace: 'global',
      execute,
      mapCancellation: () => {
        assert.fail('global mapper');
      },
    },
    () => {
      for (const normalize of [executionConfig, queryConfig]) {
        assert.throws(
          () => runtimeInput(normalize, { execute }),
          /namespace must be a nonempty string/,
        );
        assert.throws(
          () => runtimeInput(normalize, { namespace: 'own' }),
          /executor must be a function/,
        );
        for (const supplied of [
          { namespace: 'own', execute },
          { namespace: 'own', execute, mapCancellation: undefined },
        ]) {
          const normalized = normalize(supplied);
          assert.ok(Object.hasOwn(normalized, 'mapCancellation'));
          assert.equal(normalized.mapCancellation, undefined);
        }
      }
    },
  );
});

void test('response evidence retains structural class getters and reads each field once', () => {
  const reads = { status: 0, body: 0, headers: 0 };
  class Evidence {
    get status() {
      reads.status++;
      return response.status;
    }
    get body() {
      reads.body++;
      return response.body;
    }
    get headers() {
      reads.headers++;
      return response.headers;
    }
  }
  const result = polluted({ status: 500, body: '"global"', headers: {} }, () =>
    operation.parseResponse(new Evidence()),
  );
  assert.equal(result.kind, 'success');
  if (result.kind !== 'success') assert.fail('declared response must succeed');
  assert.equal(result.data, 'declared');
  assert.deepEqual(reads, { status: 1, body: 1, headers: 1 });
  const inherited = Object.create(response) as ObservedResponse;
  assert.equal(operation.parseResponse(inherited).kind, 'success');
});

void test('Object.prototype cannot supply missing or explicitly undefined response evidence', () => {
  for (const [name, message] of [
    ['status', /response status must be a number/],
    ['body', /response body must be raw text/],
    ['headers', /response headers must be a plain record/],
  ] as const) {
    const missing = { ...response };
    Reflect.deleteProperty(missing, name);
    const absent = { ...response, [name]: undefined };
    polluted({ [name]: response[name] }, () => {
      for (const input of [missing, absent])
        assert.throws(
          () => runtimeInput(operation.parseResponse, input),
          message,
          name,
        );
      assert.equal(operation.parseResponse(response).kind, 'success');
    });
  }
});

void test('signal polyfills ignore global cancellation reasons and retain structural reasons', async () => {
  const call = defineCall({
    ...executionConfig({ namespace: 'polyfill', execute }),
    operation,
    client: 'consumer',
    operationId: 'structural',
  });
  const base = {
    aborted: true,
    addEventListener() {},
    removeEventListener() {},
  };
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'reason');
  Object.defineProperty(Object.prototype, 'reason', {
    value: 'global cancellation',
    configurable: true,
    writable: true,
  });
  try {
    for (const signal of [base, { ...base, reason: undefined }])
      await assert.rejects(
        runtimeInput(call.call, { context: {}, signal }),
        (error) => error instanceof Error && error.name === 'AbortError',
      );
    for (const reason of [
      null,
      false,
      0,
      '',
      new Error('declared cancellation'),
    ]) {
      let reads = 0;
      class Signal {
        aborted = true;
        addEventListener() {}
        removeEventListener() {}
        get reason() {
          reads++;
          return reason;
        }
      }
      await assert.rejects(
        runtimeInput(call.call, { context: {}, signal: new Signal() }),
        (error) => error === reason,
      );
      assert.equal(reads, 1);
    }
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'reason', previous);
    else Reflect.deleteProperty(Object.prototype, 'reason');
  }
});
