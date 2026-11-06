import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import {
  checkInputExpansion,
  createSchemaAdmission,
} from '../dist/input-limits.js';
import { parseYaml } from '../dist/yaml.js';
import { fileSnapshot, temporary } from './helpers.ts';
import { json } from './assertions.ts';
import type { Schema } from './schema-helpers.ts';

const exec = promisify(execFile);
const selection = {
  clients: [],
  standalone: {
    flat: { schema: '#/components/schemas/Flat', usage: 'response' },
  },
} as const;

function document() {
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic bounded input', version: '1' },
    paths: {},
    components: { schemas: { Flat: { type: 'string' } } },
  };
}

function graph(depth: number): Schema {
  let source: Schema = { type: 'string' };
  for (let index = 0; index < depth; index++)
    source = { type: 'object', properties: { left: source, right: source } };
  return source;
}

// Build an exactly sized JSON value without allocating its unfolded tree.
function sizedValue(size: number, cache = new Map<number, object>()): unknown {
  if (size === 1) return null;
  const known = cache.get(size);
  if (known) return known;
  const remaining = size - 1;
  const left = Math.floor(remaining / 2);
  const value =
    left === 0
      ? [sizedValue(remaining, cache)]
      : [sizedValue(left, cache), sizedValue(remaining - left, cache)];
  cache.set(size, value);
  return value;
}

void test('input admission accepts the exact expanded-node boundary and rejects its first excess', () => {
  const exact = sizedValue(1_000_000);
  assert.ok(exact !== null && typeof exact === 'object');
  checkInputExpansion(exact);
  const excess = sizedValue(1_000_001);
  assert.ok(excess !== null && typeof excess === 'object');
  assert.throws(() => checkInputExpansion(excess), {
    name: 'ContractError',
    location: 'OpenAPI',
  });
  // A mapping adds its own node and one key node as well as its value.
  checkInputExpansion({ value: sizedValue(999_998) });
  assert.throws(() => checkInputExpansion({ value: exact }), ContractError);
  assert.throws(
    () => checkInputExpansion(Array<unknown>(1_000_000)),
    ContractError,
  );
});

void test('schema admission never executes getters and rejects cyclic declarations', async () => {
  let reads = 0;
  createSchemaAdmission()(
    {
      type: 'array',
      get items() {
        reads++;
        throw new Error('admission must not invoke application code');
      },
    },
    'accessor',
  );
  assert.equal(reads, 0);
  const cycle: Schema = { type: 'array' };
  cycle.items = cycle;
  const input = document();
  Object.assign(input.components.schemas, { Cycle: cycle });
  await assert.rejects(compile(input, selection), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, 'components.schemas.Cycle');
    assert.match(error.message, /schema nesting.*cycle/);
    return true;
  });
});

void test('policy, component and HTTP schemas share one cumulative admission budget', async () => {
  const schema = {
    type: 'integer',
    enum: Array.from({ length: 250_000 }, (_, index) => index),
  };
  const input = {
    ...document(),
    'x-pom-policy': {
      version: 3,
      fields: { first: schema, second: schema },
    },
    components: { schemas: { Large: schema } },
    paths: {
      '/value': {
        post: {
          operationId: 'value',
          requestBody: {
            required: true,
            content: { 'application/json': { schema } },
          },
          responses: { 204: { description: 'Synthetic empty response' } },
        },
      },
    },
  };
  // Each root fits alone. Reusing its source does not reduce normalization work.
  await assert.rejects(
    compile(input, {
      clients: ['consumer'],
      surfaces: { consumer: ['value'] },
    }),
    {
      name: 'ContractError',
      location: 'paths./value.post.requestBody.content.application/json.schema',
      message: /expanded schema input.*1000000 nodes/,
    },
  );
});

void test('annotation masking preserves real schemas in named and shared contexts', () => {
  const large = graph(31);
  for (const name of [
    'default',
    'example',
    'examples',
    'readOnly',
    'writeOnly',
    'title',
    'description',
    'deprecated',
    'externalDocs',
    '$comment',
  ])
    assert.throws(
      () =>
        createSchemaAdmission()(
          { type: 'object', properties: { [name]: large } },
          'Root',
        ),
      { name: 'ContractError', location: 'Root', message: /expanded schema/ },
      `property ${name} still declares a schema`,
    );
  const shared = { default: large };
  assert.throws(
    () =>
      createSchemaAdmission()(
        { type: 'object', properties: shared, default: shared },
        'Root',
      ),
    { name: 'ContractError', location: 'Root', message: /expanded schema/ },
  );
  assert.doesNotThrow(() =>
    createSchemaAdmission()(
      { type: 'string', default: large, example: large, examples: [large] },
      'Root',
    ),
  );
});

