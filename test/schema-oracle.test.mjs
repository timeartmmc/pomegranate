import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { compile } from '../dist/index.js';
import {
  compositionCases,
  compositionSchemas,
} from './schema-composition-fixture.mjs';
import { nullableTypeCases } from './nullable-type-fixture.mjs';

const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cases = [
  ...nullableTypeCases,
  {
    name: 'NullableInteger',
    schema: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
    samples: [
      [null, true],
      [1, true],
      [0, false],
      [1.5, false],
      ['1', false],
    ],
  },
  {
    name: 'StringIntegerUnion',
    schema: {
      anyOf: [
        { type: 'string', minLength: 1 },
        { type: 'integer', minimum: 0 },
      ],
    },
    samples: [
      ['field', true],
      [0, true],
      ['', false],
      [-1, false],
      [1.5, false],
      [null, false],
    ],
  },
  {
    name: 'DynamicMap',
    schema: {
      type: 'object',
      additionalProperties: { type: 'integer', minimum: 1 },
    },
    samples: [
      [{}, true],
      [{ x: 1 }, true],
      [{ x: 0 }, false],
      [JSON.parse('{"__proto__":1}'), true],
      [JSON.parse('{"__proto__":0}'), false],
    ],
  },
  {
    name: 'UnicodePattern',
    schema: { type: 'string', pattern: '^.$' },
    samples: [
      ['😀', true],
      ['a', true],
      ['aa', false],
      ['a\n', false],
    ],
  },
  {
    name: 'SearchPattern',
    schema: { type: 'string', pattern: '[A-Z]{2}' },
    samples: [
      ['prefixABsuffix', true],
      ['ab', false],
    ],
  },
  {
    name: 'ExclusiveMultiples',
    schema: {
      type: 'number',
      exclusiveMinimum: -1,
      exclusiveMaximum: 1,
      multipleOf: 0.25,
    },
    samples: [
      [-1, false],
      [-0.75, true],
      [0, true],
      [0.75, true],
      [1, false],
      [0.3, false],
    ],
  },
  {
    name: 'UnicodeLength',
    schema: { type: 'string', minLength: 1, maxLength: 2 },
    samples: [
      ['', false],
      ['a', true],
      ['😀', true],
      ['😀😀', true],
      ['e\u0301', true],
      ['😀😀😀', false],
      [1, false],
    ],
  },
  {
    name: 'StringLiteral',
    schema: { type: 'string', const: '😀', maxLength: 1 },
    samples: [
      ['😀', true],
      ['a', false],
      ['', false],
    ],
  },
  {
    name: 'StringEnum',
    schema: { type: 'string', enum: ['ready', 'done'] },
    samples: [
      ['ready', true],
      ['done', true],
      ['pending', false],
      [null, false],
    ],
  },
  {
    name: 'FiniteNumber',
    schema: { type: 'number' },
    samples: [
      [0, true],
      [-1.25, true],
      [Number.MAX_VALUE, true],
      [NaN, false],
      [Infinity, false],
      [-Infinity, false],
      ['1', false],
    ],
  },
  {
    name: 'NumberBounds',
    schema: { type: 'number', minimum: -1.5, maximum: 2.25 },
    samples: [
      [-1.5, true],
      [2.25, true],
      [-1.5001, false],
      [2.2501, false],
    ],
  },
  {
    name: 'Integer',
    schema: { type: 'integer' },
    samples: [
      [0, true],
      [-1, true],
      [1.5, false],
      [Number.MAX_SAFE_INTEGER, true],
      [Number.MAX_SAFE_INTEGER + 1, true],
      [1e20, true],
      [-1e20, true],
      [Infinity, false],
      [NaN, false],
    ],
  },
  {
    name: 'IntegerBounds',
    schema: { type: 'integer', minimum: -2, maximum: 2 },
    samples: [
      [-2, true],
      [2, true],
      [-3, false],
      [3, false],
      [0.5, false],
    ],
  },
  {
    name: 'IntegerLiteral',
    schema: { type: 'integer', const: 1e20 },
    samples: [
      [1e20, true],
      [0, false],
      [1.5, false],
    ],
  },
  {
    name: 'IntegerEnum',
    schema: { type: 'integer', enum: [-1e20, Number.MAX_SAFE_INTEGER + 1] },
    samples: [
      [-1e20, true],
      [Number.MAX_SAFE_INTEGER + 1, true],
      [1e20, false],
      [1.5, false],
    ],
  },
  {
    name: 'BooleanLiteral',
    schema: { type: 'boolean', const: false },
    samples: [
      [false, true],
      [true, false],
      [0, false],
      ['false', false],
    ],
  },
  {
    name: 'Null',
    schema: { type: 'null' },
    samples: [
      [null, true],
      [false, false],
      ['', false],
      [0, false],
    ],
  },
  {
    name: 'ArrayBounds',
    schema: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: { type: 'integer' },
    },
    samples: [
      [[], false],
      [[1], true],
      [[1, 2], true],
      [[1, 2, 3], false],
      [[1.5], false],
      [[1e20], true],
    ],
  },
  {
    name: 'NestedObject',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['entry'],
      properties: {
        entry: {
          type: 'object',
          additionalProperties: false,
          required: ['enabled'],
          properties: { enabled: { type: 'boolean' } },
        },
      },
    },
    // Object samples omit unknown keys: request rejection and response stripping
    // are intentionally different POM policies, verified in generated.test.mjs.
    samples: [
      [{ entry: { enabled: true } }, true],
      [{ entry: { enabled: false } }, true],
      [{}, false],
      [{ entry: {} }, false],
      [{ entry: { enabled: 0 } }, false],
    ],
  },
  ...compositionCases,
];

