import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { compile } from '../dist/index.js';
import { entry, record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const exec = promisify(execFile);
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

interface ScalarCase {
  name: string;
  schema: Schema;
  valid: unknown;
  invalid: unknown;
  message: string;
}

const cases: readonly ScalarCase[] = [
  {
    name: 'text',
    schema: { type: 'string', minLength: 1, maxLength: 4, pattern: '^[a-z]+$' },
    valid: 'a',
    invalid: '',
    message: 'string is too short',
  },
  {
    name: 'longerText',
    schema: { type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$' },
    valid: 'ab',
    invalid: 'a',
    message: 'string is too short',
  },
  {
    name: 'number',
    schema: { type: 'number', minimum: 0, maximum: 2 },
    valid: 0.5,
    invalid: -1,
    message: 'expected value >= 0',
  },
  {
    name: 'integer',
    schema: { type: 'integer', minimum: 0, maximum: 2 },
    valid: 0,
    invalid: 0.5,
    message: 'expected an integer',
  },
  {
    name: 'float',
    schema: { type: 'number', format: 'float' },
    valid: 1,
    invalid: 3.5e38,
    message: 'expected a finite float32 value',
  },
  {
    name: 'ordered',
    schema: { type: 'string', enum: ['red', 'blue'] },
    valid: 'red',
    invalid: 'other',
    message: 'expected one of "red", "blue"',
  },
  {
    name: 'reversed',
    schema: { type: 'string', enum: ['blue', 'red'] },
    valid: 'blue',
    invalid: 'other',
    message: 'expected one of "blue", "red"',
  },
  {
    name: 'negativeZero',
    schema: { type: 'number', enum: [-0, 2] },
    valid: -0,
    invalid: 1,
    message: 'expected one of 0, 2',
  },
  {
    name: 'zero',
    schema: { type: 'number', enum: [0, 2] },
    valid: -0,
    invalid: 1,
    message: 'expected one of 0, 2',
  },
  {
    name: 'boolean',
    schema: { type: 'boolean', enum: [false] },
    valid: false,
    invalid: true,
    message: 'expected false',
  },
  ...['first-code', 'second-code'].map((format) => ({
    name: format,
    schema: { type: 'string', format },
    valid: 'AB',
    invalid: 'a',
    message: `expected ${format} format`,
  })),
  ...[
    ['lower', 'Lowercase_Letter', 'a', 'A'],
    ['upper', 'Uppercase_Letter', 'A', 'a'],
  ].map(([name, property, valid, invalid]) => ({
    name: name!,
    schema: {
      type: 'string',
      enum: ['a', 'A'],
      pattern: `\\p{${property}}`,
    },
    valid,
    invalid,
    message: 'string does not match pattern',
  })),
];

function scalarFixture() {
  const properties = Object.fromEntries(
    cases.flatMap(({ name, schema }) => [
      [`first-${name}`, schema],
      [`second-${name}`, structuredClone(schema)],
    ]),
  );
  const fields = {
    type: 'object',
    properties: {
      ...properties,
      json: {},
      id: { type: 'string', readOnly: true },
      secret: { type: 'string', writeOnly: true },
    },
    required: [...Object.keys(properties), 'json', 'id', 'secret'],
  };
  const root = {
    type: 'object',
    properties: { left: ref('First'), right: ref('Second') },
    required: ['left', 'right'],
  };
  const content = { 'application/json': { schema: ref('Root') } };
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic scalar parser sharing', version: '1' },
    components: {
      schemas: { First: fields, Second: structuredClone(fields), Root: root },
    },
    paths: {
      '/value': {
        post: {
          operationId: 'value',
          requestBody: { required: true, content },
          responses: { 200: { description: 'Synthetic value', content } },
        },
      },
    },
  };
}

function payload(direction: 'request' | 'response') {
  const fields: Record<string, unknown> = Object.fromEntries(
    cases.flatMap(({ name, valid }) => [
      [`first-${name}`, valid],
      [`second-${name}`, valid],
    ]),
  );
  fields.json = Object.fromEntries([
    ['__proto__', { nested: [1, true] }],
    ['constructor', null],
  ]);
  fields[direction === 'request' ? 'secret' : 'id'] = direction;
  return { left: structuredClone(fields), right: structuredClone(fields) };
}

void test('shared scalar leaves preserve neighboring rules, literal order, formats, paths and directional behavior', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(scalarFixture(), {
      clients: ['consumer'],
      surfaces: { consumer: ['value'] },
      formats: {
        'first-code': { type: 'string', pattern: '[A-Z]{2}' },
        'second-code': { type: 'string', pattern: '[A-Z]{2}' },
      },
      standalone: {
        request: { schema: ref('Root').$ref, usage: 'request' },
        response: { schema: ref('Root').$ref, usage: 'response' },
      },
    }),
  );
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const operation = entry(client.operations, 'value');
  for (const direction of ['request', 'response'] as const) {
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      `standalone.${direction}.ts`,
    );
    const valid = payload(direction);
    const parsed = record(schema.parse(valid));
    assert.deepEqual(parsed, valid);
    const left = record(parsed.left);
    assert.ok(Object.is(left['first-negativeZero'], -0));
    assert.ok(Object.is(left['first-zero'], -0));
    assert.notEqual(left.json, valid.left.json);
    assert.deepEqual(
      schema.parse({
        ...valid,
        left: {
          ...valid.left,
          ...(direction === 'response' ? { secret: false } : {}),
        },
      }),
      valid,
    );
    if (direction === 'request')
      assert.equal(
        schema.safeParse({ ...valid, left: { ...valid.left, id: undefined } })
          .success,
        false,
      );
    for (const { name, invalid, message } of cases)
      for (const side of ['left', 'right'] as const)
        for (const copy of ['first', 'second']) {
          const field = `${copy}-${name}`;
          const input = {
            ...valid,
            [side]: { ...valid[side], [field]: invalid },
          };
          const result = schema.safeParse(input);
          assert.equal(result.success, false, `${direction}/${side}/${field}`);
          if (result.success) assert.fail('invalid scalar must fail');
          assert.deepEqual(result.error.issues[0], {
            path: [side, field],
            message,
          });
          if (direction === 'request') {
            assert.throws(
              () => operation.build({ body: input }),
              (error) => {
                assert.ok(error instanceof client.RequestValidationError);
                assert.deepEqual(error.issues[0], {
                  path: ['body', side, field],
                  message,
                });
                return true;
              },
            );
          } else {
            const response = operation.parseResponse({
              status: 200,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(input),
            });
            assert.equal(response.kind, 'protocol');
            if (response.kind !== 'protocol')
              assert.fail('invalid body must fail');
            assert.deepEqual(response.issues[0], {
              part: 'body',
              path: [side, field],
              message,
            });
          }
        }
  }
});

