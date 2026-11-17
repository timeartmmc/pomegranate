import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import type { CompileWarning, OutputWarning } from '../dist/index.js';
import { invalidOptions } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';
import { referenceNoopCases, schemaNoopCases } from './schema-noops-fixture.ts';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const selection = {
  clients: [],
  standalone: { root: { schema: ref('Root').$ref, usage: 'request' } },
} as const;
function document(schemas: Record<string, Schema>, openapi = '3.1.2') {
  return {
    openapi,
    info: { title: 'Synthetic inactive schema rules', version: '1' },
    paths: {},
    components: { schemas },
  };
}

void test('inactive keywords preserve generated types and every applicable runtime rule', async (t) => {
  for (const version of ['3.0.4', '3.1.2']) {
    const cases = [...schemaNoopCases, ...referenceNoopCases].filter(
      (entry) =>
        version.startsWith('3.1') ||
        (typeof entry.schema.type === 'string' && entry.schema.type !== 'null'),
    );
    const schemas = Object.fromEntries(
      cases.map((entry) => [entry.name, entry.schema]),
    );
    const input = document(schemas, version);
    const before = structuredClone(input);
    const standalone = Object.fromEntries(
      cases.flatMap(({ name }) =>
        (['request', 'response'] as const).map((usage) => [
          `${name.toLowerCase()}-${usage}`,
          { schema: ref(name).$ref, usage },
        ]),
      ),
    );
    const warnings: CompileWarning[] = [];
    const files = await compile(input, {
      clients: [],
      standalone,
      onWarning: (warning) => {
        warnings.push(warning);
      },
    });
    assert.ok(warnings.length > 0);
    assert.ok(
      warnings.every(
        (warning) =>
          warning.code === 'ignored-schema-keyword' &&
          warning.path.includes('components.schemas.') &&
          warning.message.includes('has no effect'),
      ),
    );
    assert.deepEqual(
      files,
      await compile(
        document(
          Object.fromEntries(
            cases.map((entry) => [entry.name, entry.equivalent]),
          ),
          version,
        ),
        { clients: [], standalone },
      ),
    );
    assert.deepEqual(input, before);
    const root = await generatedTestWorkspace(t, files);
    for (const { name, samples } of cases)
      for (const usage of ['request', 'response']) {
        const { schema } = await importGenerated<StandaloneModule>(
          root,
          `standalone.${name.toLowerCase()}-${usage}.ts`,
        );
        for (const [sample, accepted] of samples)
          assert.equal(
            schema.safeParse(sample).success,
            accepted,
            `${version} ${name} ${usage}: ${JSON.stringify(sample)}`,
          );
      }
  }
});

void test('inactive keywords still reject malformed values and preserve unsupported active semantics', async () => {
  const referenced = document({
    Root: {
      type: 'string',
      items: ref('Alias'),
      properties: { value: ref('Alias') },
      additionalProperties: ref('Alias'),
    },
    Alias: ref('Text'),
    Text: { type: 'integer', minimum: 2 },
  });
  assert.deepEqual(
    await compile(referenced, selection),
    await compile(
      document({ ...referenced.components.schemas, Root: { type: 'string' } }),
      selection,
    ),
  );
  const malformed: Record<string, unknown>[] = [
    { type: 'string', uniqueItems: 'yes' },
    { type: 'number', minLength: -1 },
    { type: 'string', minimum: Infinity },
    { type: 'object', multipleOf: 0 },
    { type: 'integer', pattern: '[' },
    { type: 'array', items: {}, required: ['id', 'id'] },
    { type: 'string', properties: [] },
    { type: 'string', additionalProperties: null },
    { type: 'number', items: [] },
    { type: 'string', items: ref('Missing') },
    {
      type: 'number',
      properties: { nested: { type: 'array', items: ref('Missing') } },
    },
    { type: 'boolean', additionalProperties: ref('Missing') },
    { type: 'object', uniqueItems: true, not: {} },
    // No explicit type excludes arrays in a non-narrowing object fragment.
    { allOf: [{ type: 'object' }, { properties: {}, minItems: 1 }] },
    { oneOf: [{ type: 'string' }, { type: 'string', minLength: 2 }] },
  ];
  for (const schema of malformed)
    await assert.rejects(
      compile(document({ Root: schema }), selection),
      ContractError,
    );
  for (const schema of [
    { type: 'string', nullable: 'true' },
    { nullable: 'true', allOf: [ref('Text')] },
    { $ref: ref('Text').$ref, nullable: 'true' },
  ])
    await assert.rejects(
      compile(
        document({ Root: schema, Text: { type: 'string' } }, '3.0.4'),
        selection,
      ),
      /nullable.*expected a boolean/,
    );
  await assert.rejects(
    invalidOptions(compile, document({ Root: { type: 'string' } }), {
      ...selection,
      onWarning: 'yes',
    }),
    /onWarning.*expected a function/,
  );
});

