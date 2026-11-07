import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const pattern = '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$';
const variants: readonly [string, Schema][] = [
  ['pattern', { type: 'string', pattern }],
  ['format', { type: 'string', format: 'grouped-base64' }],
];

function fixture(value: Schema) {
  const schema = { $ref: '#/components/schemas/Envelope' };
  const content = { 'application/json': { schema } };
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic regexp exhaustion', version: '1' },
    components: {
      schemas: {
        Envelope: {
          type: 'object',
          required: ['payload'],
          properties: { payload: value },
        },
      },
    },
    paths: {
      '/value': {
        post: {
          operationId: 'write',
          requestBody: { required: true, content },
          responses: { 200: { description: 'Synthetic value', content } },
        },
      },
    },
  };
}

const selection = {
  clients: ['consumer'],
  surfaces: { consumer: ['write'] },
  formats: { 'grouped-base64': { type: 'string', pattern } },
  standalone: {
    root: { schema: '#/components/schemas/Envelope', usage: 'request' },
  },
} as const;

for (const [name, value] of variants) {
  void test(`${name} exhaustion becomes validation issues at standalone/request/response boundaries`, async (t) => {
    const root = await generatedTestWorkspace(
      t,
      await compile(fixture(value), selection),
    );
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      'standalone.root.ts',
    );
    const { operations, RequestValidationError } =
      await importGenerated<RuntimeClient>(root, 'client.consumer.ts');
    const operation = present(operations.write);
    const observed = (payload: string) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    assert.deepEqual(schema.parse({ payload: 'AAAA' }), { payload: 'AAAA' });
    assert.deepEqual(operation.build({ body: { payload: 'AAAA' } }).body, {
      payload: 'AAAA',
    });
    assert.equal(operation.parseResponse(observed('AAAA')).kind, 'success');

    // Real engine limits vary. Valid large strings may pass or fail validation,
    // but a stack overflow must never escape any validation boundary.
    for (const size of [4, 8]) {
      const payload = 'A'.repeat(size * 1024 * 1024);
      const result = schema.safeParse({ payload });
      if (result.success === false) {
        assert.equal(result.error.name, 'ValidationError');
        assert.deepEqual(present(result.error.issues[0]).path, ['payload']);
      } else assert.deepEqual(result.data, { payload });
      try {
        assert.deepEqual(operation.build({ body: { payload } }).body, {
          payload,
        });
      } catch (error) {
        assert.ok(error instanceof RequestValidationError);
        assert.deepEqual(present(error.issues[0]).path, ['body', 'payload']);
      }
      assert.ok(
        ['success', 'protocol'].includes(
          operation.parseResponse(observed(payload)).kind,
        ),
      );
    }

    // Capture the method before mocking and invoke it with its original receiver.
    // oxlint-disable-next-line typescript/unbound-method
    const original = RegExp.prototype.test;
    const source = new RegExp(
      name === 'pattern' ? pattern : `^(?:${pattern})$`,
      'u',
    ).source;
    const mock = t.mock.method(
      RegExp.prototype,
      'test',
      function (this: RegExp, input: string) {
        if (this.source === source)
          throw new RangeError('synthetic regexp stack exhaustion');
        return original.call(this, input);
      },
    );
    try {
      const failure = schema.safeParse({ payload: 'AAAA' });
      assert.equal(failure.success, false);
      if (failure.success === false)
        assert.deepEqual(present(failure.error.issues[0]).path, ['payload']);
      assert.throws(() => schema.parse({ payload: 'AAAA' }), {
        name: 'ValidationError',
      });
      assert.throws(
        () => operation.build({ body: { payload: 'AAAA' } }),
        RequestValidationError,
      );
      assert.equal(operation.parseResponse(observed('AAAA')).kind, 'protocol');
    } finally {
      mock.mock.restore();
    }
  });
}

void test('length guards precede regex evaluation and byte format accepts large base64', async (t) => {
  const files = await compile(
    fixture({ type: 'string', pattern, maxLength: 4 }),
    selection,
  );
  const root = await generatedTestWorkspace(t, files);
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.root.ts',
  );
  // Capture the method before mocking and invoke it with its original receiver.
  // oxlint-disable-next-line typescript/unbound-method
  const original = RegExp.prototype.test;
  const source = new RegExp(pattern, 'u').source;
  const unexpected = new TypeError('regexp should not run');
  const mock = t.mock.method(
    RegExp.prototype,
    'test',
    function (this: RegExp, input: string) {
      if (this.source === source) throw unexpected;
      return original.call(this, input);
    },
  );
  try {
    assert.equal(schema.safeParse({ payload: 'AAAAAAAA' }).success, false);
    // Catch only engine exhaustion, not arbitrary application or engine errors.
    assert.throws(
      () => schema.safeParse({ payload: 'AAAA' }),
      (error) => error === unexpected,
    );
  } finally {
    mock.mock.restore();
  }
  const byteRoot = await generatedTestWorkspace(
    t,
    await compile(fixture({ type: 'string', format: 'byte' }), selection),
  );
  const byte = await importGenerated<StandaloneModule>(
    byteRoot,
    'standalone.root.ts',
  );
  assert.equal(
    byte.schema.safeParse({ payload: 'A'.repeat(8 * 1024 * 1024) }).success,
    true,
  );
});
