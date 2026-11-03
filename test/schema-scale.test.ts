import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSchema, validateSchema } from '../dist/schemas.js';

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
  const schemas = Object.fromEntries(
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
      oneOf: Object.keys(schemas).map((name) => ({
        $ref: `#/components/schemas/${name}`,
      })),
      discriminator: {
        propertyName: 'kind',
        mapping: Object.fromEntries(
          Object.keys(schemas).map((name, index) => [
            `kind${index}`,
            `#/components/schemas/${name}`,
          ]),
        ),
      },
    },
    'selection',
  );
  assert.ok(normalized.kind === 'union' && normalized.discriminator);
  let reads = 0;
  const mapping = new Proxy(normalized.discriminator.mapping, {
    get(target, key, receiver): unknown {
      if (typeof key === 'string' && Object.hasOwn(target, key)) reads++;
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  const selection = {
    ...normalized,
    discriminator: { ...normalized.discriminator, mapping },
  };
  validateSchema(selection, schemas, 'selection');
  assert.ok(
    reads <= 3 * size,
    `mapping traversal must stay linear; observed ${reads} reads`,
  );
  assert.throws(
    () =>
      validateSchema(
        {
          ...selection,
          discriminator: {
            ...selection.discriminator,
            mapping: { ...mapping, kind0: 'Branch1' },
          },
        },
        schemas,
        'selection',
      ),
    /cover every distinct oneOf branch/,
  );
});
