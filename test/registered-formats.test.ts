import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { commandFailure, invalidOptions } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import {
  registeredFormats,
  registeredFormatsFixture as fixture,
  registeredFormatsSelection as selection,
  registeredFormatsConsumer,
  verifyRegisteredFormats,
} from './registered-formats-fixture.ts';
import type { MediaClient } from './media-fixture.ts';
import type { StandaloneModule } from './runtime-types.ts';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const tsc = fileURLToPath(
  new URL('../node_modules/typescript/bin/tsc', import.meta.url),
);

void test('registered formats preserve JSON, YAML, dialect and source/config immutability while emitting only reachable rules', async () => {
  const expected = await compile(fixture(), selection);
  for (const modern of [true, false]) {
    const document = fixture(modern);
    const before = structuredClone({ document, selection });
    assert.deepEqual(await compile(document, selection), expected);
    assert.deepEqual(
      await compile(
        parseYaml(stringify(document), 'registered.yaml'),
        selection,
      ),
      expected,
    );
    assert.deepEqual({ document, selection }, before);
  }
  const projected = fixture();
  Reflect.deleteProperty(projected.components.schemas, 'Unused');
  assert.deepEqual(
    await compile(projected, {
      ...selection,
      formats: { slug: registeredFormats.slug },
    }),
    expected,
  );
});

void test('registered validators intersect format/schema patterns across runtime, directions, enums, text and generated types', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  const standalone = (name: string) =>
    importGenerated<StandaloneModule>(root, `standalone.${name}.ts`);
  verifyRegisteredFormats(
    await importGenerated<MediaClient>(root, 'client.consumer.ts'),
    await standalone('slug'),
    await standalone('input'),
    await standalone('output'),
  );
  assert.equal((await standalone('nullonly')).schema.parse(null), null);
  assert.equal(
    (await standalone('nullonly')).schema.safeParse('ready').success,
    false,
  );
  await writeFile(join(root, 'consumer.ts'), registeredFormatsConsumer);
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        types: [],
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ['./*.ts'],
    }),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')]);
});

void test('shared YAML schema aliases retain registered assertions in every schema context', async (t) => {
  const document = parseYaml(
    `
openapi: 3.0.4
info: {title: Registered YAML aliases, version: '1'}
paths: {}
components:
  schemas:
    Shared: &slug {type: string, format: slug, nullable: true}
    Value:
      type: object
      required: [a, b]
      properties:
        a: *slug
        b: {type: array, items: *slug}
      example: *slug
`,
    'shared-registered.yaml',
  );
  const options = {
    clients: [],
    formats: { slug: registeredFormats.slug },
    standalone: {
      value: {
        schema: '#/components/schemas/Value',
        usage: 'request' as const,
      },
    },
  };
  const before = JSON.stringify(document);
  const root = await generatedTestWorkspace(
    t,
    await compile(document, options),
  );
  assert.equal(JSON.stringify(document), before);
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.value.ts',
  );
  assert.deepEqual(schema.parse({ a: null, b: ['ready', null] }), {
    a: null,
    b: ['ready', null],
  });
  assert.equal(schema.safeParse({ a: 'INVALID', b: ['ready'] }).success, false);
  assert.equal(schema.safeParse({ a: null, b: ['INVALID'] }).success, false);
});

function scalarDocument(schema: object) {
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic registry scope', version: '1' },
    paths: {},
    components: { schemas: { Value: schema } },
  };
}
const scalarSelection = {
  clients: [],
  standalone: {
    value: { schema: '#/components/schemas/Value', usage: 'response' },
  },
} as const;

void test('simultaneous compilations keep same-name format registries isolated', async (t) => {
  const input = scalarDocument({ type: 'string', format: 'local' });
  const sources = await Promise.all(
    ['^a+$', '^b+$', '^a+$'].map((pattern) =>
      compile(input, {
        ...scalarSelection,
        formats: { local: { type: 'string', pattern } },
      }),
    ),
  );
  assert.deepEqual(sources[0], sources[2]);
  for (const [index, files] of sources.entries()) {
    const root = await generatedTestWorkspace(t, files);
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      'standalone.value.ts',
    );
    assert.equal(schema.safeParse('aaa').success, index !== 1);
    assert.equal(schema.safeParse('bbb').success, index === 1);
  }
  await assert.rejects(
    compile(input, scalarSelection),
    /unsupported format|unregistered format/,
  );
});

