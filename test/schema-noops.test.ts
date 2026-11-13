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
import { schemaNoopCases } from './schema-noops-fixture.ts';

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
    const cases = schemaNoopCases.filter(
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
