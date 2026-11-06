import assert from 'node:assert/strict';
import test from 'node:test';
import { parserIdentities } from '../dist/emit-schema.js';
import type { Schema } from '../dist/model.js';
import { constraintRecord, schemaNode } from '../dist/schema-node.js';

void test('pure-alias identity resolves shared suffixes with linear table lookups', () => {
  const count = 8192;
  let lookups = 0;
  class CountedSchemas extends Map<string, Schema> {
    override get(name: string) {
      lookups++;
      return super.get(name);
    }
  }
  const schemas = new CountedSchemas([
    ['Root', schemaNode({ kind: 'string' })],
    [
      'Constrained',
      schemaNode({
        kind: 'ref',
        location: 'test',
        name: 'Root',
        constraints: constraintRecord({ minLength: 1 }),
      }),
    ],
  ]);
  let previous = 'Constrained';
  for (let index = 0; index < count; index++) {
    const name = `Alias${index}`;
    schemas.set(
      name,
      schemaNode({
        kind: 'ref',
        location: 'test',
        name: previous,
        constraints: constraintRecord(),
      }),
    );
    previous = name;
  }
  const identity = parserIdentities(schemas);
  // Start at the longest path, then revisit every shared suffix in reverse order.
  assert.equal(identity(previous), 'Constrained');
  for (let index = count - 1; index >= 0; index--)
    assert.equal(identity(`Alias${index}`), 'Constrained');
  assert.equal(identity('Root'), 'Root');
  assert.ok(lookups <= count + 2);
});

void test('identity caches remain local to each normalized schema table', () => {
  const text = parserIdentities(
    new Map([
      ['Root', schemaNode({ kind: 'string' })],
      [
        'Alias',
        schemaNode({
          kind: 'ref',
          location: 'test',
          name: 'Root',
          constraints: constraintRecord(),
        }),
      ],
    ]),
  );
  const constrained = parserIdentities(
    new Map([
      ['Root', schemaNode({ kind: 'string' })],
      [
        'Alias',
        schemaNode({
          kind: 'ref',
          location: 'test',
          name: 'Root',
          constraints: constraintRecord({ minLength: 1 }),
        }),
      ],
    ]),
  );
  assert.equal(text('Alias'), 'Root');
  assert.equal(constrained('Alias'), 'Alias');
  assert.equal(text('Alias'), 'Root');
});
