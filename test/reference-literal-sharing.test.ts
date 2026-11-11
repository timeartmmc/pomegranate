import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { compile, ContractError } from '../dist/index.js';
import { record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import { temporary } from './helpers.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { object, ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

const exec = promisify(execFile);
const selection = {
  clients: [],
  standalone: {
    request: { schema: ref('Root').$ref, usage: 'request' },
    response: { schema: ref('Root').$ref, usage: 'response' },
  },
} as const;

function document(schemas: Record<string, Schema>) {
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic shared enum references', version: '1' },
    paths: {},
    components: { schemas },
  };
}

function literalSchemas(): Record<string, Schema> {
  return {
    Text: { type: 'string', enum: ['', 'alpha', 'beta', 'gamma', '💠'] },
    TextPure: ref('Text'),
    TextNoop: { ...ref('TextPure'), minLength: 0 },
    TextNarrow: { ...ref('TextNoop'), pattern: '^a' },
    TextPureAfterNarrow: ref('TextNarrow'),
    TextOther: { ...ref('TextNoop'), pattern: '^b' },
    Number: { type: 'number', enum: [-2, -0, 0.5, 1, 2.5] },
    NumberPure: ref('Number'),
    NumberNoop: {
      ...ref('NumberPure'),
      minimum: -2,
      maximum: 3,
      multipleOf: 0.5,
    },
    NumberNarrow: { ...ref('NumberNoop'), minimum: 0.5, multipleOf: 1 },
    NumberPureAfterNarrow: ref('NumberNarrow'),
    NumberOther: { ...ref('NumberNoop'), maximum: 0 },
    Root: object({
      text: ref('TextPureAfterNarrow'),
      alternateText: ref('TextOther'),
      originalText: ref('TextPure'),
      unchangedText: ref('TextNoop'),
      number: ref('NumberPureAfterNarrow'),
      alternateNumber: ref('NumberOther'),
      originalNumber: ref('NumberPure'),
      unchangedNumber: ref('NumberNoop'),
    }),
  };
}

void test('wide enums retain ordinary reference sharing and diagnose excessive constrained scans', async (t) => {
  const root = await temporary(t);
  const probe = join(root, 'probe.mjs');
  await writeFile(
    probe,
    `import assert from 'node:assert/strict';
const { compile, ContractError } = await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
const reference = { $ref: '#/components/schemas/Values' };
const values = Array.from({ length: 50_000 }, (_, index) => index);
for (const mode of ['properties', 'aliases', 'constraints']) {
  const schemas = { Values: { type: 'integer', enum: values } };
  if (mode === 'properties') {
    schemas.Root = {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 800 }, (_, index) => ['field' + index, { ...reference }])),
    };
  } else {
    // Unused declarations are validated before selection too. Their references
    // must not retain separate copies of an identical wide literal set.
    for (let index = 0; index < 800; index++)
      schemas['Alias' + index] = mode === 'constraints' ? { ...reference, minimum: 0 } : { ...reference };
  }
  const document = {
    openapi: '3.1.2',
    info: { title: 'Synthetic bounded enum references', version: '1' },
    paths: {},
    components: { schemas },
  };
  const options = {
    clients: [],
    standalone: { root: { schema: '#/components/schemas/' + (mode === 'properties' ? 'Root' : 'Values'), usage: 'response' } },
  };
  if (mode === 'constraints') {
    await assert.rejects(compile(document, options), (error) => {
      assert.ok(error instanceof ContractError);
      assert.ok(error.location.startsWith('components.schemas.Alias'));
      assert.match(error.message, /schema validation work exceeds.*1000000/);
      assert.match(error.message, /reduce repeated constrained references to wide enums/);
      return true;
    });
    continue;
  }
  const files = await compile(document, options);
  assert.ok(Object.hasOwn(files, 'standalone.root.ts'));
  assert.ok(Object.values(files).reduce((size, source) => size + Buffer.byteLength(source), 0) < 4 * 1024 * 1024);
}
console.log('bounded enum references');
`,
  );
  // Ordinary references compile under a fixed heap; excessive constrained work
  // returns a diagnostic rather than exhausting that process's resources.
  const result = await exec(
    process.execPath,
    ['--max-old-space-size=256', probe],
    { timeout: 20_000 },
  );
  assert.equal(result.stdout, 'bounded enum references\n');
});

void test('pure and unchanged references preserve original and independently narrowed literal values', async (t) => {
  const input = document(literalSchemas());
  const before = structuredClone(input);
  const files = await compile(input, selection);
  assert.deepEqual(input, before);
  const root = await generatedTestWorkspace(t, files);
  const valid = {
    text: 'alpha',
    alternateText: 'beta',
    originalText: '💠',
    unchangedText: '',
    number: 1,
    alternateNumber: -2,
    originalNumber: -0,
    unchangedNumber: 2.5,
  };
  for (const direction of ['request', 'response']) {
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      `standalone.${direction}.ts`,
    );
    const parsed = schema.parse(valid);
    assert.deepEqual(parsed, valid);
    assert.ok(Object.is(record(parsed).originalNumber, -0));
    for (const [field, invalid] of [
      ['text', 'beta'],
      ['alternateText', 'alpha'],
      ['originalText', 'absent'],
      ['unchangedText', 'absent'],
      ['number', 0.5],
      ['number', 2],
      ['alternateNumber', 0.5],
      ['originalNumber', 2],
      ['unchangedNumber', 3],
    ] as const)
      assert.throws(() => schema.parse({ ...valid, [field]: invalid }), {
        name: 'ValidationError',
      });
  }
});

void test('pure reference tails retain earlier enum narrowing and reject empty intersections before selection', async () => {
  for (const [name, schema] of [
    ['ImpossibleText', { ...ref('TextPureAfterNarrow'), pattern: '^b' }],
    [
      'ImpossibleNumber',
      { ...ref('NumberPureAfterNarrow'), minimum: 1.5, maximum: 2.5 },
    ],
  ] as const) {
    const input = document({ ...literalSchemas(), [name]: schema });
    await assert.rejects(compile(input, selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, `components.schemas.${name}`);
      assert.match(
        error.message,
        /reference constraints admit no literal value/,
      );
      return true;
    });
  }
});
