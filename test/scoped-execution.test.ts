import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineOperation, jsonValue } from '../src/runtime.ts';
import { defineCall } from '../src/call-runtime.ts';
import { defineQuery } from '../src/query-runtime.ts';
import { executeRequest, executionConfig } from '../src/execution-runtime.ts';
import type {
  CancellationEvent,
  CancellationMapper,
  Execution,
  Executor,
} from '../src/execution-runtime.ts';
import { invalidOptions, record, runtimeInput } from './assertions.ts';
import { detail, labelled, noOptions } from './native-schemas.ts';

const policy = {
  auth: 'public',
  retry: 'never',
  timeout: 'interactive',
} as const;
function operation(onValidate: () => void = () => {}) {
  return defineOperation({
    operationId: 'read',
    method: 'GET',
    path: '/items',
    bodyKind: 'none',
    security: { transport: 'none' },
    policy,
    parameters: [],
    options: noOptions,
    headers: {},
    responses: {
      200: {
        bodyKind: 'json',
        headers: {},
        schema: labelled(onValidate),
      },
      401: {
        bodyKind: 'json',
        headers: {},
        schema: detail,
      },
    },
  });
}
const response = () => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: '{"label":"first"}',
});
function call(execute: Executor, mapCancellation?: CancellationMapper) {
  return defineCall({
    operation: operation(),
    ...executionConfig({
      namespace: 'scoped',
      execute,
      ...(mapCancellation ? { mapCancellation } : {}),
    }),
    client: 'consumer',
    operationId: 'read',
  });
}
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected rejection');
}

void test('scoped execution captures parser and context before transport yields', async () => {
  let parses = 0;
  const original = operation(() => {
    parses++;
  });
  const mutable = { ...original };
  const context = { revision: 'first' };
  const bound = defineCall({
    operation: mutable,
    namespace: 'scoped',
    client: 'consumer',
    operationId: 'read',
    execute: async (_request, execution) => {
      await Promise.resolve();
      mutable.parseResponse = () => {
        throw new Error('replaced parser');
      };
      assert.equal(execution.context['revision'], 'first');
      assert.equal(Object.isFrozen(execution.context), true);
      return execution.validateResponse(response());
    },
  });
  const pending = bound.call({ context });
  context.revision = 'later';
  const result = await pending;
  assert.equal(result.data.label, 'first');
  assert.equal(parses, 1);
  result.data.label = 'owned edit';
  assert.equal(result.data.label, 'owned edit');
});

void test('evidence is single-use within an invocation and fresh across calls', async () => {
  const observed = response();
  const bound = call(async (_request, execution) => {
    const validated = execution.validateResponse(observed);
    assert.throws(
      () => execution.validateResponse(observed),
      /already validated.*fresh evidence/,
    );
    return validated;
  });
  assert.equal((await bound.call({ context: {} })).data.label, 'first');
  observed.body = '{"label":"second"}';
  assert.equal((await bound.call({ context: {} })).data.label, 'second');
  await assert.rejects(
    call(async (_request, execution) => {
      execution.validateResponse(observed);
      return observed;
    }).call({ context: {} }),
    /return the validated response/,
  );
});

