import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import { defineCall } from '../src/call-runtime.ts';
import { defineOperation } from '../src/runtime.ts';
import type { ObservedResponse } from '../src/runtime.ts';
import { noOptions } from './native-schemas.ts';
import { entry, record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';

function inherited<T>(values: Record<string, unknown>, check: () => T): T {
  const before = new Map(
    Object.keys(values).map((name) => [
      name,
      Object.getOwnPropertyDescriptor(Object.prototype, name),
    ]),
  );
  try {
    for (const [name, value] of Object.entries(values))
      Object.defineProperty(Object.prototype, name, {
        value,
        writable: true,
        configurable: true,
      });
    return check();
  } finally {
    for (const [name, descriptor] of before)
      if (descriptor) Object.defineProperty(Object.prototype, name, descriptor);
      else Reflect.deleteProperty(Object.prototype, name);
  }
}

const definition = {
  operationId: 'read',
  method: 'GET',
  path: '/read',
  bodyKind: 'none' as const,
  parameters: [],
  options: noOptions,
  headers: {},
  responses: { 204: { bodyKind: 'none' as const, headers: {} } },
};

void test('prepared metadata stays detached, frozen and absent across prototype changes', () => {
  for (const cold of [true, false]) {
    const security = { transport: 'none' } as const;
    const policy: Record<string, string> = { declared: 'original' };
    const create = () => defineOperation({ ...definition, security, policy });
    let operation = cold ? undefined : create();
    inherited(
      { auth: 'inherited', scheme: 'inherited', optional: 'inherited' },
      () => {
        operation ??= create();
        const request = operation.build();
        assert.equal(Object.getPrototypeOf(request.policy), null);
        assert.equal(Object.getPrototypeOf(request.security), null);
        assert.equal(Object.isFrozen(request.policy), true);
        assert.equal(Object.isFrozen(request.security), true);
        assert.equal(request.policy.auth, undefined);
        assert.equal(request.policy.optional, undefined);
        assert.equal(Reflect.get(request.security, 'scheme'), undefined);
        assert.equal(Object.hasOwn(request.policy, 'auth'), false);
        assert.equal(Object.hasOwn(request.security, 'scheme'), false);
        assert.deepEqual({ ...request.policy }, { declared: 'original' });
        assert.deepEqual({ ...request.security }, { transport: 'none' });
        assert.equal(Reflect.set(request.policy, 'declared', 'changed'), false);
      },
    );
    assert.ok(operation);
    policy.declared = 'later';
    assert.equal(operation.build().policy.declared, 'original');
  }
});

void test('bound and arrow executors retain their receiver while callbacks remain unbound', async () => {
  const operation = defineOperation({
    ...definition,
    security: { transport: 'none' },
    policy: {},
  });
  const response: ObservedResponse = { status: 204, headers: {}, body: '' };
  class Adapter {
    calls = 0;
    response = response;
    async method(this: Adapter): Promise<ObservedResponse> {
      this.calls++;
      return this.response;
    }
    execute = async (): Promise<ObservedResponse> => {
      this.calls++;
      return this.response;
    };
  }
  const adapter = new Adapter();
  const identity = {
    operation,
    namespace: 'receivers',
    client: 'consumer',
    operationId: 'read',
  };
  for (const execute of [adapter.method.bind(adapter), adapter.execute]) {
    const call = defineCall({ ...identity, execute });
    assert.equal((await call.call({ context: {} })).status, 204);
  }
  assert.equal(adapter.calls, 2);
  let called = false;
  const callback = defineCall({
    ...identity,
    execute: async function (this: void): Promise<ObservedResponse> {
      called = true;
      assert.equal(this, undefined);
      return response;
    },
  });
  await callback.call({ context: {} });
  assert.equal(called, true);
});

void test('generated multipart builders omit undefined parts without changing generic structural validation', async (t) => {
  const binary = { type: 'string', format: 'binary' };
  const root = await generatedTestWorkspace(
    t,
    await compile(
      {
        openapi: '3.1.2',
        info: { title: 'Synthetic prepared boundaries', version: '1' },
        components: {
          schemas: {
            Text: {
              type: 'object',
              properties: { caption: { type: 'string' } },
            },
            Upload: {
              type: 'object',
              required: ['file'],
              properties: {
                file: binary,
                caption: { type: 'string' },
                extra: binary,
                files: { type: 'array', items: binary },
              },
            },
          },
        },
        paths: {
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
              responses: { 204: { description: 'Empty' } },
            },
          },
        },
      },
      {
        clients: ['browser', 'native'],
        surfaces: { browser: ['upload'], native: ['upload'] },
        targets: { browser: 'browser', native: 'native' },
        standalone: {
          text: { schema: '#/components/schemas/Text', usage: 'request' },
        },
      },
    ),
  );
  const text = await importGenerated<StandaloneModule>(
    root,
    'standalone.text.ts',
  );
  const structural = record(text.schema.parse({ caption: undefined }));
  assert.equal(Object.hasOwn(structural, 'caption'), true);
  assert.equal(structural.caption, undefined);
  for (const [target, file] of [
    ['browser', new File(['content'], 'upload.txt')],
    ['native', { uri: 'file:///synthetic/upload.txt' }],
  ] as const) {
    const client = await importGenerated<RuntimeClient>(
      root,
      `client.${target}.ts`,
    );
    const input = {
      file,
      caption: undefined,
      extra: undefined,
      files: undefined,
    };
    const request = entry(client.operations, 'upload').build({ body: input });
    assert.deepEqual(Object.keys(record(request.body)), ['file']);
    assert.equal(Object.hasOwn(input, 'caption'), true);
    assert.equal(Object.hasOwn(input, 'extra'), true);
    assert.equal(Object.hasOwn(input, 'files'), true);
    inherited({ auth: 'inherited', scheme: 'inherited' }, () => {
      assert.equal(request.policy.auth, undefined);
      assert.equal(Reflect.get(request.security, 'scheme'), undefined);
      const next = entry(client.operations, 'upload').build({ body: input });
      assert.equal(next.policy.auth, undefined);
      assert.equal(Reflect.get(next.security, 'scheme'), undefined);
    });
    if (target === 'browser') {
      const form = new FormData();
      for (const [name, value] of Object.entries(record(request.body))) {
        assert.ok(value instanceof File);
        form.append(name, value);
      }
      const decoded = await new Request('https://synthetic.invalid/upload', {
        method: 'POST',
        body: form,
      }).formData();
      assert.deepEqual([...decoded.keys()], ['file']);
    }
  }
});
