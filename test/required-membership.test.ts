import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import {
  arrayParser,
  fixedObject,
  integerValue,
  nullValue,
  stringValue,
  textParser,
  unionParser,
  validator,
} from '../src/runtime.ts';
import { entry, record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import {
  requiredMembershipFixture,
  requiredMembershipSelection,
  verifyRequiredMembership,
} from './required-membership-fixture.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';

void test('ordinary objects report missing, invalid and unknown fields together', () => {
  type Person = {
    name: string;
    age: number;
    address: { city: string };
    email: string;
  };
  const person = fixedObject<Person>(
    {
      name: textParser({ minLength: 1 }),
      age: integerValue,
      address: fixedObject<{ city: string }>({ city: stringValue }, true),
      email: stringValue,
    },
    true,
  );
  const schema = validator(person);
  const failure = schema.safeParse({ name: '', age: 'x', address: {} });
  assert.equal(failure.success, false);
  if (!failure.success)
    assert.deepEqual(
      failure.error.issues.map((issue) => issue.path.join('.')).sort(),
      ['address.city', 'age', 'email', 'name'],
    );
  const nullable = validator(unionParser<Person | null>([person, nullValue]));
  const nullableFailure = nullable.safeParse({
    name: '',
    age: 'x',
    address: {},
  });
  assert.equal(nullableFailure.success, false);
  if (!failure.success && !nullableFailure.success)
    assert.deepEqual(nullableFailure.error.issues, failure.error.issues);
  const typo = schema.safeParse({
    nmae: 'Ann',
    age: 2,
    address: { city: 'Here' },
    email: 'a@example.test',
  });
  assert.equal(typo.success, false);
  if (!typo.success) {
    assert.equal(typo.error.issues.length, 2);
    assert.ok(
      typo.error.issues.some((issue) => issue.path.join('.') === 'name'),
    );
    assert.ok(
      typo.error.issues.some((issue) => issue.message.includes('nmae')),
    );
  }
});

const table = (strict: boolean) =>
  validator(
    fixedObject<{ children: string[]; revision: number }>(
      {
        children: arrayParser(stringValue),
        revision: integerValue,
      },
      strict,
    ),
  );

void test('ordinary diagnostics cannot manufacture initially missing required fields', () => {
  for (const strict of [true, false]) {
    const schema = table(strict);
    let reads = 0;
    const input = {
      get children() {
        reads++;
        Object.defineProperty(input, 'revision', {
          get() {
            assert.fail('initially missing fields must not be read');
          },
        });
        return [];
      },
    };
    const failure = schema.safeParse(input);
    assert.equal(failure.success, false);
    assert.equal(reads, 1);
    if (!failure.success)
      assert.deepEqual(failure.error.issues, [
        { path: ['revision'], message: 'expected a required property' },
      ]);
    assert.deepEqual(schema.parse({ children: [], revision: 1 }), {
      children: [],
      revision: 1,
    });
  }
});

void test('admitted objects retain structural fields and value read order', () => {
  const reads: string[] = [];
  class Value {
    get children() {
      reads.push('children');
      return ['leaf'];
    }
    get revision() {
      reads.push('revision');
      return 2;
    }
  }
  const schema = table(true);
  assert.deepEqual(schema.parse(new Value()), {
    children: ['leaf'],
    revision: 2,
  });
  assert.deepEqual(reads, ['children', 'revision']);
  const removing = { children: [] };
  Object.defineProperty(removing, 'revision', {
    configurable: true,
    get() {
      Reflect.deleteProperty(removing, 'revision');
      return 3;
    },
  });
  assert.deepEqual(schema.parse(removing), { children: [], revision: 3 });
});

void test('Object.prototype cannot supply required membership, but a nearer prototype can', () => {
  const before = Object.getOwnPropertyDescriptor(Object.prototype, 'revision');
  try {
    Object.defineProperty(Object.prototype, 'revision', {
      value: 1,
      configurable: true,
    });
    assert.equal(table(false).safeParse({ children: [] }).success, false);
    class Value {
      readonly children: string[] = [];
    }
    Object.defineProperty(Value.prototype, 'revision', { value: 2 });
    assert.deepEqual(table(true).parse(new Value()), {
      children: [],
      revision: 2,
    });
  } finally {
    if (before) Object.defineProperty(Object.prototype, 'revision', before);
    else Reflect.deleteProperty(Object.prototype, 'revision');
  }
});

void test('virtual proxy fields must report required membership before value reads', () => {
  // An own descriptor also proves presence, even if a proxy hides it from `in`.
  const hiddenOwn = new Proxy(
    { children: [], revision: 1 },
    { has: () => false },
  );
  assert.deepEqual(table(false).parse(hiddenOwn), {
    children: [],
    revision: 1,
  });
  for (const membership of [true, false]) {
    let reads = 0;
    const input = new Proxy(
      { children: [] },
      {
        has(target, key) {
          return key === 'revision' ? membership : Reflect.has(target, key);
        },
        get(target, key, receiver) {
          if (key === 'revision') {
            reads++;
            return 1;
          }
          const value: unknown = Reflect.get(target, key, receiver);
          return value;
        },
      },
    );
    const result = table(false).safeParse(input);
    assert.equal(result.success, membership);
    assert.equal(reads, membership ? 1 : 0);
  }
});

void test('recursive union admission avoids retry expansion at public boundaries', async (t) => {
  const files = await compile(
    requiredMembershipFixture(),
    requiredMembershipSelection,
  );
  const root = await generatedTestWorkspace(t, files);
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const roots = Object.fromEntries(
    await Promise.all(
      Object.keys(requiredMembershipSelection.standalone).map(
        async (name) =>
          [
            name,
            await importGenerated<StandaloneModule>(
              root,
              `standalone.${name}.ts`,
            ),
          ] as const,
      ),
    ),
  );
  verifyRequiredMembership(client, roots);
  for (const name of ['wide-request', 'wide-response']) {
    const schema = entry(roots, name).schema;
    let reads = 0;
    const failure = schema.safeParse({
      get children() {
        reads++;
        return [];
      },
    });
    assert.equal(failure.success, false);
    assert.equal(
      reads,
      1,
      'ordinary objects still validate present fields after recording entry shape',
    );
    if (!failure.success)
      assert.deepEqual(failure.error.issues[0]?.path, ['revision']);
    const combined = schema.safeParse({
      children: [1],
      optional128: 'wrong',
      nmae: 'hint',
    });
    assert.equal(combined.success, false);
    if (!combined.success) {
      assert.deepEqual(
        combined.error.issues.map((issue) => issue.path.join('.')).sort(),
        name === 'wide-request'
          ? ['', 'children.0', 'optional128', 'revision']
          : ['children.0', 'optional128', 'revision'],
      );
      if (name === 'wide-request')
        assert.ok(
          combined.error.issues.some((issue) => issue.message.includes('nmae')),
        );
    }
    const probes = new Map<PropertyKey, number>();
    let readingValues = false;
    const input = new Proxy(
      { children: [], revision: 1 },
      {
        getOwnPropertyDescriptor(target, key) {
          // The caller reports its initial shape, then hides descriptors once
          // values are read. Chunks must not admit this same object again.
          if (readingValues) return undefined;
          probes.set(key, (probes.get(key) ?? 0) + 1);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        has(target, key) {
          return !readingValues && Reflect.has(target, key);
        },
        get(target, key, receiver) {
          readingValues = true;
          const value: unknown = Reflect.get(target, key, receiver);
          return value;
        },
      },
    );
    assert.deepEqual(schema.parse(input), { children: [], revision: 1 });
    assert.equal(probes.get('children'), 1);
    assert.equal(
      probes.get('revision'),
      1,
      'chunks must not readmit the same object',
    );
  }
  let reads = 0;
  assert.throws(
    () =>
      entry(client.operations, 'ordered').build({
        query: {
          get '2'() {
            reads++;
            return 'value';
          },
        },
      }),
    (error) => {
      assert.ok(error instanceof client.RequestValidationError);
      assert.deepEqual(error.issues[0]?.path, ['query', '1']);
      return true;
    },
  );
  assert.equal(
    reads,
    1,
    'order-sensitive parameter bodies still validate their present fields',
  );
  assert.deepEqual(
    record(
      entry(client.operations, 'save').build({ body: { children: [] } }).body,
    ).children,
    [],
  );
});
