import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSchema, validateSchema } from '../dist/schemas.js';
import { schemaType } from '../dist/schema-types.js';
import { schemaRenderer } from '../dist/emit-schema.js';
import { identifier } from '../dist/code.js';

void test('wide required objects retain their contract with linear membership reads during type and parser emission', () => {
  const size = 4_000;
  const names = Array.from({ length: size }, (_, index) => `field${index}`);
  const schema = normalizeSchema(
    {
      type: 'object',
      properties: Object.fromEntries(
        names.map((name) => [name, { type: 'string' }]),
      ),
      required: names,
    },
    'wide',
  );
  assert.ok(schema.kind === 'object');
  let reads = 0;
  const required = new Proxy(schema.required, {
    get(target, key, receiver): unknown {
      if (
        typeof key === 'string' &&
        key !== 'length' &&
        Object.hasOwn(target, key)
      )
        reads++;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const indexed = { ...schema, required };
  assert.equal(schemaType(indexed, 'request'), schemaType(schema, 'request'));
  const renderer = schemaRenderer(
    { request: new Map([['Wide', indexed]]), response: new Map() },
    identifier,
    (schema, direction) => schemaType(schema, direction),
  );
  renderer.define(
    indexed,
    'request',
    'wide',
    'wide',
    'parse_Wide',
    'Wide',
    false,
  );
  assert.ok(
    reads <= 2 * size,
    `required membership must stay linear; observed ${reads} reads`,
  );
  assert.deepEqual([...required], schema.required);
});

void test('large enums retain order and reject late and SameValueZero duplicates', () => {
  const values = Array.from({ length: 80_000 }, (_, index) => `value${index}`);
  const schema = normalizeSchema({ type: 'string', enum: values }, 'enum');
  assert.ok(schema.kind === 'string');
  assert.deepEqual(schema.literals, values);
  assert.throws(
    () =>
      normalizeSchema({ type: 'string', enum: [...values, values[0]] }, 'enum'),
    /duplicate literal/,
  );
  assert.throws(
    () => normalizeSchema({ type: 'number', enum: [-0, 0] }, 'enum'),
    /duplicate literal/,
  );
});

void test('discriminator coverage reads mapping values a bounded number of times', () => {
  const size = 512;
  const schemas = new Map(
    Array.from({ length: size }, (_, index) => [
      `Branch${index}`,
      normalizeSchema(
        {
          type: 'object',
          required: ['kind'],
          properties: { kind: { type: 'string', const: `kind${index}` } },
        },
        `Branch${index}`,
      ),
    ]),
  );
  const normalized = normalizeSchema(
    {
      oneOf: [...schemas.keys()].map((name) => ({
        $ref: `#/components/schemas/${name}`,
      })),
      discriminator: {
        propertyName: 'kind',
        mapping: Object.fromEntries(
          [...schemas.keys()].map((name, index) => [
            `kind${index}`,
            `#/components/schemas/${name}`,
          ]),
        ),
      },
    },
    'selection',
  );
  assert.ok(normalized.kind === 'union' && normalized.discriminator);
  class CountedMapping extends Map<string, number> {
    reads = 0;
    override get(name: string) {
      this.reads++;
      return super.get(name);
    }
    override *values() {
      for (const value of super.values()) {
        this.reads++;
        yield value;
      }
      return undefined;
    }
  }
  const mapping = new CountedMapping(normalized.discriminator.mapping);
  const selection = {
    ...normalized,
    discriminator: { ...normalized.discriminator, mapping },
  };
  validateSchema(selection, schemas, 'selection');
  assert.ok(
    mapping.reads <= 3 * size,
    `mapping traversal must stay linear; observed ${mapping.reads} reads`,
  );
  assert.throws(
    () =>
      validateSchema(
        {
          ...selection,
          discriminator: {
            ...selection.discriminator,
            mapping: new Map(mapping).set('kind0', 1),
          },
        },
        schemas,
        'selection',
      ),
    /cover every distinct oneOf branch/,
  );
});
