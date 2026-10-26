const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

// Explicit equivalent schemas are used for byte parity; the oracle evaluates
// the original type arrays directly, without going through this conversion.
export const nullableTypeCases = [
  {
    name: 'TypeArrayString',
    schema: {
      type: ['string', 'null'],
      minLength: 2,
      maxLength: 3,
      pattern: '^[A-Z]+$',
    },
    equivalent: nullable({
      type: 'string',
      minLength: 2,
      maxLength: 3,
      pattern: '^[A-Z]+$',
    }),
    samples: [
      [null, true],
      ['AB', true],
      ['ABC', true],
      ['A', false],
      ['abcd', false],
      [1, false],
    ],
  },
  {
    name: 'TypeArrayNumber',
    schema: {
      type: ['null', 'number'],
      exclusiveMinimum: 0,
      maximum: 1,
      multipleOf: 0.25,
    },
    equivalent: nullable({
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 1,
      multipleOf: 0.25,
    }),
    samples: [
      [null, true],
      [0.25, true],
      [1, true],
      [0, false],
      [0.3, false],
      ['1', false],
    ],
  },
  {
    name: 'TypeArrayInteger',
    schema: { type: ['integer', 'null'], minimum: 0, maximum: 2 },
    equivalent: nullable({ type: 'integer', minimum: 0, maximum: 2 }),
    samples: [
      [null, true],
      [0, true],
      [2, true],
      [1.5, false],
      [-1, false],
      [3, false],
    ],
  },
  {
    name: 'TypeArrayBoolean',
    schema: { type: ['boolean', 'null'] },
    equivalent: nullable({ type: 'boolean' }),
    samples: [
      [null, true],
      [true, true],
      [false, true],
      [0, false],
      ['false', false],
    ],
  },
  {
    name: 'TypeArrayEnum',
    schema: {
      type: ['string', 'null'],
      enum: [null, 'ready', 'done'],
      minLength: 1,
    },
    equivalent: nullable({
      type: 'string',
      enum: ['ready', 'done'],
      minLength: 1,
    }),
    samples: [
      [null, true],
      ['ready', true],
      ['done', true],
      ['other', false],
      ['', false],
    ],
  },
  {
    name: 'TypeArrayNumberEnum',
    schema: {
      type: ['number', 'null'],
      enum: [0.5, null, 1],
      multipleOf: 0.25,
    },
    equivalent: nullable({ type: 'number', enum: [0.5, 1], multipleOf: 0.25 }),
    samples: [
      [null, true],
      [0.5, true],
      [1, true],
      [0.25, false],
      ['1', false],
    ],
  },
  {
    name: 'TypeArrayNonNullEnum',
    schema: { type: ['null', 'string'], enum: ['ready'] },
    equivalent: { type: 'string', enum: ['ready'] },
    samples: [
      [null, false],
      ['ready', true],
      ['done', false],
      [false, false],
    ],
  },
  {
    name: 'TypeArrayOnlyNull',
    schema: {
      type: ['string', 'null'],
      enum: [null],
      minLength: 1,
      pattern: '^[A-Z]+$',
    },
    equivalent: { type: 'null' },
    samples: [
      [null, true],
      ['A', false],
      ['', false],
      [false, false],
    ],
  },
  {
    name: 'TypeArrayEmptyIntegerBranch',
    schema: {
      type: ['integer', 'null'],
      enum: [null],
      minimum: 0.5,
      maximum: 0.9,
    },
    equivalent: { type: 'null' },
    samples: [
      [null, true],
      [0.5, false],
      [1, false],
      [false, false],
    ],
  },
  {
    name: 'TypeArrayEmptyNumberBranch',
    schema: {
      type: ['null', 'number'],
      const: null,
      exclusiveMinimum: Number.MAX_VALUE,
    },
    equivalent: { type: 'null' },
    samples: [
      [null, true],
      [Number.MAX_VALUE, false],
      [0, false],
      ['null', false],
    ],
  },
  {
    name: 'TypeArrayConst',
    schema: { type: ['boolean', 'null'], const: false },
    equivalent: { type: 'boolean', const: false },
    samples: [
      [null, false],
      [false, true],
      [true, false],
      [0, false],
    ],
  },
  {
    name: 'TypeArrayNullConst',
    schema: { type: ['null', 'number'], const: null, minimum: 0 },
    equivalent: { type: 'null' },
    samples: [
      [null, true],
      [0, false],
      [-1, false],
      ['null', false],
    ],
  },
  {
    name: 'TypeArrayArray',
    schema: {
      type: ['array', 'null'],
      items: { type: ['integer', 'null'], minimum: 0 },
      minItems: 1,
      maxItems: 2,
    },
    equivalent: nullable({
      type: 'array',
      items: nullable({ type: 'integer', minimum: 0 }),
      minItems: 1,
      maxItems: 2,
    }),
    samples: [
      [null, true],
      [[null], true],
      [[0, null], true],
      [[], false],
      [[-1], false],
      [[0, 1, 2], false],
      [['0'], false],
    ],
  },
  {
    name: 'TypeArrayObject',
    schema: {
      type: ['null', 'object'],
      properties: {
        label: { type: ['string', 'null'], minLength: 1 },
        enabled: { type: 'boolean' },
      },
      required: ['label'],
      additionalProperties: false,
    },
    equivalent: nullable({
      type: 'object',
      properties: {
        label: nullable({ type: 'string', minLength: 1 }),
        enabled: { type: 'boolean' },
      },
      required: ['label'],
      additionalProperties: false,
    }),
    samples: [
      [null, true],
      [{ label: null }, true],
      [{ label: 'x', enabled: false }, true],
      [{}, false],
      [{ label: '' }, false],
      [{ label: 'x', enabled: 1 }, false],
      [[], false],
    ],
  },
  {
    name: 'TypeArrayMap',
    schema: {
      type: ['object', 'null'],
      additionalProperties: { type: ['number', 'null'], minimum: 0 },
    },
    equivalent: nullable({
      type: 'object',
      additionalProperties: nullable({ type: 'number', minimum: 0 }),
    }),
    samples: [
      [null, true],
      [{}, true],
      [{ key: null }, true],
      [{ key: 1 }, true],
      [{ key: -1 }, false],
      [[], false],
    ],
  },
  {
    name: 'TypeArrayJsonMap',
    schema: { type: ['object', 'null'], additionalProperties: true },
    equivalent: nullable({ type: 'object', additionalProperties: true }),
    samples: [
      [null, true],
      [{ any: [1, null, {}] }, true],
      [[], false],
      [false, false],
    ],
  },
  {
    name: 'TypeArrayReferences',
    schema: {
      type: 'object',
      properties: {
        required: ref('TypeArrayEnum'),
        optional: ref('TypeArrayInteger'),
      },
      required: ['required'],
      additionalProperties: false,
    },
    equivalent: {
      type: 'object',
      properties: {
        required: ref('TypeArrayEnum'),
        optional: ref('TypeArrayInteger'),
      },
      required: ['required'],
      additionalProperties: false,
    },
    samples: [
      [{ required: null }, true],
      [{ required: 'ready', optional: null }, true],
      [{ required: 'done', optional: 1 }, true],
      [{}, false],
      [{ required: 'other' }, false],
      [{ required: null, optional: -1 }, false],
    ],
  },
];

export const nullableTypeSchemas = Object.fromEntries(
  nullableTypeCases.map(({ name, schema }) => [name, schema]),
);
