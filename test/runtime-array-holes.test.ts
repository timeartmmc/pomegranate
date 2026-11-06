import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import {
  defineOperation,
  field,
  invalid,
  multipleOf,
  numeric,
  objectValue,
  RequestValidationError,
  stringValue,
  validator,
} from '../src/runtime.ts';
import type { Invalid, Issues } from '../src/runtime.ts';
import { noOptions } from './native-schemas.ts';
import { entry } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';

function inheritedIndex<T>(name: '0' | '1', value: unknown, check: () => T): T {
  const before = Object.getOwnPropertyDescriptor(Object.prototype, name);
  try {
    Object.defineProperty(Object.prototype, name, {
      value,
      writable: true,
      configurable: true,
    });
    return check();
  } finally {
    if (before) Object.defineProperty(Object.prototype, name, before);
    else Reflect.deleteProperty(Object.prototype, name);
  }
}

function bodyOptions(
  input: unknown,
  issues: Issues,
): { body: string } | Invalid {
  const source = objectValue(input, issues);
  if (source === invalid) return invalid;
  const body = field(source, 'body', stringValue, issues);
  return body === invalid ? invalid : { body };
}

const definition = {
  security: { transport: 'none' } as const,
  policy: {},
  parameters: [],
  headers: {},
  responses: { 204: { bodyKind: 'none' as const, headers: {} } },
};

void test('omitted builder arguments cannot recover inherited array elements', () => {
  const optional = defineOperation({
    ...definition,
    operationId: 'optional',
    method: 'GET',
    path: '/optional',
    bodyKind: 'none',
    options: noOptions,
  });
  const required = defineOperation({
    ...definition,
    operationId: 'required',
    method: 'POST',
    path: '/required',
    bodyKind: 'json',
    options: bodyOptions,
  });
  inheritedIndex('0', { body: 'injected' }, () => {
    assert.equal(optional.build().bodyKind, 'none');
    assert.equal(optional.build(undefined).bodyKind, 'none');
    assert.throws(
      () => Reflect.apply(required.build, undefined, []),
      RequestValidationError,
    );
    assert.equal(required.build({ body: 'declared' }).body, 'declared');
  });
});

const multiples = [
  [2, 4, true],
  [2, 0.4, false],
  [2, -4, true],
  [2, -0, true],
  [0.1, 0.3, true],
  [0.1, 0.30000000000000004, false],
  [0.5, 0.5, true],
  [1e21, 1e20, false],
  [1e21, 3e21, true],
  [1e-7, 3e-7, true],
  [1e-7, 3.1e-7, false],
  [5e-324, 1e-323, true],
  [1e-323, 5e-324, false],
  [2.5e-200, 5e-200, true],
  [2.5e-200, 5.1e-200, false],
] as const;

void test('decimal multiples preserve exact ordinary, scientific and subnormal values under numeric prototype data', () => {
  for (const polluted of [false, true]) {
    const check = () => {
      for (const [divisor, value, expected] of multiples)
        assert.equal(
          multipleOf(divisor)(value),
          expected,
          `${value} multipleOf ${divisor}; polluted=${polluted}`,
        );
    };
    if (polluted) inheritedIndex('1', '0', check);
    else check();
  }
});

void test('cached multipleOf predicates cannot retain a polluted missing fraction after cleanup', () => {
  for (const [divisor, invalidValue] of [
    [2, 0.4],
    [1e21, 1e20],
  ] as const)
    for (const warm of [false, true]) {
      const rules = { multipleOf: divisor };
      const schema = validator((input, issues) =>
        numeric(input, issues, rules),
      );
      if (warm) assert.equal(schema.safeParse(divisor).success, true);
      const captured = inheritedIndex('1', '0', () => ({
        check: multipleOf(divisor),
        valid: schema.safeParse(divisor).success,
      }));
      assert.equal(captured.valid, true);
      assert.equal(captured.check(invalidValue), false);
      assert.equal(captured.check(divisor), true);
      assert.equal(schema.safeParse(invalidValue).success, false);
      assert.equal(schema.safeParse(divisor).success, true);
    }
});

void test('generated builders and cold cached validators ignore absent numeric array slots', async (t) => {
  const files = await compile(
    {
      openapi: '3.1.2',
      info: { title: 'Synthetic numeric prototype data', version: '1' },
      components: {
        schemas: { Even: { type: 'number', multipleOf: 2 } },
      },
      paths: {
        '/read': {
          get: {
            operationId: 'read',
            responses: { 204: { description: 'Empty' } },
          },
        },
      },
    },
    {
      clients: ['consumer'],
      surfaces: { consumer: ['read'] },
      standalone: {
        even: { schema: '#/components/schemas/Even', usage: 'request' },
      },
    },
  );
  const root = await generatedTestWorkspace(t, files);
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const even = await importGenerated<StandaloneModule>(
    root,
    'standalone.even.ts',
  );
  inheritedIndex('0', { body: 'injected' }, () => {
    const request = entry(client.operations, 'read').build();
    assert.equal(request.bodyKind, 'none');
    assert.equal(Object.hasOwn(request, 'body'), false);
  });
  inheritedIndex('1', '0', () => even.schema.safeParse(2));
  assert.equal(even.schema.safeParse(0.4).success, false);
  assert.equal(even.schema.safeParse(2).success, true);
});
