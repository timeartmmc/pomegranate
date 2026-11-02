import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';
import { compile } from '../dist/index.js';
import { nativeFixture } from './native-fixture.ts';

type Schemas = typeof import('./.generated/native/client.consumer.schemas.ts');
type Client = typeof import('./.generated/native/client.consumer.ts');
let root: string;
let schemas: Schemas;
let emittedSchemas: string;
let operations: Client['operations'];
let RequestValidationError: Client['RequestValidationError'];
before(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'pom-native-'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries(
    await compile(nativeFixture(), { clients: ['consumer'] }),
  ))
    await writeFile(join(root, name), source);
  emittedSchemas = await readFile(
    join(root, 'client.consumer.schemas.ts'),
    'utf8',
  );
  schemas = (await import(
    pathToFileURL(join(root, 'client.consumer.schemas.ts')).href
  )) as Schemas;
  ({ operations, RequestValidationError } = (await import(
    pathToFileURL(join(root, 'client.consumer.ts')).href
  )) as Client);
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function growing() {
  const input = ['first'];
  Object.defineProperty(input, '0', {
    get() {
      input.push('second', 'third');
      return 'first';
    },
  });
  return input;
}
function shrinking(length: number) {
  const input = Array<string>(length).fill('first');
  Object.defineProperty(input, '0', {
    configurable: true,
    get() {
      input.length = 1;
      return 'first';
    },
  });
  return input;
}

void test('arrays observe one count across constrained and long aliases, including build()', () => {
  for (const registry of [schemas.requestSchemas, schemas.responseSchemas]) {
    for (const name of [
      'ArrayMax',
      'ArrayMaxAlias',
      'ArrayMaxAlias2',
      'Alias999',
    ] as const) {
      const parser = registry[name];
      assert.deepEqual(parser.parse(growing()), ['first']);
      let reads = 0;
      const input = new Proxy(['first', 'second', 'third'], {
        get(target, key, receiver) {
          if (key === 'length') return ++reads === 1 ? 1 : 3;
          const value: unknown = Reflect.get(target, key, receiver);
          return value;
        },
      });
      assert.deepEqual(parser.parse(input), ['first']);
      assert.equal(reads, 1);
    }
    assert.equal(registry.ArrayMin.safeParse(shrinking(2)).success, false);
    assert.equal(registry.ArrayMinAlias.safeParse(shrinking(3)).success, false);
    assert.equal(registry.ArrayMaxAlias2, registry.ArrayMaxAlias);
    assert.equal(registry.Alias999, registry.ArrayMaxAlias);
  }
  for (const operation of [
    operations.checkArrayMax,
    operations.checkArrayMaxAlias,
    operations.checkArrayMaxAlias2,
    operations.checkAlias999,
  ])
    assert.deepEqual(operation.build({ body: growing() }).body, ['first']);
  assert.throws(
    () => operations.checkArrayMin.build({ body: shrinking(2) }),
    RequestValidationError,
  );
  assert.throws(
    () => operations.checkArrayMinAlias.build({ body: shrinking(3) }),
    RequestValidationError,
  );
});

void test('invalid observed lengths and effective bounds reject before item reads', () => {
  for (const registry of [schemas.requestSchemas, schemas.responseSchemas]) {
    for (const parser of [
      registry.ArrayMax,
      registry.ArrayMaxAlias,
      registry.Alias999,
    ]) {
      for (const length of [
        -1,
        0.5,
        NaN,
        Infinity,
        '1',
        null,
        undefined,
        0x100000000,
      ]) {
        let reads = 0;
        const input = new Proxy(['first'], {
          get(target, key, receiver) {
            if (key === 'length') {
              reads++;
              return length;
            }
            if (key === '0') throw new Error('invalid length visited an item');
            const value: unknown = Reflect.get(target, key, receiver);
            return value;
          },
        });
        assert.equal(parser.safeParse(input).success, false);
        assert.equal(reads, 1);
      }
    }
    for (const [parser, length] of [
      [registry.ArrayMax, 3],
      [registry.ArrayMaxAlias, 2],
      [registry.Alias999, 2],
      [registry.ArrayMin, 1],
      [registry.ArrayMinAlias, 2],
    ] as const) {
      const input = Array<string>(length).fill('first');
      Object.defineProperty(input, '0', {
        get() {
          throw new Error('out-of-bound array visited an item');
        },
      });
      assert.equal(parser.safeParse(input).success, false);
    }
  }
});

void test('arbitrary JSON uses the same observed-count policy and detaches repeated references', () => {
  for (const parser of [
    schemas.requestSchemas.AnyMap,
    schemas.responseSchemas.AnyMap,
  ]) {
    assert.deepEqual(parser.parse({ value: growing() }), { value: ['first'] });
    assert.equal(parser.safeParse({ value: shrinking(2) }).success, false);
    for (const length of [-1, 0.5, Infinity, '1', 0x100000000]) {
      let reads = 0;
      const value = new Proxy(['first'], {
        get(target, key, receiver) {
          if (key === 'length') {
            reads++;
            return length;
          }
          if (key === '0')
            throw new Error('invalid JSON length visited an item');
          const value: unknown = Reflect.get(target, key, receiver);
          return value;
        },
      });
      assert.equal(parser.safeParse({ value }).success, false);
      assert.equal(reads, 1);
    }
    const shared = { value: 1 };
    const result = parser.parse({ a: shared, b: shared });
    assert.notEqual(result.a, shared);
    assert.notEqual(result.a, result.b);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.equal(parser.safeParse({ cyclic }).success, false);
    let deep: unknown = 0;
    for (let level = 0; level < 20000; level++) deep = [deep];
    assert.equal(parser.safeParse({ deep }).success, true);
  }
});

