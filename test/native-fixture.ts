import { queryFixture } from './query-fixture.ts';
import { object, ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

// Synthetic host-value controls also supply real signatures to test:prepare.
export function nativeFixture() {
  const document = queryFixture();
  const schemas: Record<string, Schema> = {
    LargeLiteral: {
      type: 'string',
      enum: Array.from({ length: 2048 }, (_, i) => `v${i}`),
      minLength: 1,
      maxLength: 32,
      pattern: '^v[0-9]+$',
    },
    LargeLiteralAlias: { ...ref('LargeLiteral'), minLength: 3 },
    NullableArrayMax: {
      type: ['array', 'null'],
      items: { type: 'string' },
      maxItems: 1,
    },
    NullableArrayMin: {
      type: ['array', 'null'],
      items: { type: 'string' },
      minItems: 2,
    },
    NullableMap: {
      type: ['object', 'null'],
      additionalProperties: { type: 'string', minLength: 2 },
    },
    TaggedText: object({
      kind: { type: 'string', const: 'text' },
      value: { type: 'string', minLength: 2 },
    }),
    TaggedCount: object({
      kind: { type: 'string', const: 'count' },
      value: { type: 'integer', minimum: 1 },
    }),
    Tagged: {
      oneOf: [ref('TaggedText'), ref('TaggedCount')],
      discriminator: {
        propertyName: 'kind',
        mapping: {
          text: '#/components/schemas/TaggedText',
          count: '#/components/schemas/TaggedCount',
        },
      },
    },
    NullableTagged: { anyOf: [ref('Tagged'), { type: 'null' }] },
    ArrayMax: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    ArrayMin: {
      type: 'array',
      items: { type: 'string' },
      minItems: 2,
      maxItems: 3,
    },
    ArrayMaxAlias: { ...ref('ArrayMax'), maxItems: 1 },
    ArrayMaxAlias2: ref('ArrayMaxAlias'),
    ArrayMinAlias: { ...ref('ArrayMin'), minItems: 3 },
    AnyMap: { type: 'object', additionalProperties: true },
    Wide256: object(
      Object.fromEntries(
        Array.from({ length: 256 }, (_, i) => [
          `field${i}`,
          { type: 'string' },
        ]),
      ),
    ),
    Wide1024: object(
      Object.fromEntries(
        Array.from({ length: 1024 }, (_, i) => [
          `field${i}`,
          { type: 'string' },
        ]),
      ),
    ),
  };
  let previous = 'ArrayMaxAlias2';
  for (let index = 0; index < 1000; index++) {
    const name = `Alias${index}`;
    schemas[name] = ref(previous);
    previous = name;
  }
  const base = document.paths['/map'].get;
  const selected = [
    'LargeLiteral',
    'LargeLiteralAlias',
    'NullableArrayMax',
    'NullableArrayMin',
    'NullableMap',
    'NullableTagged',
    'ArrayMax',
    'ArrayMin',
    'ArrayMaxAlias',
    'ArrayMaxAlias2',
    'ArrayMinAlias',
    'AnyMap',
    'Wide256',
    'Wide1024',
    previous,
  ];
  Object.assign(document.components, { schemas });
  Object.assign(document, {
    paths: Object.fromEntries(
      selected.map((name) => [
        `/native/${name}`,
        {
          post: {
            ...base,
            operationId: `check${name}`,
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref(name) } },
            },
            responses: {
              200: {
                description: 'Synthetic native result',
                content: { 'application/json': { schema: ref(name) } },
              },
            },
          },
        },
      ]),
    ),
  });
  return document;
}
