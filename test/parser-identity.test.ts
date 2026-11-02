import assert from 'node:assert/strict';
import test from 'node:test';
import { parserIdentities } from '../dist/emit-schema.js';
import type { Schema } from '../dist/model.js';

void test('pure-alias identity resolves shared suffixes with linear table lookups', () => {
  const count = 8192;
  const schemas: Record<string, Schema> = {
    Root: { kind: 'string' },
    Constrained: {
      kind: 'ref',
      location: 'test',
      name: 'Root',
      constraints: { minLength: 1 },
    },
  };
  let previous = 'Constrained';
  for (let index = 0; index < count; index++) {
    const name = `Alias${index}`;
    schemas[name] = {
      kind: 'ref',
      location: 'test',
      name: previous,
      constraints: {},
    };
    previous = name;
  }
  let lookups = 0;
  const identity = parserIdentities(
    new Proxy(schemas, {
      get(target, key) {
        if (typeof key !== 'string') return undefined;
        lookups++;
        return target[key];
      },
    }),
  );
  // Start at the longest path, then revisit every shared suffix in reverse order.
  assert.equal(identity(previous), 'Constrained');
  for (let index = count - 1; index >= 0; index--)
    assert.equal(identity(`Alias${index}`), 'Constrained');
  assert.equal(identity('Root'), 'Root');
  assert.ok(lookups <= count + 2);
});

void test('identity caches remain local to each normalized schema table', () => {
  const text = parserIdentities({
    Root: { kind: 'string' },
    Alias: { kind: 'ref', location: 'test', name: 'Root', constraints: {} },
  });
  const constrained = parserIdentities({
    Root: { kind: 'string' },
    Alias: {
      kind: 'ref',
      location: 'test',
      name: 'Root',
      constraints: { minLength: 1 },
    },
  });
  assert.equal(text('Alias'), 'Root');
  assert.equal(constrained('Alias'), 'Alias');
  assert.equal(text('Alias'), 'Root');
});