void test('raw execution avoids inspection tracking allocations', async () => {
  const raw = call(async () => response());
  const scoped = call(async (_request, execution) =>
    execution.validateResponse(response()),
  );
  // Materialize lazy schema methods before measuring execution's bookkeeping.
  await raw.call({ context: {} });
  await scoped.call({ context: {} });
  const NativeWeakMap = globalThis.WeakMap;
  const NativeWeakSet = globalThis.WeakSet;
  const allocations = { maps: 0, sets: 0 };
  try {
    globalThis.WeakMap = new Proxy(NativeWeakMap, {
      construct(target, args, newTarget) {
        allocations.maps++;
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
    globalThis.WeakSet = new Proxy(NativeWeakSet, {
      construct(target, args, newTarget) {
        allocations.sets++;
        return Reflect.construct(target, args, newTarget) as object;
      },
    });
    await raw.call({ context: {} });
    assert.deepEqual(allocations, { maps: 0, sets: 0 });
    await scoped.call({ context: {} });
    assert.deepEqual(allocations, { maps: 1, sets: 1 });
  } finally {
    globalThis.WeakMap = NativeWeakMap;
    globalThis.WeakSet = NativeWeakSet;
  }
});

void test('scoped recovery receives pagination failures before it chooses a final response', async () => {
  const read = operation();
  let validationCount = 0;
  let pages = 0;
  const result = await executeRequest(
    read.build(),
    async (_request, execution) => {
      const invalid = execution.validateResponse(response());
      assert.equal(invalid.kind, 'protocol');
      if (invalid.kind !== 'protocol') assert.fail();
      assert.equal(Object.isFrozen(invalid.issues), true);
      assert.equal(Object.isFrozen(invalid.issues[0]!.path), true);
      assert.throws(
        () => Object.assign(invalid.issues[0]!, { message: 'edit' }),
        TypeError,
      );
      return execution.validateResponse(response());
    },
    {},
    new AbortController().signal,
    {
      operation: read,
      namespace: 'scoped',
      client: 'consumer',
      operationId: 'read',
    },
    () => {
      validationCount++;
      return pages++ === 0
        ? [{ part: 'body', path: ['offset'], message: 'offset mismatch' }]
        : [];
    },
  );
  assert.equal(result.data.label, 'first');
  assert.equal(validationCount, 2);
});

void test('private mutable bodies preserve special map keys, -0, and deeply nested JSON', async () => {
  const raw = defineOperation({
    operationId: 'json',
    method: 'GET',
    path: '/json',
    bodyKind: 'none',
    security: { transport: 'none' },
    policy,
    parameters: [],
    options: noOptions,
    headers: {},
    responses: { 200: { bodyKind: 'json', headers: {}, schema: jsonValue } },
  });
  const depth = 12_000;
  const body =
    '{"__proto__":{"constructor":-0},"constructor":null,"keys":[{"constructor":false}],"nested":' +
    '['.repeat(depth) +
    'null' +
    ']'.repeat(depth) +
    '}';
  const bound = defineCall({
    operation: raw,
    namespace: 'scoped',
    client: 'consumer',
    operationId: 'json',
    execute: async (_request, execution) => {
      const inspected = execution.validateResponse({ ...response(), body });
      if (inspected.kind !== 'success') assert.fail();
      const tree = record(inspected.data);
      assert.equal(Object.isFrozen(tree), true);
      assert.equal(Object.getPrototypeOf(tree), Object.prototype);
      assert.deepEqual(Object.keys(tree), [
        '__proto__',
        'constructor',
        'keys',
        'nested',
      ]);
      assert.equal(Object.hasOwn(tree, '__proto__'), true);
      assert.equal(Object.hasOwn(tree, 'constructor'), true);
      assert.equal(tree['constructor'], null);
      const descriptor = Object.getOwnPropertyDescriptor(tree, '__proto__')!;
      assert.equal(descriptor.enumerable, true);
      assert.equal(descriptor.writable, false);
      assert.equal(descriptor.configurable, false);
      assert.equal(
        Object.is(record(tree['__proto__'])['constructor'], -0),
        true,
      );
      let cursor = tree['nested'];
      for (let index = 0; index < depth; index++) {
        assert.ok(Array.isArray(cursor));
        assert.equal(Object.isFrozen(cursor), true);
        const elements: readonly unknown[] = cursor;
        cursor = elements[0];
      }
      assert.equal(cursor, null);
      assert.throws(() => Object.assign(tree, { newField: true }), TypeError);
      return inspected;
    },
  });
  const result = await bound.call({ context: {} });
  const tree = record(result.data);
  assert.equal(Object.getPrototypeOf(tree), Object.prototype);
  assert.deepEqual(Object.keys(tree), [
    '__proto__',
    'constructor',
    'keys',
    'nested',
  ]);
  assert.equal(tree['constructor'], null);
  assert.equal(Object.isFrozen(tree), false);
  tree['newField'] = true;
  assert.equal(tree['newField'], true);
});

void test('inspection copies preserve own data when Object.prototype contains a setter', async () => {
  const name = '__pom_inspection_setter__';
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, name);
  let assignments = 0;
  Object.defineProperty(Object.prototype, name, {
    configurable: true,
    set() {
      assignments++;
    },
  });
  try {
    const raw = defineOperation({
      operationId: 'json',
      method: 'GET',
      path: '/json',
      bodyKind: 'none',
      security: { transport: 'none' },
      policy,
      parameters: [],
      options: noOptions,
      headers: {},
      responses: { 200: { bodyKind: 'json', headers: {}, schema: jsonValue } },
    });
    const bound = defineCall({
      operation: raw,
      namespace: 'scoped',
      client: 'consumer',
      operationId: 'json',
      execute: async (_request, execution) => {
        const inspected = execution.validateResponse({
          ...response(),
          body: JSON.stringify({ [name]: { kept: true } }),
        });
        if (inspected.kind !== 'success') assert.fail();
        const data = record(inspected.data);
        assert.equal(Object.hasOwn(data, name), true);
        assert.deepEqual(data[name], { kept: true });
        assert.equal(Object.isFrozen(data[name]), true);
        return inspected;
      },
    });
    const result = await bound.call({ context: {} });
    assert.deepEqual(record(result.data)[name], { kept: true });
    assert.equal(assignments, 0);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, name, previous);
    else Reflect.deleteProperty(Object.prototype, name);
  }
});

void test('callbacks expire on rejection and cancellation before evidence reuse is considered', async () => {
  for (const cancel of [false, true]) {
    let validate: Execution['validateResponse'] | undefined;
    const controller = new AbortController();
    const failure = new Error(cancel ? 'aborted' : 'executor failed');
    const observed = response();
    const bound = call(async (_request, execution) => {
      validate = execution.validateResponse;
      execution.validateResponse(observed);
      if (cancel) controller.abort(failure);
      throw failure;
    });
    assert.equal(
      await rejectionOf(bound.call({ context: {}, signal: controller.signal })),
      failure,
    );
    assert.ok(validate);
    const expired = validate;
    assert.throws(
      () => expired(observed),
      cancel
        ? (error: unknown) => error === failure
        : /invocation has completed/,
    );
  }
});

void test('scoped validation closes application budgets on fulfilled and rejected synchronous work', async () => {
  for (const throws of [false, true]) {
    let now = 0;
    const applicationFailure = new Error('validator failed');
    const deadline = new Error('attempt deadline');
    const read = operation(() => {
      now += 10;
      if (throws) throw applicationFailure;
    });
    const scoped = defineCall({
      operation: read,
      namespace: 'budget',
      client: 'consumer',
      operationId: 'read',
      execute: async (_request, execution) => {
        try {
          const checked = execution.validateResponse(response());
          if (now > 5) throw deadline;
          return checked;
        } catch (error) {
          if (now > 5) throw deadline;
          throw error;
        }
      },
    });
    assert.equal(await rejectionOf(scoped.call({ context: {} })), deadline);
  }
});

void test('cancellation mapping is once-only for pre-abort, late success and undefined rejection', async () => {
  for (const mode of ['pre', 'success', 'rejection'] as const) {
    const events: CancellationEvent[] = [];
    const controller = new AbortController();
    const mapped = new Error('classified application cancellation');
    let invoked = 0;
    const bound = call(
      async () => {
        invoked++;
        controller.abort(false);
        if (mode === 'rejection') {
          // oxlint-disable-next-line typescript/only-throw-error -- Cancellation events must distinguish an undefined rejection from no rejection.
          throw undefined;
        }
        return response();
      },
      (event) => {
        events.push(event);
        assert.equal(Object.isFrozen(event), true);
        return { error: mapped };
      },
    );
    if (mode === 'pre') controller.abort(false);
    assert.equal(
      await rejectionOf(
        bound.call({ context: { locale: 'en' }, signal: controller.signal }),
      ),
      mapped,
    );
    assert.equal(invoked, mode === 'pre' ? 0 : 1);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.reason, false);
    assert.equal(event.executorInvoked, mode !== 'pre');
    assert.equal(Object.hasOwn(event, 'rejection'), mode === 'rejection');
    if (mode === 'rejection') {
      assert.equal(Object.isFrozen(event.rejection), true);
      assert.equal(Object.hasOwn(event.rejection!, 'error'), true);
      assert.equal(event.rejection!.error, undefined);
    }
  }
});