void test('wide checked parsers aggregate every sibling and preserve structural/unknown-key policy', () => {
  for (const direction of ['requestSchemas', 'responseSchemas'] as const) {
    for (const width of [256, 1024] as const) {
      const parser = schemas[direction][width === 256 ? 'Wide256' : 'Wide1024'];
      let visits = 0;
      const keys = Array.from({ length: width }, (_, i) => `field${i}`);
      const source = Object.fromEntries(keys.map((key) => [key, 'value']));
      for (const key of keys)
        Object.defineProperty(source, key, {
          enumerable: true,
          get() {
            visits++;
            return 'value';
          },
        });
      const result = parser.parse(source);
      assert.notEqual(result, source);
      assert.equal(visits, width);
      assert.deepEqual(
        result,
        Object.fromEntries(keys.map((key) => [key, 'value'])),
      );
      assert.deepEqual(parser.parse(Object.create(source)), result);
      const failure = parser.safeParse(
        Object.fromEntries(keys.map((key) => [key, 1])),
      );
      assert.equal(failure.success, false);
      if (!failure.success)
        assert.deepEqual(
          failure.error.issues.map((issue) => issue.path[0]),
          [...keys].sort(),
        );
      for (const key of ['unknown', '__proto__']) {
        const extra = { ...result };
        Object.defineProperty(extra, key, {
          enumerable: true,
          get() {
            throw new Error('unknown value read');
          },
        });
        assert.equal(
          parser.safeParse(extra).success,
          direction === 'responseSchemas',
        );
      }
    }
  }
});

void test('large constrained literal enums retain checked membership in both directions', () => {
  for (const parser of [
    schemas.requestSchemas.LargeLiteral,
    schemas.responseSchemas.LargeLiteral,
  ]) {
    for (const input of ['v0', 'v1024', 'v2047'])
      assert.equal(parser.parse(input), input);
    for (const input of ['v2048', 'invalid', '', null, 0])
      assert.equal(parser.safeParse(input).success, false);
  }
});

void test('literal parsing skips proven scalar rules and emits one failure message per direction', (t) => {
  let checks = 0;
  // oxlint-disable-next-line typescript/unbound-method -- invoke the saved intrinsic with each original RegExp receiver below.
  const original = RegExp.prototype.test;
  t.mock.method(
    RegExp.prototype,
    'test',
    function (this: RegExp, input: string) {
      if (this.source === '^v[0-9]+$') checks++;
      return original.call(this, input);
    },
  );
  for (const registry of [schemas.requestSchemas, schemas.responseSchemas]) {
    assert.equal(registry.LargeLiteral.parse('v1024'), 'v1024');
    for (const input of ['outside', '', null, 0]) {
      const result = registry.LargeLiteral.safeParse(input);
      assert.equal(result.success, false);
      if (!result.success) {
        assert.equal(result.error.issues.length, 1);
        const issue = result.error.issues[0];
        assert.ok(issue);
        assert.deepEqual(issue.path, []);
        assert.ok(issue.message.startsWith('expected one of '));
      }
    }
    assert.equal(registry.LargeLiteralAlias.parse('v10'), 'v10');
    const narrowed = registry.LargeLiteralAlias.safeParse('v0');
    assert.equal(narrowed.success, false);
    if (!narrowed.success)
      assert.deepEqual(narrowed.error.issues, [
        { path: [], message: 'string is too short' },
      ]);
  }
  assert.equal(
    checks,
    0,
    'membership must not repeat the proven pattern check',
  );
  // Both directions need the message, but neither success path needs a copy.
  assert.ok((emittedSchemas.match(/expected one of /g) ?? []).length <= 2);
});

void test('nullable constraints report their useful branch without expected-null noise', () => {
  for (const registry of [schemas.requestSchemas, schemas.responseSchemas]) {
    for (const [name, input, expected] of [
      [
        'NullableArrayMax',
        ['a', 'b'],
        [{ path: [], message: 'expected at most 1 items' }],
      ],
      [
        'NullableArrayMin',
        ['a'],
        [{ path: [], message: 'expected at least 2 items' }],
      ],
      [
        'NullableMap',
        { value: 'x' },
        [{ path: ['value'], message: 'string is too short' }],
      ],
      [
        'NullableTagged',
        { kind: 'text', value: 'x' },
        [{ path: ['value'], message: 'string is too short' }],
      ],
      [
        'NullableTagged',
        { kind: 'count', value: 0 },
        [{ path: ['value'], message: 'expected value >= 1' }],
      ],
    ] as const) {
      const parser = registry[name];
      const result = parser.safeParse(input);
      assert.equal(result.success, false);
      if (!result.success) assert.deepEqual(result.error.issues, expected);
      assert.equal(parser.parse(null), null);
    }
    // Wrong entry types still retain both branch diagnostics.
    const wrongType = registry.NullableMap.safeParse({ value: 0 });
    assert.equal(wrongType.success, false);
    if (!wrongType.success)
      assert.deepEqual(wrongType.error.issues, [
        { path: ['value'], message: 'union branch 1: expected a string' },
        { path: [], message: 'union branch 2: expected null' },
      ]);
  }
});
