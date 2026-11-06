import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import { jsonAnnotation } from '../dist/annotations.js';
import { parseJson } from '../dist/json.js';
import { parseYaml } from '../dist/yaml.js';
import type { Schema } from './schema-helpers.ts';

function polluted<T>(name: string, value: unknown, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, name);
  Object.defineProperty(Object.prototype, name, {
    value,
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(Object.prototype, name, previous);
    else Reflect.deleteProperty(Object.prototype, name);
  }
}

void test('annotation root frames ignore inherited source while retaining shared and cyclic JSON checks', () => {
  const shared = { value: 'annotation' };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  polluted('source', 'inherited', () => {
    jsonAnnotation(null, 'example');
    jsonAnnotation([shared, shared, 'annotation'], 'example');
    assert.throws(
      () => jsonAnnotation(cycle, 'example'),
      (error) =>
        error instanceof ContractError &&
        error.location === 'example' &&
        /without cycles/.test(error.message),
    );
  });
});

void test('JSON array frames ignore inherited key sets without weakening duplicate object checks', () => {
  const inherited = new Set<string>();
  polluted('keys', inherited, () => {
    assert.deepEqual(
      parseJson(
        '["repeat","repeat","repeat",{"key":1},{"key":2}]',
        'array.json',
      ),
      ['repeat', 'repeat', 'repeat', { key: 1 }, { key: 2 }],
    );
    assert.throws(
      () => parseJson('[{"key":1,"key":2}]', 'duplicate.json'),
      (error) =>
        error instanceof ContractError &&
        error.location === 'duplicate.json:1:11' &&
        /duplicate key "key"/.test(error.message),
    );
    assert.equal(inherited.size, 0);
  });
});

void test('YAML root frames ignore inherited nodes while preserving scalars, shared aliases and cycle errors', () => {
  polluted('node', 'inherited', () => {
    assert.equal(parseYaml('value\n', 'scalar.yaml'), 'value');
    const parsed = parseYaml(
      'first: &shared [a, b]\nsecond: *shared\n',
      'alias.yaml',
    );
    assert.deepEqual(parsed, { first: ['a', 'b'], second: ['a', 'b'] });
    assert.ok(parsed && typeof parsed === 'object');
    assert.equal(Reflect.get(parsed, 'first'), Reflect.get(parsed, 'second'));
    assert.throws(
      () => parseYaml('self: &cycle {back: *cycle}\n', 'cycle.yaml'),
      (error) =>
        error instanceof ContractError &&
        /aliases must not create cycles/.test(error.message),
    );
  });
});

const selection = {
  clients: [],
  standalone: {
    value: { schema: '#/components/schemas/Value', usage: 'request' },
  },
} as const;

function document(schema: Schema, openapi = '3.0.4') {
  return {
    openapi,
    info: { title: 'Synthetic private compiler frames', version: '1' },
    paths: {},
    components: { schemas: { Value: schema } },
  };
}

void test('extension grammar shapes ignore inherited fields during 3.0 lowering and opaque annotation traversal', async () => {
  for (const [name, value, schema] of [
    ['list', true, { type: 'string', nullable: true }],
    [
      'entries',
      'schema',
      { type: 'string', example: { nullable: true, allOf: ['opaque JSON'] } },
    ],
    ['fields', { Value: 'annotation' }, { type: 'string', nullable: true }],
  ] satisfies [string, unknown, Schema][]) {
    const input = document(schema);
    const expected = await compile(input, selection);
    const before = structuredClone(input);
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, name);
    let actual: Readonly<Record<string, string>>;
    Object.defineProperty(Object.prototype, name, {
      value,
      configurable: true,
      writable: true,
    });
    try {
      actual = await compile(input, selection);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, name, previous);
      else Reflect.deleteProperty(Object.prototype, name);
    }
    assert.deepEqual(actual, expected, name);
    assert.deepEqual(input, before, `${name}: caller input`);
  }
});

void test('type-node filenames initialize their own slot before assignment under an inherited read-only file property', async () => {
  const input = document({ type: 'string' }, '3.1.2');
  const expected = await compile(input, selection);
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'file');
  let actual: Readonly<Record<string, string>>;
  Object.defineProperty(Object.prototype, 'file', {
    value: 'inherited.ts',
    configurable: true,
    writable: false,
  });
  try {
    actual = await compile(input, selection);
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'file', previous);
    else Reflect.deleteProperty(Object.prototype, 'file');
  }
  assert.deepEqual(actual, expected);
});