const schemas = {
  ...compositionSchemas,
  ...Object.fromEntries(cases.map(({ name, schema }) => [name, schema])),
};

let root;
let operations;
let RequestValidationError;
before(async () => {
  const cache = join(repo, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  root = await mkdtemp(join(cache, 'pom-oracle-'));
  const document = {
    openapi: '3.1.0',
    info: { title: 'Synthetic schema conformance', version: '1.0.0' },
    'x-pom-policy': {
      version: 2,
      auth: { public: { transport: 'none' } },
      retry: ['never'],
      timeout: ['interactive'],
      surfaces: ['oracle'],
    },
    paths: Object.fromEntries(
      cases.map(({ name }) => {
        const content = {
          'application/json': {
            schema: { $ref: `#/components/schemas/${name}` },
          },
        };
        return [
          `/oracle/${name}`,
          {
            post: {
              operationId: `check${name}`,
              'x-pom': {
                auth: 'public',
                retry: 'never',
                timeout: 'interactive',
                surfaces: ['oracle'],
              },
              requestBody: { required: true, content },
              responses: { 200: { description: 'Validated value', content } },
            },
          },
        ];
      }),
    ),
    components: { schemas },
  };
  for (const [name, source] of Object.entries(
    await compile(document, { clients: ['oracle'] }),
  ))
    await writeFile(join(root, name), source);
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await cp(
    new URL('./schema-composition-types.ts', import.meta.url),
    join(root, 'composition-types.ts'),
  );
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        rewriteRelativeImportExtensions: true,
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        verbatimModuleSyntax: true,
        types: [],
        outDir: 'built',
        noEmitOnError: true,
      },
      include: ['*.ts'],
    }),
  );
  await exec(process.execPath, [
    join(repo, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
  ({ operations, RequestValidationError } = await import(
    pathToFileURL(join(root, 'built/client.oracle.js')).href
  ));
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

for (const { name, samples } of cases) {
  test(`generated ${name} agrees with independent JSON Schema validation`, () => {
    // No coercion, defaults, or schema rewriting. OpenAPI's component container
    // and discriminator are annotations here: Ajv follows the literal refs and
    // independently evaluates oneOf. A sibling constraint gets its type from
    // its ref target, so only Ajv's redundant-type style restriction is disabled.
    const reference = new Ajv2020({
      strict: true,
      strictTypes: false,
      keywords: ['components', 'discriminator'],
    }).compile({
      components: { schemas },
      $ref: '#/components/schemas/' + name,
    });
    const operation = operations[`check${name}`];
    for (const [value, expected] of samples) {
      const context = `${name}: ${String(value)}`;
      assert.equal(reference(value), expected, `reference fixture ${context}`);
      let accepted = true;
      try {
        const request = operation.build({ body: value });
        assert.deepEqual(
          request.body,
          value,
          `request value preserved ${context}`,
        );
      } catch (error) {
        if (!(error instanceof RequestValidationError)) throw error;
        accepted = false;
      }
      assert.equal(accepted, expected, `generated request ${context}`);
      // JSON cannot represent NaN/Infinity; their rejection is checked only at
      // the builder boundary, before any application JSON serialization.
      if (typeof value === 'number' && !Number.isFinite(value)) continue;
      const response = operation.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      assert.equal(
        response.kind === 'success',
        expected,
        `generated response ${context}`,
      );
      if (expected)
        assert.deepEqual(
          response.data,
          value,
          `response value preserved ${context}`,
        );
    }
  });
}
