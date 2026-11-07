import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import { createSchemaNormalizer } from '../dist/schemas.js';
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

for (const [name, wrap] of [
  [
    'object property',
    (schema) => ({ type: 'object', properties: { value: schema } }),
  ],
  ['array item', (schema) => ({ type: 'array', items: schema })],
  ['map value', (schema) => ({ type: 'object', additionalProperties: schema })],
  ['union branch', (schema) => ({ anyOf: [schema, { type: 'null' }] })],
] satisfies [string, (schema: Schema) => Schema][]) {
  void test(`normalization passes the same work budget into every ${name}`, () => {
    const small = wrap({ type: 'string' });
    assert.doesNotThrow(() =>
      createSchemaNormalizer(new Map(), 5)(small, 'small'),
    );
    assert.throws(
      () => createSchemaNormalizer(new Map(), 5)(wrap(graph(4)), 'large'),
      { name: 'ContractError', message: /normalization work.*5 units/ },
    );
  });
}

void test('normalization reserves literal work, shares its exact budget across roots and resets per descriptor', () => {
  const schema = { type: 'integer', enum: [1, 2, 3] };
  const normalize = createSchemaNormalizer(new Map(), 8);
  normalize(schema, 'first');
  normalize(schema, 'second');
  assert.throws(() => normalize({}, 'third'), {
    name: 'ContractError',
    location: 'third',
    message: /normalization work.*8 units/,
  });
  const fresh = createSchemaNormalizer(new Map(), 4);
  fresh(schema, 'fresh');
  assert.throws(
    () => createSchemaNormalizer(new Map(), 3)(schema, 'wide-enum'),
    { name: 'ContractError', location: 'wide-enum' },
  );
});

void test('annotation payloads stay outside schema work while a property named default consumes it', () => {
  const payload = graph(31);
  createSchemaNormalizer(new Map(), 1)(
    { type: 'string', default: payload, example: payload, examples: [payload] },
    'annotation',
  );
  assert.throws(
    () =>
      createSchemaNormalizer(new Map(), 2)(
        { type: 'object', properties: { default: { type: 'string' } } },
        'Root',
      ),
    { name: 'ContractError', location: 'Root.properties.default' },
  );
});

void test('policy, component and HTTP schemas share one cumulative normalization budget', async () => {
  const schema = {
    type: 'integer',
    enum: Array.from({ length: 250_000 }, (_, index) => index),
  };
  await assert.rejects(
    compile(
      {
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
      },
      { clients: ['consumer'], surfaces: { consumer: ['value'] } },
    ),
    {
      name: 'ContractError',
      location: 'paths./value.post.requestBody.content.application/json.schema',
      message: /normalization work.*1000000 units/,
    },
  );
});

void test('ordinary large documents with distinct unused schemas keep the selected output unchanged', async () => {
  const input = document();
  const schemas: Record<string, Schema> = input.components.schemas;
  for (let index = 0; index < 4_000; index++) {
    const properties = Object.fromEntries(
      Array.from({ length: 50 }, (_, field) => [
        `field${field}`,
        {
          type: field % 4 ? 'string' : 'integer',
          description: 'masked annotation text',
        },
      ]),
    );
    schemas[`Entity${index}`] = {
      type: 'object',
      properties,
      required: ['field0'],
    };
  }
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 10 * 1024 * 1024);
  assert.deepEqual(
    await compile(input, selection),
    await compile(document(), selection),
  );
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

void test('cyclic schemas fail through the inline depth guard', async () => {
  const cycle: Schema = { type: 'array' };
  cycle.items = cycle;
  const input = document();
  Object.assign(input.components.schemas, { Cycle: cycle });
  await assert.rejects(compile(input, selection), (error) => {
    assert.ok(error instanceof ContractError);
    assert.ok(error.location.startsWith('components.schemas.Cycle'));
    assert.match(error.message, /schema nesting.*32/);
    return true;
  });
});

void test('source array holes cannot inherit declarations that escape normalization accounting', async () => {
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

void test('an unused shared graph rejects with a diagnostic before formatting', async (t) => {
  const root = await temporary(t);
  const probe = join(root, 'probe.mjs');
  await writeFile(
    probe,
    `
    import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';
    registerHooks({resolve(specifier,context,next){if(specifier==='oxfmt')return {shortCircuit:true,url:'data:text/javascript,export function format(){throw new Error("normalization must precede formatting")}'};return next(specifier,context)}});
    const {compile,ContractError}=await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
    let schema={type:'string'};
    for(let i=0;i<31;i++)schema={type:'object',properties:{left:schema,right:schema}};
    await assert.rejects(compile({openapi:'3.1.2',info:{title:'Synthetic work guard',version:'1'},paths:{},components:{schemas:{Flat:{type:'string'},Extreme:schema}}},${JSON.stringify(selection)}),error=>error instanceof ContractError&&/normalization work.*1000000 units/.test(error.message));
    console.log('bounded rejection');
  `,
  );
  const result = await exec(
    process.execPath,
    ['--max-old-space-size=256', probe],
    { timeout: 20_000 },
  );
  assert.equal(result.stdout, 'bounded rejection\n');
});

void test('excessive schema work and YAML expansion preserve outputs in generate and check modes', async (t) => {
  for (const extension of ['json', 'yaml']) {
    const root = await temporary(t);
    const config = join(root, 'pom.json');
    const input = join(root, `openapi.${extension}`);
    const output = join(root, 'generated');
    const serialize = extension === 'json' ? JSON.stringify : stringify;
    await writeFile(
      config,
      JSON.stringify({
        version: 2,
        openapi: `./openapi.${extension}`,
        output: './generated',
        ...selection,
      }),
    );
    const excessive = document();
    Object.assign(excessive.components.schemas, {
      Extreme:
        extension === 'json'
          ? {
              type: 'integer',
              enum: Array.from({ length: 1_000_000 }, (_, index) => index),
            }
          : graph(31),
    });
    const source = serialize(excessive);
    for (const existing of [false, true]) {
      if (existing) {
        await writeFile(input, serialize(document()));
        await runProject(config);
      }
      await writeFile(input, source);
      const snapshot = () => (existing ? fileSnapshot(output) : readdir(root));
      const before = await snapshot();
      for (const check of [false, true])
        await assert.rejects(runProject(config, { check }), (error) => {
          assert.ok(error instanceof ContractError);
          assert.match(
            error.message,
            /normalization work.*1000000 units|expanded document.*1000000 nodes/,
          );
          return true;
        });
      assert.deepEqual(await snapshot(), before);
    }
  }
});
