import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import { schemaFixture } from './schema-fixture.mjs';
import { deepFixture, deepTypeConsumer, verifyDeep } from './deep-fixture.mjs';

const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

function nested(depth, wrap, leaf = { type: 'string' }) {
  let value = leaf;
  for (let index = 0; index < depth; index++) value = wrap(value);
  return value;
}

const array = (items) => ({ type: 'array', items });
const boundedArray = (items) => ({
  type: 'array',
  items,
  minItems: 1,
  maxItems: 2,
});
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const map = (schema) => ({ type: 'object', additionalProperties: schema });
const requiredObject = (schema) => ({
  type: 'object',
  properties: { value: schema },
  required: ['value'],
});
const optionalObject = (schema) => ({
  type: 'object',
  properties: { value: schema },
});

function documentWith(schemas) {
  const document = schemaFixture();
  document.paths = {};
  document.components.schemas = schemas;
  return document;
}

test('very deep input schemas fail with ContractError before native formatting', async () => {
  // Isolate the native dependency: a regression must fail this test instead of
  // killing the test runner with SIGILL or a native stack overflow.
  const script = `
    import assert from 'node:assert/strict';
    import { compile, ContractError } from ${JSON.stringify(pathToFileURL(join(repo, 'dist/index.js')).href)};
    import { schemaFixture } from ${JSON.stringify(pathToFileURL(join(repo, 'test/schema-fixture.mjs')).href)};
    for (const kind of ['array', 'object']) {
      for (const depth of [900, 10000]) {
        let schema = { type: 'string' };
        for (let index = 0; index < depth; index++)
          schema = kind === 'array' ? { type: 'array', items: schema } : { type: 'object', properties: { value: schema } };
        const document = schemaFixture();
        document.components.schemas.TooDeep = schema;
        await assert.rejects(compile(document, { clients: ['samples'] }), error => {
          assert.ok(error instanceof ContractError);
          assert.match(error.message, /inline schema nesting exceeds the supported limit of 32 levels/);
          assert.equal(error.location, 'components.schemas.TooDeep' + (kind === 'array' ? '.items' : '.properties.value').repeat(32));
          return true;
        });
      }
    }
    console.log('depth diagnostics verified');
  `;
  const result = await exec(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      cwd: repo,
      timeout: 10000,
    },
  );
  assert.equal(result.stdout.trim(), 'depth diagnostics verified');
});

test('structured references cannot bypass the runtime nesting limit', async () => {
  const schemas = { Layer0000: { type: 'string' } };
  for (let index = 1; index <= 128; index++)
    schemas[`Layer${String(index).padStart(4, '0')}`] = array(
      ref(`Layer${String(index - 1).padStart(4, '0')}`),
    );
  for (const document of [documentWith(schemas)]) {
    await assert.rejects(
      compile(document, {
        clients: [],
        standalone: {
          input: { schema: ref('Layer0000').$ref, usage: 'request' },
        },
      }),
      (error) =>
        error instanceof ContractError &&
        /schema nesting exceeds the supported limit of 128 levels/.test(
          error.message,
        ),
    );
  }
});

test('named component types preserve deep request, response and TypeScript contracts', async (t) => {
  const cache = join(repo, 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, 'pom-named-depth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'deep-generated'));
  for (const [name, source] of Object.entries(
    await compile(deepFixture(), { clients: ['deep'] }),
  ))
    await writeFile(join(root, 'deep-generated', name), source);
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(root, 'consume.ts'), deepTypeConsumer());
  const config = JSON.parse(
    await readFile(join(repo, 'examples/json/tsconfig.json'), 'utf8'),
  );
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({ ...config, include: ['*.ts', 'deep-generated/*.ts'] }),
  );
  await exec(process.execPath, [
    join(repo, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
  const { operations, RequestValidationError } = await import(
    pathToFileURL(join(root, '.build/deep-generated/client.deep.js')).href
  );
  verifyDeep(operations, RequestValidationError);
});

test('supported nesting boundaries, deep defaults and long aliases compile and execute', async (t) => {
  const cache = join(repo, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, 'pom-depth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const schemas = {
    Base: { type: 'string' },
    Arrays: nested(31, array),
    Nullable: nested(31, nullable),
    Maps: nested(31, map),
    Objects: nested(31, requiredObject),
    Optional: nested(31, optionalObject, { type: 'string', const: 'leaf' }),
    Constraints: nested(31, boundedArray, {
      ...ref('Base'),
      minLength: 1,
      maxLength: 5,
    }),
    Default: {
      type: 'string',
      default: nested(5000, (value) => [value], 'annotation'),
    },
    Alias0000: { type: 'string' },
    Referenced0000: { type: 'string' },
  };
  for (let index = 1; index <= 127; index++)
    schemas[`Referenced${String(index).padStart(4, '0')}`] = array(
      ref(`Referenced${String(index - 1).padStart(4, '0')}`),
    );
  for (let index = 1; index <= 1000; index++) {
    schemas[`Alias${String(index).padStart(4, '0')}`] = ref(
      `Alias${String(index - 1).padStart(4, '0')}`,
    );
  }
  const standalone = Object.fromEntries([
    ...[
      'Arrays',
      'Nullable',
      'Maps',
      'Objects',
      'Optional',
      'Constraints',
      'Alias1000',
      'Referenced0127',
    ].flatMap((name) =>
      ['request', 'response'].map((usage) => [
        `${name.toLowerCase()}-${usage}`,
        { schema: ref(name).$ref, usage },
      ]),
    ),
    ['default', { schema: ref('Default').$ref, usage: 'request' }],
  ]);
  const outputs = await compile(documentWith(schemas), {
    clients: [],
    standalone,
  });
  for (const [name, source] of Object.entries(outputs))
    await writeFile(join(root, name), source);
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  const config = JSON.parse(
    await readFile(join(repo, 'examples/json/tsconfig.json'), 'utf8'),
  );
  config.include = ['*.ts'];
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify(config));
  await exec(process.execPath, [
    join(repo, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
  for (const usage of ['request', 'response']) {
    for (const [name, value] of [
      ['arrays', nested(31, (item) => [item], 'value')],
      ['nullable', null],
      ['maps', nested(31, (value) => ({ key: value }), 'value')],
      ['objects', nested(31, (value) => ({ value }), 'value')],
      ['optional', nested(31, (value) => ({ value }), 'leaf')],
      ['constraints', nested(31, (item) => [item], 'value')],
      ['alias1000', 'value'],
      ['referenced0127', nested(127, (item) => [item], 'value')],
    ]) {
      const { schema } = await import(
        pathToFileURL(join(root, '.build', `standalone.${name}-${usage}.js`))
          .href
      );
      assert.deepEqual(schema.parse(value), value);
      if (name === 'referenced0127')
        assert.equal(
          schema.safeParse(nested(127, (item) => [item], 42)).success,
          false,
        );
      if (name === 'optional') {
        assert.deepEqual(schema.parse({}), {});
        assert.equal(
          schema.safeParse(nested(31, (value) => ({ value }), 123)).success,
          false,
        );
      }
    }
  }
  const { schema } = await import(
    pathToFileURL(join(root, '.build', 'standalone.default.js')).href
  );
  assert.equal(schema.parse('value'), 'value');
  assert.equal(schema.safeParse(undefined).success, false);
});