function sparseFixture(includeUnused: boolean) {
  const code = { type: 'string', minLength: 1, maxLength: 20 };
  const response = {
    description: 'Synthetic scalar',
    content: {
      'application/json': { schema: { type: 'string', enum: ['ok'] } },
    },
  };
  const selected = {
    operationId: 'zSelected',
    parameters: [{ in: 'query', name: 'code', schema: code }],
    responses: { 200: response },
  };
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic sparse scalar sharing', version: '1' },
    paths: {
      ...(includeUnused
        ? {
            '/a-unused': {
              get: {
                operationId: 'aUnused',
                parameters: [
                  { in: 'query', name: 'code', schema: structuredClone(code) },
                ],
                responses: {
                  200: response,
                  400: {
                    description: 'Unused error',
                    content: {
                      'application/json': {
                        schema: {
                          type: 'string',
                          const: 'UNSELECTED_SCALAR_MARKER',
                        },
                      },
                    },
                  },
                },
              },
            },
          }
        : {}),
      '/selected': { get: selected },
    },
  };
}

void test('repeated scalar rules reduce output across wide object chunks while distinct rules remain checked', async (t) => {
  const sources: string[] = [];
  for (const repeated of [true, false]) {
    const names = Array.from({ length: 180 }, (_, index) => `field${index}`);
    const files = await compile(
      {
        openapi: '3.1.2',
        info: { title: 'Synthetic repeated scalar output', version: '1' },
        paths: {},
        components: {
          schemas: {
            Root: {
              type: 'object',
              properties: Object.fromEntries(
                names.map((name, index) => [
                  name,
                  {
                    type: 'string',
                    minLength: 2,
                    maxLength: 10,
                    pattern: repeated ? '^[A-Z]+$' : `^[A-Z]+${index}$`,
                  },
                ]),
              ),
              required: names,
            },
          },
        },
      },
      {
        clients: [],
        standalone: { root: { schema: ref('Root').$ref, usage: 'response' } },
      },
    );
    sources.push(entry(files, 'standalone.root.ts'));
    const root = await generatedTestWorkspace(t, files);
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      'standalone.root.ts',
    );
    const valid = Object.fromEntries(
      names.map((name, index) => [name, repeated ? 'AA' : `AA${index}`]),
    );
    assert.deepEqual(schema.parse(valid), valid);
    const invalid = schema.safeParse({ ...valid, field179: 'bad' });
    assert.equal(invalid.success, false);
    if (invalid.success) assert.fail('a late field must retain its rule');
    assert.deepEqual(invalid.error.issues[0]?.path, ['field179']);
  }
  assert.ok(
    sources[0]!.length < sources[1]!.length * 0.7,
    'repeated rules must share output instead of reproducing every scalar parser',
  );
});