void test('source array holes cannot inherit declarations that escaped expansion accounting', async () => {
  const input = document();
  Object.assign(input.components.schemas, {
    Hidden: { anyOf: Array<unknown>(2) },
  });
  const names = ['0', '1'];
  const before = names.map((name) =>
    Object.getOwnPropertyDescriptor(Object.prototype, name),
  );
  let result: ReturnType<typeof compile>;
  try {
    Object.defineProperty(Object.prototype, '0', {
      value: graph(31),
      writable: true,
      configurable: true,
    });
    Object.defineProperty(Object.prototype, '1', {
      value: { type: 'null' },
      writable: true,
      configurable: true,
    });
    result = compile(input, selection);
  } finally {
    for (const [index, name] of names.entries()) {
      const descriptor = before[index];
      if (descriptor) Object.defineProperty(Object.prototype, name, descriptor);
      else Reflect.deleteProperty(Object.prototype, name);
    }
  }
  await assert.rejects(result, {
    name: 'ContractError',
    location: 'components.schemas.Hidden.anyOf[0]',
    message: 'components.schemas.Hidden.anyOf[0]: expected an object',
  });
});

void test('small shared and duplicated JSON/YAML sources retain identical generated bytes', async () => {
  const input = document();
  Object.assign(input.components.schemas, { Shared: graph(4) });
  const expected = await compile(input, selection);
  assert.deepEqual(
    await compile(json(JSON.stringify(input)), selection),
    expected,
  );
  assert.deepEqual(
    await compile(parseYaml(stringify(input), 'synthetic.yaml'), selection),
    expected,
  );
});

void test('an unused depth-31 graph receives an actionable rejection before formatting in a 128 MiB child', async (t) => {
  const root = await temporary(t);
  const path = join(root, 'probe.mjs');
  await writeFile(
    path,
    `import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'oxfmt') return { shortCircuit: true, url: 'data:text/javascript,export function format(){throw new Error("admission must precede formatting")}' };
  return next(specifier, context);
}});
const { compile, ContractError } = await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
let source = { type: 'string' };
for (let depth = 0; depth < 31; depth++) source = { type: 'object', properties: { left: source, right: source } };
const input = { openapi: '3.1.2', info: { title: 'Synthetic', version: '1' }, paths: {}, components: { schemas: { Flat: { type: 'string' }, Extreme: source } } };
await assert.rejects(compile(input, { clients: [], standalone: { flat: { schema: '#/components/schemas/Flat', usage: 'response' } } }), error => {
  assert.ok(error instanceof ContractError);
  assert.equal(error.location, 'components.schemas.Extreme');
  assert.match(error.message, /expanded schema input.*1000000 nodes/);
  assert.ok(error.message.includes('components') && error.message.includes('local $ref'));
  return true;
});
for (let depth = 0; depth < 31; depth++) {
  assert.equal(source.properties.left, source.properties.right);
  source = source.properties.left;
}
assert.deepEqual(source, { type: 'string' });
console.log('bounded rejection');
`,
  );
  const result = await exec(
    process.execPath,
    ['--max-old-space-size=128', path],
    {
      timeout: 20_000,
    },
  );
  assert.equal(result.stdout, 'bounded rejection\n');
});

void test('oversized JSON and YAML inputs preserve existing and missing outputs in generate and check modes', async (t) => {
  for (const extension of ['json', 'yaml'])
    for (const existing of [false, true]) {
      const root = await temporary(t);
      const config = join(root, 'pom.json');
      const input = join(root, `openapi.${extension}`);
      const output = join(root, 'generated');
      const serialize = extension === 'json' ? JSON.stringify : stringify;
      await writeFile(input, serialize(document()));
      await writeFile(
        config,
        JSON.stringify({
          version: 2,
          openapi: `./openapi.${extension}`,
          output: './generated',
          ...selection,
        }),
      );
      if (existing) await runProject(config);
      const oversized = document();
      Object.assign(oversized.components.schemas, {
        Extreme:
          extension === 'json'
            ? { type: 'string', enum: Array<string>(1_000_001).fill('x') }
            : graph(31),
      });
      await writeFile(input, serialize(oversized));
      const before = existing
        ? await fileSnapshot(output)
        : await readdir(root);
      for (const check of [false, true])
        await assert.rejects(
          runProject(config, { check }),
          (error) =>
            error instanceof ContractError &&
            /expanded (?:schema input|document).*1000000 nodes/.test(
              error.message,
            ),
        );
      assert.deepEqual(
        existing ? await fileSnapshot(output) : await readdir(root),
        before,
      );
    }
});
