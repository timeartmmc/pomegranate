import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { compile, audit } from '../dist/index.js';
import type { CompileWarning } from '../dist/index.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

function document(schema: Schema, definitions: Record<string, Schema> = {}) {
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic proven oneOf overlap warnings', version: '1' },
    paths: {},
    components: { schemas: { ...definitions, Value: schema } },
  };
}
const selection = {
  clients: [],
  standalone: {
    request: { schema: '#/components/schemas/Value', usage: 'request' },
    response: { schema: '#/components/schemas/Value', usage: 'response' },
  },
} as const;
const fixed = (full: boolean, closed = false): Schema => ({
  type: 'object',
  properties: {
    a: { type: 'string' },
    ...(full ? { b: { type: 'integer' } } : {}),
  },
  required: full ? ['a', 'b'] : ['a'],
  ...(closed ? { additionalProperties: false } : {}),
});

void test('proven overlap warns in compile and audit while intentional oneOf remains executable', async (t) => {
  const source = document({
    oneOf: [
      { type: 'number', minimum: 0 },
      { type: 'number', maximum: 0 },
    ],
  });
  const warnings: CompileWarning[] = [];
  const files = await compile(source, {
    ...selection,
    onWarning: (warning) => {
      warnings.push(warning);
    },
  });
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((warning) => warning.code === 'oneof-overlap'));
  assert.match(
    warnings[0]!.message,
    /for example 0 matches multiple alternatives/,
  );
  assert.match(warnings[0]!.message, /request/);
  assert.match(warnings[1]!.message, /response/);
  const report = await audit(source, selection);
  assert.equal(report.complete, true);
  assert.equal(report.clean, true);
  assert.deepEqual(report.warnings, warnings);
  const root = await generatedTestWorkspace(t, files);
  for (const usage of ['request', 'response']) {
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      `standalone.${usage}.ts`,
    );
    assert.equal(schema.parse(-1), -1);
    assert.equal(schema.parse(1), 1);
    assert.equal(schema.safeParse(0).success, false);
  }
});

void test('overlap witnesses satisfy both source alternatives under an independent oracle', async () => {
  const pairs: [Schema, Schema][] = [
    [fixed(false), fixed(true)],
    [
      { type: 'string', enum: ['a', 'shared'] },
      { type: 'string', enum: ['shared', 'b'] },
    ],
    [
      { type: 'array', items: { type: 'integer' } },
      { type: 'array', items: { type: 'string' } },
    ],
    [
      {
        type: 'object',
        additionalProperties: { type: 'integer' },
        required: ['id'],
      },
      { type: 'object', additionalProperties: { type: 'number' } },
    ],
    [{}, { type: 'boolean' }],
  ];
  const oracle = new Ajv2020({ strict: false });
  for (let lower = -2; lower <= 2; lower++)
    for (let upper = -2; upper <= 2; upper++)
      pairs.push([
        { type: 'number', minimum: lower },
        { type: 'integer', maximum: upper },
      ]);
  for (const [a, b] of pairs) {
    const warnings: CompileWarning[] = [];
    await compile(document({ oneOf: [a, b] }), {
      ...selection,
      onWarning: (warning) => {
        warnings.push(warning);
      },
    });
    const acceptsA = oracle.compile(a),
      acceptsB = oracle.compile(b);
    for (const warning of warnings) {
      assert.equal(warning.code, 'oneof-overlap');
      const match = /for example (.+) matches multiple alternatives/.exec(
        warning.message,
      );
      assert.ok(match);
      const witness: unknown = JSON.parse(match[1]!);
      assert.equal(acceptsA(witness), true, warning.message);
      assert.equal(acceptsB(witness), true, warning.message);
    }
  }
});

void test('same JSON types, closed branch differences and unknown proofs do not produce overlap claims', async () => {
  for (const [a, b] of [
    [fixed(false, true), fixed(true, true)],
    [
      { type: 'string', enum: ['a'] },
      { type: 'string', enum: ['b'] },
    ],
    [
      { type: 'string', pattern: '^a' },
      { type: 'string', pattern: '^b' },
    ],
    [
      { type: 'string', pattern: '^(a+)+$' },
      { type: 'string', enum: [`${'a'.repeat(100)}x`] },
    ],
    [
      { type: 'object', minProperties: 2 },
      { type: 'object', maxProperties: 1 },
    ],
    [
      {
        type: 'object',
        additionalProperties: { type: 'integer' },
        minProperties: 2,
      },
      { type: 'object', additionalProperties: true, maxProperties: 1 },
    ],
  ] satisfies [Schema, Schema][]) {
    const warnings: CompileWarning[] = [];
    await compile(document({ oneOf: [a, b] }), {
      ...selection,
      onWarning: (warning) => {
        warnings.push(warning);
      },
    });
    assert.deepEqual(warnings, []);
  }
});

void test('overlap warnings use directional source membership and cover inline HTTP schemas', async () => {
  const source = document({ type: 'string' });
  const choice: Schema = {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: { type: 'string' },
          secret: { type: 'string', writeOnly: true },
        },
        required: ['value', 'secret'],
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          value: { type: 'string' },
        },
        required: ['value'],
      },
    ],
  };
  const content = { 'application/json': { schema: choice } };
  Object.assign(source.paths, {
    '/value': {
      post: {
        operationId: 'save',
        requestBody: { required: true, content },
        responses: { 200: { description: 'Value', content } },
      },
    },
  });
  const settings = { clients: ['consumer'], surfaces: { consumer: ['save'] } };
  const warnings: CompileWarning[] = [];
  await compile(source, {
    ...settings,
    onWarning: (warning) => {
      warnings.push(warning);
    },
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.code, 'oneof-overlap');
  assert.match(warnings[0]!.path, /responses/);
  assert.match(warnings[0]!.message, /response values/);
  assert.deepEqual((await audit(source, settings)).warnings, warnings);
});