void test('a long first owner does not amplify shared scalar names in unrelated operations', async (t) => {
  const growth: number[] = [];
  for (const count of [2, 120]) {
    const sizes: number[] = [];
    for (const longOwner of [false, true]) {
      const owner = longOwner ? 'a'.repeat(1_024) : 'a';
      const ids = [
        owner,
        ...Array.from({ length: count - 1 }, (_, index) => `z${index}`),
      ];
      const files = await compile(
        {
          openapi: '3.1.2',
          info: { title: 'Synthetic long scalar owner', version: '1' },
          paths: Object.fromEntries(
            ids.map((id, index) => [
              index === 0 ? '/first' : `/${id}`,
              {
                get: {
                  operationId: id,
                  parameters: [
                    {
                      in: 'query',
                      name: 'code',
                      required: true,
                      schema: { type: 'string', minLength: 1, maxLength: 20 },
                    },
                  ],
                  responses: {
                    204: { description: 'Synthetic empty response' },
                  },
                },
              },
            ]),
          ),
        },
        { clients: ['consumer'], surfaces: { consumer: ids } },
      );
      sizes.push(
        Buffer.byteLength(entry(files, 'client.consumer.operations.ts')),
      );
      if (longOwner && count === 120) {
        const root = await generatedTestWorkspace(t, files);
        const client = await importGenerated<RuntimeClient>(
          root,
          'client.consumer.ts',
        );
        for (const id of [owner, ids.at(-1)!]) {
          const operation = entry(client.operations, id);
          assert.equal(
            operation.build({ query: { code: 'keep' } }).url,
            `${id === owner ? '/first' : `/${id}`}?code=keep`,
          );
          assert.throws(
            () => operation.build({ query: { code: '' } }),
            (error) => {
              assert.ok(error instanceof client.RequestValidationError);
              assert.equal(error.operationId, id);
              assert.deepEqual(error.issues[0]?.path, ['query', 'code']);
              return true;
            },
          );
        }
      }
    }
    growth.push(sizes[1]! - sizes[0]!);
  }
  assert.ok(
    Math.abs(growth[1]! - growth[0]!) < 512,
    'a long owner may enlarge its own declarations, not every shared reference',
  );
});

void test('pooled scalar functions retain sparse bundles and isolated declaration consumers after sources are removed', async (t) => {
  const sizes: number[] = [];
  for (const includeUnused of [false, true]) {
    const files = await compile(sparseFixture(includeUnused), {
      clients: ['consumer'],
      surfaces: {
        consumer: includeUnused ? ['aUnused', 'zSelected'] : ['zSelected'],
      },
    });
    const root = await generatedTestWorkspace(t, files);
    const source =
      "export {operation_zSelected as selected} from './client.consumer.operations.ts';\n";
    const input = join(root, 'entry.ts');
    const output = join(root, 'bundle.js');
    await writeFile(input, source);
    await build({
      entryPoints: [input],
      outfile: output,
      bundle: true,
      minify: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
    });
    const bundled = await readFile(output, 'utf8');
    sizes.push(Buffer.byteLength(bundled));
    assert.doesNotMatch(bundled, /UNSELECTED_SCALAR_MARKER|aUnused|a-unused/);
    const { selected } = await importGenerated<{
      selected: RuntimeClient['operations'][string];
    }>(root, 'bundle.js');
    assert.equal(
      selected.build({ query: { code: 'abc' } }).url,
      '/selected?code=abc',
    );
    assert.throws(() => selected.build({ query: { code: '' } }));
    assert.deepEqual(
      selected.parseResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: '"ok"',
      }).kind,
      'success',
    );
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          declaration: true,
          emitDeclarationOnly: true,
          isolatedDeclarations: true,
          rewriteRelativeImportExtensions: true,
          outDir: 'declarations',
          types: ['node'],
        },
        files: Object.keys(files).filter((name) => name.endsWith('.ts')),
      }),
    );
    const compiler = fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    );
    await exec(process.execPath, [compiler, '-p', join(root, 'tsconfig.json')]);
    for (const name of Object.keys(files)) await rm(join(root, name));
    await writeFile(
      join(root, 'published.ts'),
      `
import {operations} from './declarations/client.consumer.operations.js';
const result=operations.zSelected.parseResponse({status:200,headers:{},body:'"ok"'});
if(result.kind==='success') {
  const literal: 'ok' = result.data;
  // @ts-expect-error A pooled literal parser must not widen its return type.
  const wrong: 'other' = result.data;
  void literal; void wrong;
}
// @ts-expect-error Shared query parsers retain their string input.
operations.zSelected.build({query:{code:1}});
`,
    );
    await writeFile(
      join(root, 'published.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          noEmit: true,
          types: ['node'],
        },
        files: ['published.ts'],
      }),
    );
    await exec(process.execPath, [
      compiler,
      '-p',
      join(root, 'published.json'),
    ]);
  }
  assert.ok(
    Math.abs(sizes[0]! - sizes[1]!) < 256,
    'unselected operations must not enlarge a selected scalar parser bundle',
  );
});
