import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { compile, ContractError } from '../dist/index.js';
import { temporary } from './helpers.ts';
import type { StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const letter = String.fromCodePoint(0x16ea0);
const positive = String.raw`^\p{L}$`;
const negative = String.raw`^\P{L}$`;
const propertyClass = String.raw`^[\p{L}]$`;
const oddSlash = String.raw`^\\\p{L}$`;
const escapedStable = String.raw`^[\\p{L}]+$`;

function document(schemas: Record<string, Schema>) {
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic pattern proofs', version: '1' },
    'x-pom-policy': {
      version: 3,
      auth: { public: { transport: 'none' } },
      fields: {
        retry: { type: 'string', enum: ['never'] },
        timeout: { type: 'string', enum: ['interactive'] },
      },
      required: ['auth', 'retry', 'timeout'],
      surfaces: ['patterns'],
    },
    paths: {},
    components: { schemas },
  };
}

void test('Unicode-property proofs and reference candidates are independent of compiler matching', async (t) => {
  const schemas: Record<string, Schema> = {
    InlineConst: { type: 'string', const: letter, pattern: positive },
    InlineEnum: { type: 'string', enum: ['A', letter], pattern: positive },
    InlineNegated: { type: 'string', const: letter, pattern: negative },
    ClassProperty: { type: 'string', const: letter, pattern: propertyClass },
    OddSlash: { type: 'string', const: `\\${letter}`, pattern: oddSlash },
    EscapedStable: {
      type: 'string',
      const: String.raw`\p{L}`,
      pattern: escapedStable,
    },
    Base: { type: 'string', const: letter },
    Reference: { $ref: '#/components/schemas/Base', pattern: positive },
    ReferenceNegated: { $ref: '#/components/schemas/Base', pattern: negative },
    CacheBase: { type: 'string', enum: ['A', letter] },
    CacheMiddle: { $ref: '#/components/schemas/CacheBase', pattern: positive },
    CacheOuter: {
      $ref: '#/components/schemas/CacheMiddle',
      pattern: `^${letter}$`,
    },
  };
  const roots = [
    'InlineConst',
    'InlineEnum',
    'InlineNegated',
    'ClassProperty',
    'OddSlash',
    'EscapedStable',
    'Reference',
    'ReferenceNegated',
    'CacheOuter',
  ];
  const options = {
    clients: [],
    standalone: Object.fromEntries(
      roots.flatMap((name) =>
        (['request', 'response'] as const).map((usage) => [
          `${name.toLowerCase()}-${usage}`,
          { schema: `#/components/schemas/${name}`, usage },
        ]),
      ),
    ),
  };
  const propertyPatterns = new Set([
    positive,
    negative,
    propertyClass,
    oddSlash,
  ]);
  // oxlint-disable-next-line typescript/unbound-method -- Preserve each original RegExp receiver when simulating compiler Unicode versions.
  const original = RegExp.prototype.test;
  let propertyEvaluations = 0;
  let stableEvaluations = 0;
  let files: Readonly<Record<string, string>> | undefined;
  for (const classification of [false, true]) {
    const mock = t.mock.method(
      RegExp.prototype,
      'test',
      function (this: RegExp, input: string) {
        if (propertyPatterns.has(this.source)) {
          propertyEvaluations++;
          return classification;
        }
        if (this.source === escapedStable) stableEvaluations++;
        return original.call(this, input);
      },
    );
    try {
      const current = await compile(document(schemas), options);
      if (files) assert.deepEqual(current, files);
      else files = current;
    } finally {
      mock.mock.restore();
    }
  }
  assert.equal(propertyEvaluations, 0);
  assert.ok(stableEvaluations > 0);
  assert.ok(files);
  const root = await temporary(t);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries(files))
    await writeFile(join(root, name), source);
  let stableRuntimeEvaluations = 0;
  let referenceEvaluations = 0;
  for (const classification of [false, true]) {
    // Simulate a consumer Unicode version that does or does not classify this
    // newer character as a letter. Stable ASCII rules keep their real semantics.
    const mock = t.mock.method(
      RegExp.prototype,
      'test',
      function (this: RegExp, input: string) {
        if (this.source === escapedStable) stableRuntimeEvaluations++;
        if (this.source === `^${letter}$`) referenceEvaluations++;
        if (
          propertyPatterns.has(this.source) &&
          (input === letter || input === `\\${letter}`)
        )
          return this.source === negative ? !classification : classification;
        return original.call(this, input);
      },
    );
    try {
      for (const name of roots) {
        const negated = name === 'InlineNegated' || name === 'ReferenceNegated';
        const stable = name === 'EscapedStable';
        const input = stable
          ? String.raw`\p{L}`
          : name === 'OddSlash'
            ? `\\${letter}`
            : letter;
        const expected = stable || (negated ? !classification : classification);
        for (const usage of ['request', 'response']) {
          const { schema } = (await import(
            pathToFileURL(
              join(root, `standalone.${name.toLowerCase()}-${usage}.ts`),
            ).href
          )) as StandaloneModule;
          assert.equal(
            schema.safeParse(input).success,
            expected,
            `${name}/${usage}/${classification}`,
          );
        }
      }
    } finally {
      mock.mock.restore();
    }
  }
  assert.equal(stableRuntimeEvaluations, 0);
  assert.equal(referenceEvaluations, 4);
});

for (const [name, schema, reason] of [
  [
    'escaped property lookalike',
    { type: 'string', const: 'A', pattern: escapedStable },
    /literal violates declared pattern/,
  ],
  [
    'escaped Unicode backslash',
    { type: 'string', const: 'A', pattern: String.raw`^\u005cp\{L\}$` },
    /literal violates declared pattern/,
  ],
  [
    'stable pattern',
    { type: 'string', const: letter, pattern: '^A$' },
    /literal violates declared pattern/,
  ],
  [
    'Unicode code-point length',
    { type: 'string', const: letter, pattern: positive, minLength: 2 },
    /literal violates declared bounds/,
  ],
  [
    'format',
    { type: 'string', const: letter, pattern: positive, format: 'uuid' },
    /literal violates declared uuid format/,
  ],
  [
    'multipleOf',
    { type: 'integer', const: 3, multipleOf: 2 },
    /literal violates declared multipleOf/,
  ],
] satisfies [string, Schema, RegExp][]) {
  void test(`deferring property matching preserves the ${name} proof`, async () => {
    await assert.rejects(
      compile(document({ Invalid: schema }), {
        clients: [],
        standalone: {
          root: { schema: '#/components/schemas/Invalid', usage: 'request' },
        },
      }),
      (error) => error instanceof ContractError && reason.test(error.message),
    );
  });
}

void test('stable reference constraints still prove an empty literal intersection', async () => {
  const schemas = {
    Base: { type: 'string', enum: ['A', letter] },
    Property: { $ref: '#/components/schemas/Base', pattern: positive },
    Stable: { $ref: '#/components/schemas/Property', pattern: '^A$' },
    Empty: { $ref: '#/components/schemas/Stable', pattern: '^B$' },
  };
  await assert.rejects(
    compile(document(schemas), {
      clients: [],
      standalone: {
        root: { schema: '#/components/schemas/Empty', usage: 'request' },
      },
    }),
    /reference constraints admit no literal value/,
  );
});
