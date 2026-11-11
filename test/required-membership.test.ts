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

void test('class fields retain their captured validated values', () => {
  let childrenReads = 0;
  let revisionReads = 0;
  class Value {
    get children() {
      return ++childrenReads === 1 ? ['leaf'] : [false];
    }
    get revision() {
      return ++revisionReads === 1 ? 2 : 'invalid';
    }
  }
  assert.deepEqual(table(true).parse(new Value()), {
    children: ['leaf'],
    revision: 2,
  });
  assert.equal(childrenReads, 1);
  assert.equal(revisionReads, 1);
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
    const failure = schema.safeParse({ children: [] });
    assert.equal(failure.success, false);
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
  }
  assert.deepEqual(
    record(
      entry(client.operations, 'save').build({ body: { children: [] } }).body,
    ).children,
    [],
  );
});