void test('warnings summarize repeated source declarations and honor hidden null-prototype keys', async () => {
  const schemas: Record<string, Schema> = Object.fromEntries(
    Array.from({ length: 1_000 }, (_, index) => [
      `Unused${String(index).padStart(4, '0')}`,
      { type: 'string', uniqueItems: true },
    ]),
  );
  schemas.Root = { type: 'string' };
  const warnings: CompileWarning[] = [];
  await compile(document(schemas), {
    ...selection,
    onWarning: (warning) => {
      warnings.push(warning);
    },
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]!.path, 'components.schemas.Unused0000.uniqueItems');
  assert.match(warnings[0]!.message, /1000 occurrences; first location shown/);
  const hidden = Object.create(null, {
    type: { value: 'object' },
    uniqueItems: { value: true },
  }) as Schema;
  const options = Object.create(null, {
    ...Object.getOwnPropertyDescriptors(selection),
    onWarning: {
      value: (warning: CompileWarning) => {
        warnings.push(warning);
      },
    },
  }) as typeof selection & { onWarning: (warning: CompileWarning) => void };
  const before = Object.getOwnPropertyDescriptors(hidden);
  await compile(document({ Root: hidden }), options);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[1]!.path, 'components.schemas.Root.uniqueItems');
  assert.deepEqual(Object.getOwnPropertyDescriptors(hidden), before);
});

void test('single-reference allOf constraints enforce strings and preserve arrays and maps in both dialects', async (t) => {
  const cases: [string, unknown[], unknown[]][] = [
    ['Array', [[1, 2]], [[1], [1, 0], [1, 2, 3, 4], '12']],
    ['Text', ['ab', 'abc'], ['a', 'abcd', 12]],
    ['Map', [{ id: 1, other: 2 }], [{}, { id: 0 }, { a: 1, b: 2, c: 3 }]],
  ];
  for (const version of ['3.0.4', '3.1.2']) {
    const input = document(
      {
        Items: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          maxItems: 3,
        },
        Alias: ref('Items'),
        Array: {
          allOf: [ref('Alias')],
          minLength: 5,
          maxLength: 1,
          minItems: 2,
        },
        TextBase: { type: 'string', pattern: '^a' },
        Text: {
          allOf: [ref('TextBase')],
          minLength: 2,
          maxLength: 3,
          minItems: 5,
        },
        MapBase: {
          type: 'object',
          additionalProperties: { type: 'integer', minimum: 1 },
          required: ['id'],
          maxProperties: 2,
        },
        Map: { allOf: [ref('MapBase')], minLength: 5 },
      },
      version,
    );
    const warnings: CompileWarning[] = [];
    const files = await compile(input, {
      clients: [],
      standalone: Object.fromEntries(
        cases.flatMap(([name]) =>
          (['request', 'response'] as const).map((usage) => [
            `${name.toLowerCase()}-${usage}`,
            { schema: ref(name).$ref, usage },
          ]),
        ),
      ),
      onWarning: (warning) => {
        warnings.push(warning);
      },
    });
    assert.ok(
      warnings.some((w) => w.path === 'components.schemas.Array.allOf[0].$ref'),
    );
    const root = await generatedTestWorkspace(t, files);
    for (const [name, valid, invalid] of cases)
      for (const usage of ['request', 'response']) {
        const { schema } = await importGenerated<StandaloneModule>(
          root,
          `standalone.${name.toLowerCase()}-${usage}.ts`,
        );
        for (const sample of valid)
          assert.deepEqual(schema.parse(sample), sample);
        for (const sample of invalid)
          assert.equal(schema.safeParse(sample).success, false);
      }
  }
});

void test('inactive reference constraints behave consistently through recursive object composition', async (t) => {
  let expectedWarnings: CompileWarning[] | undefined;
  for (const recursive of [false, true])
    for (const composedBase of [false, true]) {
      const node = {
        type: 'object',
        properties: {
          id: { type: 'integer', minimum: 1 },
          ...(recursive ? { next: ref('Root') } : {}),
        },
        required: ['id'],
      };
      const warnings: CompileWarning[] = [];
      const files = await compile(
        document({
          Node: composedBase ? { allOf: [node, { type: 'object' }] } : node,
          Alias: { ...ref('Node'), minLength: 3, minProperties: 2 },
          Root: {
            allOf: [
              ref('Alias'),
              { type: 'object', properties: { name: { type: 'string' } } },
            ],
          },
        }),
        {
          ...selection,
          onWarning: (warning) => {
            warnings.push(warning);
          },
        },
      );
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!.message, /minLength has no effect/);
      if (expectedWarnings) assert.deepEqual(warnings, expectedWarnings);
      else expectedWarnings = warnings;
      const root = await generatedTestWorkspace(t, files);
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        'standalone.root.ts',
      );
      const value = recursive
        ? { id: 1, next: { id: 2, name: 'leaf' } }
        : { id: 1, name: 'leaf' };
      assert.deepEqual(schema.parse(value), value);
      assert.equal(schema.safeParse({ id: 1 }).success, false);
      assert.equal(schema.safeParse({ id: 0, name: 'leaf' }).success, false);
      if (recursive)
        assert.equal(
          schema.safeParse({ id: 1, next: { id: 2 } }).success,
          false,
        );
    }
});