void test('query guard cancellation reaches the shared mapper without transport', async () => {
  const controller = new AbortController();
  const sourceError = new Error('key getter failed');
  const mapped = new Error('mapped');
  let mappings = 0;
  const factory = defineQuery({
    operation: operation(),
    namespace: 'query-guard',
    client: 'consumer',
    operationId: 'read',
    execute: async () => {
      assert.fail('executor must not run');
    },
    mapCancellation: (event) => {
      mappings++;
      assert.equal(event.executorInvoked, false);
      assert.equal(event.rejection!.error, sourceError);
      return { error: mapped };
    },
  });
  const options = factory.options({ context: {} });
  const key = [...options.queryKey];
  Object.defineProperty(key, '0', {
    get() {
      controller.abort('guard');
      throw sourceError;
    },
  });
  assert.equal(
    await rejectionOf(
      runtimeInput(options.queryFn, {
        signal: controller.signal,
        queryKey: key,
      }),
    ),
    mapped,
  );
  assert.equal(mappings, 1);
});

void test('malformed or throwing cancellation mappers cannot be remapped', async () => {
  for (const value of [
    null,
    {},
    { error: 1, extra: true },
    Promise.resolve({ error: 1 }),
    Object.defineProperty({}, 'error', {
      enumerable: true,
      get() {
        assert.fail('accessor must not execute');
      },
    }),
  ]) {
    const controller = new AbortController();
    controller.abort('stop');
    const bound = invalidOptions(
      call,
      async () => response(),
      () => value,
    );
    await assert.rejects(
      bound.call({ context: {}, signal: controller.signal }),
      TypeError,
    );
  }
  const controller = new AbortController();
  controller.abort('stop');
  const failure = new Error('mapper failed');
  let mappings = 0;
  const bound = call(
    async () => response(),
    () => {
      mappings++;
      throw failure;
    },
  );
  assert.equal(
    await rejectionOf(bound.call({ context: {}, signal: controller.signal })),
    failure,
  );
  assert.equal(mappings, 1);
});
