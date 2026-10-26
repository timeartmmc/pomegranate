import { ref } from './schema-helpers.ts';
import type { Schema, SchemaCase } from './schema-helpers.ts';

const object = (
  properties: Record<string, Schema>,
  required = Object.keys(properties),
) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const compositionSchemas = {
  ComposedBaseCode: {
    type: 'string',
    minLength: 2,
    pattern: '^[A-Z]+$',
    enum: ['AB', 'CD', 'EFG'],
  },
  ComposedCodeAlias: ref('ComposedBaseCode'),
  ComposedCode: { ...ref('ComposedCodeAlias'), maxLength: 2 },
  ComposedBaseCount: { type: 'integer', minimum: 0, maximum: 4 },
  ComposedCount: {
    ...ref('ComposedBaseCount'),
    exclusiveMinimum: 0,
    exclusiveMaximum: 4,
  },
  ComposedText: object({
    kind: { type: 'string', const: 'text' },
    value: ref('ComposedCode'),
  }),
  ComposedNumber: object({
    kind: { type: 'string', const: 'count' },
    value: ref('ComposedCount'),
  }),
  ComposedChoice: {
    oneOf: [ref('ComposedText'), ref('ComposedNumber')],
    discriminator: {
      propertyName: 'kind',
      mapping: {
        text: '#/components/schemas/ComposedText',
        count: '#/components/schemas/ComposedNumber',
      },
    },
  },
  ComposedChoiceAlias: ref('ComposedChoice'),
  ComposedBaseCodes: {
    type: 'array',
    minItems: 1,
    maxItems: 4,
    items: ref('ComposedCode'),
  },
  ComposedCodes: { ...ref('ComposedBaseCodes'), maxItems: 2 },
};

const atoms: SchemaCase[] = [
  {
    name: 'Code',
    schema: ref('ComposedCode'),
    samples: [
      ['AB', true],
      ['CD', true],
      ['EFG', false],
      ['A', false],
      ['ab', false],
      [1, false],
      [null, false],
    ],
  },
  {
    name: 'Count',
    schema: ref('ComposedCount'),
    samples: [
      [1, true],
      [3, true],
      [0, false],
      [4, false],
      [1.5, false],
      ['1', false],
      [null, false],
    ],
  },
  {
    name: 'Choice',
    schema: ref('ComposedChoiceAlias'),
    samples: [
      [{ kind: 'text', value: 'AB' }, true],
      [{ kind: 'count', value: 1 }, true],
      [{ kind: 'text', value: 'EFG' }, false],
      [{ kind: 'count', value: 0 }, false],
      [{ kind: 'other', value: 1 }, false],
      [{ kind: 'text' }, false],
      [null, false],
    ],
  },
  {
    name: 'Codes',
    schema: ref('ComposedCodes'),
    samples: [
      [['AB'], true],
      [['AB', 'CD'], true],
      [[], false],
      [['AB', 'CD', 'AB'], false],
      [['EFG'], false],
      [['AB', 1], false],
      [null, false],
    ],
  },
];

const containers: {
  name: string;
  schema: (item: Schema) => Schema;
  samples: (samples: [unknown, boolean][]) => [unknown, boolean][];
}[] = [
  {
    name: 'Nullable',
    schema: (item) => ({ anyOf: [item, { type: 'null' }] }),
    samples: (samples) => [
      ...samples.filter(([value]) => value !== null),
      [null, true],
    ],
  },
  {
    name: 'Optional',
    schema: (item) => object({ value: item }, []),
    samples: (samples) => [
      ...samples.map(([value, valid]): [unknown, boolean] => [
        { value },
        valid,
      ]),
      [{}, true],
      [42, false],
    ],
  },
  {
    name: 'Array',
    schema: (item) => ({
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: item,
    }),
    samples: (samples) => [
      ...samples.map(([value, valid]): [unknown, boolean] => [[value], valid]),
      [[], false],
      [[samples[0]![0], samples[0]![0]], true],
      [[samples[0]![0], samples[0]![0], samples[0]![0]], false],
    ],
  },
  {
    name: 'Map',
    schema: (item) => ({ type: 'object', additionalProperties: item }),
    samples: (samples) => [
      ...samples.map(([value, valid]): [unknown, boolean] => [
        { entry: value },
        valid,
      ]),
      [{}, true],
      [Object.fromEntries([['__proto__', samples[0]![0]]]), true],
      [42, false],
    ],
  },
];

// Cross the same independent positive/negative examples with every container.
// This catches a constraint lost through an alias or wrapper without deriving
// expected results from POM's normalized model or generated validator.
export const compositionCases: SchemaCase[] = [
  ...atoms.flatMap((atom) =>
    containers.map((container) => ({
      name: container.name + atom.name,
      schema: container.schema(atom.schema),
      samples: container.samples(atom.samples),
    })),
  ),
  {
    name: 'NestedChoiceGroups',
    schema: object({
      groups: {
        type: 'object',
        additionalProperties: {
          type: 'array',
          minItems: 1,
          maxItems: 2,
          items: { anyOf: [ref('ComposedChoiceAlias'), { type: 'null' }] },
        },
      },
    }),
    samples: [
      [{ groups: { first: [{ kind: 'text', value: 'AB' }, null] } }, true],
      [{ groups: {} }, true],
      [{}, false],
      [{ groups: { first: [] } }, false],
      [{ groups: { first: [{ kind: 'count', value: 4 }] } }, false],
      [{ groups: { first: [{ kind: 'text', value: 'EFG' }] } }, false],
      [{ groups: { first: [{ kind: 'text' }] } }, false],
    ],
  },
];