void test('reference no-ops retain syntax checks and diagnose constraints whose target type is unknown', async () => {
  for (const restriction of [
    { minLength: -1 },
    { maxLength: '1' },
    { pattern: '[' },
    { minimum: Infinity },
    { multipleOf: 0 },
    { uniqueItems: 'yes' },
    { not: {} },
  ])
    await assert.rejects(
      compile(
        document({
          Items: { type: 'array', items: { type: 'string' } },
          Root: { ...ref('Items'), ...restriction },
        }),
        selection,
      ),
      ContractError,
    );
  for (const target of [{}, { anyOf: [{ type: 'string' }, { type: 'null' }] }])
    await assert.rejects(
      compile(
        document({
          Target: target,
          Root: { ...ref('Target'), minLength: 2 },
        }),
        selection,
      ),
      /constraint is unsupported on referenced (json|union)/,
    );
  await assert.rejects(
    compile(
      document({
        Root: { ...ref('Missing'), minLength: 2 },
      }),
      selection,
    ),
    /unresolved reference Missing/,
  );
  await assert.rejects(
    compile(
      document(
        {
          Items: { type: 'array', items: { type: 'string' } },
          Root: { ...ref('Items'), minLength: 2 },
        },
        '3.0.4',
      ),
      selection,
    ),
    /Root.minLength.*unsupported keyword/,
  );
});

void test('inactive reference constraints handle long aliases and hidden keys without changing caller records', async (t) => {
  const schemas: Record<string, Schema> = {
    Items: {
      type: 'array',
      items: { type: 'integer', minimum: 1 },
      maxItems: 3,
    },
  };
  let name = 'Items';
  for (let index = 0; index < 1_500; index++) {
    const alias = `Alias${index}`;
    schemas[alias] = { ...ref(name), minLength: 5 };
    name = alias;
  }
  const hidden = Object.create(null, {
    $ref: { value: ref(name).$ref },
    maxLength: { value: 1 },
    minItems: { value: 2 },
  }) as Schema;
  schemas.Root = hidden;
  const before = Object.getOwnPropertyDescriptors(hidden);
  const warnings: CompileWarning[] = [];
  const files = await compile(document(schemas), {
    ...selection,
    onWarning: (warning) => {
      warnings.push(warning);
    },
  });
  assert.deepEqual(Object.getOwnPropertyDescriptors(hidden), before);
  assert.equal(warnings.length, 2);
  assert.ok(
    warnings.some((w) =>
      /1500 occurrences; first location shown/.test(w.message),
    ),
  );
  const root = await generatedTestWorkspace(t, files);
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.root.ts',
  );
  assert.deepEqual(schema.parse([1, 2]), [1, 2]);
  for (const value of [[1], [1, 0], [1, 2, 3, 4], null])
    assert.equal(schema.safeParse(value).success, false);
});

void test('JSON and YAML projects and CLI checks report warnings while preserving output ownership', async (t) => {
  const root = await temporary(t);
  const config = join(root, 'pom.json');
  const input = document({
    Root: {
      type: 'array',
      items: { type: 'string', minLength: 2 },
      required: ['id'],
    },
  });
  for (const extension of ['json', 'yaml']) {
    const source = join(root, `openapi.${extension}`);
    await writeFile(
      source,
      extension === 'json' ? JSON.stringify(input) : stringify(input),
    );
    await writeFile(
      config,
      JSON.stringify({
        version: 2,
        openapi: `./openapi.${extension}`,
        output: './generated',
        ...selection,
      }),
    );
    const observed: OutputWarning[] = [];
    const result = await runProject(config, {
      onWarning: (warning) => {
        observed.push(warning);
      },
    });
    assert.deepEqual(result.warnings, observed);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]!.code, 'ignored-schema-keyword');
    const before = await fileSnapshot(join(root, 'generated'));
    const checked = await runProject(config, { check: true });
    assert.equal(checked.clean, true);
    assert.deepEqual(checked.warnings, result.warnings);
    const { stderr } = await exec(process.execPath, [
      cli,
      'check',
      '--config',
      config,
    ]);
    assert.match(
      stderr,
      /POM warning \[ignored-schema-keyword\].*Root.required.*has no effect/,
    );
    assert.deepEqual(await fileSnapshot(join(root, 'generated')), before);
    await writeFile(
      join(root, 'generated', 'standalone.root.ts'),
      '// local edit\n',
    );
    const edited = await runProject(config);
    assert.deepEqual(
      edited.warnings.map((warning) => warning.code),
      ['ignored-schema-keyword', 'modified-output'],
    );
    const regenerated = await fileSnapshot(join(root, 'generated'));
    await assert.rejects(
      runProject(config, {
        onWarning: () => {
          throw new Error('diagnostic consumer failed');
        },
      }),
      /diagnostic consumer failed/,
    );
    assert.deepEqual(await fileSnapshot(join(root, 'generated')), regenerated);
  }
});
