import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import { normalizeSchema } from '../dist/schemas.js';
import { validateSchema } from '../dist/schema-validation.js';
import type { Schema } from '../dist/model.js';
import { schemaType } from '../dist/schema-types.js';
import { schemaRenderer } from '../dist/emit-schema.js';
import { identifier } from '../dist/code.js';

void test('unions sharing a long alias suffix keep validation traversal linear', () => {
  const aliases = 2_000;
  const unions = 400;
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  class CountedSchemas extends Map<string, Schema> {
    reads = 0;
    override get(name: string) {
      this.reads++;
      return super.get(name);
    }
  }
  const schemas = new CountedSchemas([
    ['Base', normalizeSchema({ type: 'string' }, 'Base')],
  ]);
  for (let index = 0; index < aliases; index++)
    schemas.set(
      `Alias${index}`,
      normalizeSchema(
        ref(index === 0 ? 'Base' : `Alias${index - 1}`),
        `Alias${index}`,
      ),
    );
  const root = normalizeSchema(
    {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: unions }, (_, index) => [
          `field${index}`,
          { anyOf: [ref(`Alias${aliases - 1}`), { type: 'boolean' }] },
        ]),
      ),
    },
    'root',
  );
  validateSchema(root, schemas, 'root');
  assert.ok(
    schemas.reads <= 30 * (aliases + unions),
    `shared aliases must not be revisited per union; observed ${schemas.reads} reads`,
  );
});

void test('constrained aliases of a wide enum receive a validation work diagnostic before output selection', async () => {
  const schemas: Record<string, unknown> = {
    Base: {
      type: 'integer',
      enum: Array.from({ length: 20_000 }, (_, index) => index),
    },
  };
  for (let index = 0; index < 51; index++)
    schemas[`Alias${index}`] = {
      $ref: '#/components/schemas/Base',
      minimum: 0,
    };
  const document = {
    openapi: '3.1.2',
    info: { title: 'Synthetic constrained enum validation', version: '1' },
    components: { schemas },
    paths: {},
  };
  const options = {
    clients: [],
    standalone: {
      value: { schema: '#/components/schemas/Alias0', usage: 'request' },
    },
  } as const;
  await assert.rejects(compile(document, options), (error) => {
    assert.ok(error instanceof ContractError);
    assert.match(error.location, /^components\.schemas\.Alias/);
    assert.match(error.message, /schema validation work exceeds.*1000000/);
    assert.match(error.message, /reduce.*constrained references.*wide enums/);
    return true;
  });
  await assert.doesNotReject(
    compile(
      {
        ...document,
        components: {
          schemas: Object.fromEntries(
            Object.entries(schemas).filter(([name]) =>
              ['Base', 'Alias0', 'Alias1'].includes(name),
            ),
          ),
        },
      },
      options,
    ),
  );
});

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