void test('registry definitions validate fully even when unused and cannot override built-ins', async () => {
  const input = scalarDocument({ type: 'string' });
  const malformed: unknown[] = [
    null,
    [],
    { slug: null },
    { slug: { type: 'number', pattern: 'x' } },
    { slug: { type: 'string' } },
    { slug: { type: 'string', pattern: 1 } },
    { slug: { type: 'string', pattern: '[' } },
    { slug: { type: 'string', pattern: '\\a' } },
    { slug: { type: 'string', pattern: 'x', flags: 'g' } },
    { slug: { type: 'string', pattern: 'x', check: () => true } },
    { '': { type: 'string', pattern: 'x' } },
    ...[
      'uuid',
      'email',
      'date',
      'uri',
      'int32',
      'int64',
      'float',
      'double',
      'binary',
    ].map((name) => ({ [name]: { type: 'string', pattern: 'x' } })),
    {
      slug: {
        type: 'string',
        pattern: '('.repeat(129) + 'x' + ')'.repeat(129),
      },
    },
  ];
  for (const formats of malformed)
    await assert.rejects(
      invalidOptions(compile, input, { ...scalarSelection, formats }),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.match(error.location, /^formats(?:\.|$)/);
        return true;
      },
    );
  for (const format of [
    'notRegistered',
    'toString',
    'constructor',
    '__proto__',
  ])
    await assert.rejects(
      compile(scalarDocument({ type: 'string', format }), scalarSelection),
      ContractError,
    );
});

void test('registered formats reject wrong schema types and invalid enums while reference narrowing retains both regexes', async (t) => {
  for (const schema of [
    { type: 'integer', format: 'slug' },
    { type: 'string', format: 'slug', enum: ['Bad'] },
    { type: ['string', 'null'], format: 'slug', enum: ['Bad', null] },
  ])
    await assert.rejects(
      compile(scalarDocument(schema), {
        ...scalarSelection,
        formats: { slug: registeredFormats.slug },
      }),
      ContractError,
    );
  const input = scalarDocument({
    $ref: '#/components/schemas/Base',
    pattern: '^x',
  });
  Object.assign(input.components.schemas, {
    Base: { type: 'string', format: 'slug' },
  });
  const options = {
    ...scalarSelection,
    formats: { slug: registeredFormats.slug },
  };
  const root = await generatedTestWorkspace(t, await compile(input, options));
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.value.ts',
  );
  assert.equal(schema.parse('x-1'), 'x-1');
  for (const value of ['other', 'x_1'])
    assert.equal(schema.safeParse(value).success, false);
  input.openapi = '3.0.4';
  await assert.rejects(compile(input, options), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, 'components.schemas.Value.pattern');
    return true;
  });
});

void test('registered Unicode-property formats keep literal matching at runtime', async (t) => {
  const pattern = String.raw`^\p{L}$`;
  const letter = String.fromCodePoint(0x16ea0);
  const input = scalarDocument({
    type: 'string',
    format: 'letter',
    enum: [letter],
  });
  const options = {
    ...scalarSelection,
    formats: { letter: { type: 'string' as const, pattern } },
  };
  // oxlint-disable-next-line typescript/unbound-method -- Preserve each original RegExp receiver while simulating compiler Unicode classification.
  const original = RegExp.prototype.test;
  let evaluations = 0;
  let files: Readonly<Record<string, string>> | undefined;
  for (const matches of [false, true]) {
    const mock = t.mock.method(
      RegExp.prototype,
      'test',
      function (this: RegExp, value: string) {
        // Whole-value format matching may wrap the original expression.
        if (this.source.includes(pattern)) {
          evaluations++;
          return matches;
        }
        return original.call(this, value);
      },
    );
    try {
      const result = await compile(input, options);
      if (files) assert.deepEqual(result, files);
      else files = result;
    } finally {
      mock.mock.restore();
    }
  }
  assert.equal(evaluations, 0);
  assert.ok(files);
  const root = await generatedTestWorkspace(t, files);
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.value.ts',
  );
  for (const matches of [false, true]) {
    const mock = t.mock.method(
      RegExp.prototype,
      'test',
      function (this: RegExp, value: string) {
        return this.source.includes(pattern)
          ? matches
          : original.call(this, value);
      },
    );
    try {
      assert.equal(schema.safeParse(letter).success, matches);
    } finally {
      mock.mock.restore();
    }
  }
});

void test('JSON CLI registry matches library output and invalid definitions preserve generated files', async (t) => {
  const root = await temporary(t);
  const input = join(root, 'openapi.yaml');
  const config = join(root, 'pom.json');
  const output = join(root, 'generated');
  const source = stringify(fixture(false));
  await writeFile(input, source);
  const configuration = {
    version: 2,
    openapi: './openapi.yaml',
    output: './generated',
    ...selection,
  };
  await writeFile(config, JSON.stringify(configuration));
  await exec(process.execPath, [cli, 'generate', '--config', config]);
  await exec(process.execPath, [cli, 'check', '--config', config]);
  const expected = await compile(fixture(false), selection);
  for (const [name, contents] of Object.entries(expected))
    assert.equal(await readFile(join(output, name), 'utf8'), contents);
  const before = await fileSnapshot(output);
  await writeFile(
    config,
    JSON.stringify({
      ...configuration,
      formats: {
        ...selection.formats,
        unused: { type: 'string', pattern: '[' },
      },
    }),
  );
  for (const command of ['generate', 'check']) {
    await assert.rejects(
      exec(process.execPath, [cli, command, '--config', config]),
      commandFailure(1, /formats\.unused\.pattern/),
    );
    assert.deepEqual(await fileSnapshot(output), before);
  }
  assert.equal(await readFile(input, 'utf8'), source);
});
