import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';

void test('five registered format uses share one lazy regex per generated module across component drains', async (t) => {
  const pattern = 'shared-[a-z]+';
  const files = await compile(
    {
      openapi: '3.1.2',
      info: { title: 'Synthetic registered format sharing', version: '1' },
      paths: {},
      components: {
        schemas: {
          First: { type: 'string', format: 'shared' },
          Value: {
            type: 'object',
            properties: {
              first: { $ref: '#/components/schemas/First' },
              a: { type: 'string', format: 'shared' },
              b: { type: 'string', format: 'shared' },
              c: { type: 'string', format: 'shared' },
              d: { type: 'string', format: 'shared' },
              other: { type: 'string', format: 'other' },
            },
            required: ['first', 'a', 'b', 'c', 'd'],
          },
        },
      },
    },
    {
      clients: [],
      formats: {
        shared: { type: 'string', pattern },
        other: { type: 'string', pattern },
      },
      standalone: {
        request: { schema: '#/components/schemas/Value', usage: 'request' },
        response: { schema: '#/components/schemas/Value', usage: 'response' },
      },
    },
  );
  const root = await generatedTestWorkspace(t, files);
  const OriginalRegExp = RegExp;
  let constructions = 0;
  const counted = new Proxy(OriginalRegExp, {
    construct(target, args, newTarget) {
      const source: unknown = args[0];
      if (typeof source === 'string' && source.includes(pattern))
        constructions++;
      return Reflect.construct(target, args, newTarget) as object;
    },
  });
  const mock = t.mock.method(globalThis, 'RegExp', counted);
  try {
    const request = await importGenerated<StandaloneModule>(
      root,
      'standalone.request.ts',
    );
    const response = await importGenerated<StandaloneModule>(
      root,
      'standalone.response.ts',
    );
    assert.equal(constructions, 0);
    const value = {
      first: 'shared-first',
      a: 'shared-a',
      b: 'shared-b',
      c: 'shared-c',
      d: 'shared-d',
    };
    assert.deepEqual(request.schema.parse(value), value);
    assert.equal(constructions, 1);
    assert.deepEqual(response.schema.parse(value), value);
    assert.equal(
      constructions,
      2,
      'separate output modules keep independent descriptors',
    );
    for (let index = 0; index < 100; index++) {
      assert.deepEqual(request.schema.parse(value), value);
      assert.deepEqual(response.schema.parse(value), value);
    }
    assert.equal(constructions, 2);
    assert.equal(
      request.schema.safeParse({ ...value, a: 'invalid' }).success,
      false,
    );
    assert.equal(constructions, 2);
    const other = request.schema.safeParse({ ...value, other: 'invalid' });
    assert.equal(other.success, false);
    if (!other.success)
      assert.match(JSON.stringify(other.error.issues), /expected other format/);
    assert.equal(constructions, 3);
  } finally {
    mock.mock.restore();
  }
});
