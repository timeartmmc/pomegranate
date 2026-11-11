import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { identifier } from '../dist/code.js';
import { schemaRenderer } from '../dist/emit-schema.js';
import { parseSymbol, schemaType } from '../dist/schema-types.js';
import type { Schema as NormalizedSchema } from '../dist/model.js';
import {
  normalizeSchema,
  orderSchemas,
  schemaValidation,
  validateSchema,
} from '../dist/schemas.js';
import type { Validator } from '../src/runtime.ts';
import { entry, present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

function fixture(
  schemas: Record<string, Schema>,
  operations: readonly { name: string; schema: Schema }[],
) {
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic scalar reference regressions', version: '1' },
    components: { schemas },
    paths: Object.fromEntries(
      operations.map(({ name, schema }) => {
        const content = { 'application/json': { schema } };
        return [
          `/${name}`,
          {
            post: {
              operationId: name,
              requestBody: { required: true, content },
              responses: { 200: { description: 'Synthetic value', content } },
            },
          },
        ];
      }),
    ),
  };
}

function response(value: unknown) {
  const body = JSON.stringify(value);
  assert.ok(body !== undefined);
  return { status: 200, headers: { 'content-type': 'application/json' }, body };
}

void test('scalar rule caches preserve inner rules regardless of outer-first or inner-first generation', async (t) => {
  for (const outerFirst of [true, false]) {
    const outerName = outerFirst ? 'a-outer' : 'z-outer';
    const innerName = outerFirst ? 'z-inner' : 'a-inner';
    const schemas = {
      Base: { type: 'string', pattern: '^a' },
      Middle: { ...ref('Base'), minLength: 3, pattern: 'b$' },
      Outer: { ...ref('Middle'), minLength: 4, pattern: '^aa' },
    };
    const operations = [
      { name: outerName, schema: { ...ref('Outer'), maxLength: 8 } },
      { name: innerName, schema: { ...ref('Middle'), maxLength: 7 } },
    ];
    // Operation parsers use a separate renderer from the component registry.
    // Inline refinements force its first encounter to walk the component chain.
    const root = await generatedTestWorkspace(
      t,
      await compile(fixture(schemas, operations), {
        clients: ['consumer'],
        surfaces: { consumer: operations.map(({ name }) => name) },
      }),
    );
    const { operations: generated } = await importGenerated<RuntimeClient>(
      root,
      'client.consumer.ts',
    );
    const outer = entry(generated, outerName);
    const inner = entry(generated, innerName);
    for (const [operation, accepted, rejected] of [
      [outer, 'aaab', ['abbb', 'aab', 'aaac']],
      [inner, 'abbb', ['ab', 'aaac']],
    ] as const) {
      assert.equal(operation.build({ body: accepted }).body, accepted);
      assert.equal(operation.parseResponse(response(accepted)).kind, 'success');
      for (const value of rejected) {
        assert.throws(() => operation.build({ body: value }));
        assert.equal(operation.parseResponse(response(value)).kind, 'protocol');
      }
    }
  }
});

void test('reference validation caches retain zero bounds and independent enum candidates in either order', () => {
  const input = {
    Number: { type: 'number', minimum: -5, maximum: 5 },
    Nonpositive: { ...ref('Number'), maximum: 0 },
    Impossible: { ...ref('Nonpositive'), minimum: 1 },
    Enum: { type: 'string', enum: ['ab', 'abc', 'abb', 'xxc'] },
    Middle: { ...ref('Enum'), minLength: 3, pattern: '^a' },
    EndsC: { ...ref('Middle'), pattern: 'c$' },
    EndsB: { ...ref('Middle'), pattern: 'b$' },
  };
  const schemas = new Map(
    Object.entries(input).map(([name, schema]) => [
      name,
      normalizeSchema(schema, name),
    ]),
  );
  orderSchemas(schemas);
  for (const warmInner of [false, true]) {
    const cache = schemaValidation();
    if (warmInner)
      validateSchema(
        schemas.get('Nonpositive')!,
        schemas,
        'Nonpositive',
        'component',
        cache,
      );
    assert.throws(
      () =>
        validateSchema(
          schemas.get('Impossible')!,
          schemas,
          'Impossible',
          'component',
          cache,
        ),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.equal(error.location, 'Impossible');
        assert.match(error.message, /bounds admit no finite number/);
        return true;
      },
    );
  }
  for (const order of [
    ['EndsC', 'EndsB'],
    ['EndsB', 'EndsC'],
  ]) {
    const cache = schemaValidation();
    for (const name of order)
      assert.doesNotThrow(() =>
        validateSchema(schemas.get(name)!, schemas, name, 'component', cache),
      );
  }
});

const zeroCases: readonly {
  name: string;
  base: Schema;
  limits: Schema;
  accepted: unknown;
  rejected: unknown;
}[] = [
  {
    name: 'text',
    base: { type: 'string', maxLength: 8 },
    limits: { maxLength: 0 },
    accepted: '',
    rejected: 'a',
  },
  {
    name: 'minimum',
    base: { type: 'number', minimum: -8 },
    limits: { minimum: 0 },
    accepted: 0,
    rejected: -1,
  },
  {
    name: 'maximum',
    base: { type: 'number', maximum: 8 },
    limits: { maximum: 0 },
    accepted: 0,
    rejected: 1,
  },
  {
    name: 'exclusive-minimum',
    base: { type: 'number', exclusiveMinimum: -8 },
    limits: { exclusiveMinimum: 0 },
    accepted: 1,
    rejected: 0,
  },
  {
    name: 'exclusive-maximum',
    base: { type: 'number', exclusiveMaximum: 8 },
    limits: { exclusiveMaximum: 0 },
    accepted: -1,
    rejected: 0,
  },
  {
    name: 'items',
    base: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    limits: { maxItems: 0 },
    accepted: [],
    rejected: ['a'],
  },
  {
    name: 'map',
    base: {
      type: 'object',
      additionalProperties: { type: 'string' },
      maxProperties: 8,
    },
    limits: { maxProperties: 0 },
    accepted: {},
    rejected: { a: 'a' },
  },
  {
    name: 'fixed',
    base: {
      type: 'object',
      properties: { a: { type: 'string' } },
      maxProperties: 8,
    },
    limits: { maxProperties: 0 },
    accepted: {},
    rejected: { a: 'a' },
  },
];

void test('zero reference constraints survive standalone, registry, request and response boundaries', async (t) => {
  const schemas: Record<string, Schema> = {};
  const operations = zeroCases.map(({ name, base, limits }) => {
    schemas[`${name}-base`] = base;
    schemas[name] = { ...ref(`${name}-base`), ...limits };
    return { name, schema: ref(name) };
  });
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(schemas, operations), {
      clients: ['consumer'],
      surfaces: { consumer: operations.map(({ name }) => name) },
      standalone: Object.fromEntries(
        zeroCases.flatMap(({ name }) =>
          (['request', 'response'] as const).map((usage) => [
            `${name}-${usage}`,
            { schema: ref(name).$ref, usage },
          ]),
        ),
      ),
    }),
  );
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const registry = await importGenerated<{
    requestSchemas: Record<string, Validator<unknown>>;
    responseSchemas: Record<string, Validator<unknown>>;
  }>(root, 'client.consumer.schemas.ts');
  for (const { name, accepted, rejected } of zeroCases) {
    for (const usage of ['request', 'response'] as const) {
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        `standalone.${name}-${usage}.ts`,
      );
      for (const validator of [
        schema,
        entry(registry[`${usage}Schemas`], name),
      ]) {
        assert.deepEqual(validator.parse(accepted), accepted);
        assert.equal(
          validator.safeParse(rejected).success,
          false,
          `${name} ${usage}`,
        );
      }
    }
    const operation = entry(client.operations, name);
    assert.deepEqual(operation.build({ body: accepted }).body, accepted);
    assert.throws(() => operation.build({ body: rejected }));
    assert.equal(operation.parseResponse(response(accepted)).kind, 'success');
    assert.equal(operation.parseResponse(response(rejected)).kind, 'protocol');
  }
  // Response fixed objects must count raw members before stripping extras.
  assert.equal(
    entry(client.operations, 'fixed').parseResponse(response({ ignored: 'a' }))
      .kind,
    'protocol',
  );
});

void test('tightest reference maxLength guards all regexes when weaker bounds compete', async (t) => {
  const fixtures = [];
  for (const [index, limits] of [
    [2, 8, 5],
    [8, 2, 5],
    [8, 5, 2],
    [8, 0, 5],
  ].entries()) {
    const pattern = `(?<scalarAliasGuard${index}>a|😀)*`;
    const operations = [
      { name: 'bounded', schema: { ...ref('Outer'), maxLength: 13 } },
    ];
    const schemas = {
      Base: { type: 'string', pattern, format: 'probe', maxLength: limits[0] },
      Middle: { ...ref('Base'), pattern, maxLength: limits[1] },
      Outer: { ...ref('Middle'), pattern, maxLength: limits[2] },
    };
    const root = await generatedTestWorkspace(
      t,
      await compile(fixture(schemas, operations), {
        clients: ['consumer'],
        surfaces: { consumer: ['bounded'] },
        formats: { probe: { type: 'string', pattern } },
        standalone: {
          request: { schema: ref('Outer').$ref, usage: 'request' },
          response: { schema: ref('Outer').$ref, usage: 'response' },
        },
      }),
    );
    const request = await importGenerated<StandaloneModule>(
      root,
      'standalone.request.ts',
    );
    const responseSchema = await importGenerated<StandaloneModule>(
      root,
      'standalone.response.ts',
    );
    const client = await importGenerated<RuntimeClient>(
      root,
      'client.consumer.ts',
    );
    fixtures.push({
      limit: Math.min(...limits),
      validators: [request.schema, responseSchema.schema],
      operation: entry(client.operations, 'bounded'),
    });
  }
  // oxlint-disable-next-line typescript/unbound-method -- Invoke the saved intrinsic with each original RegExp receiver below.
  const original = RegExp.prototype.test;
  let limit = 0;
  let calls = 0;
  t.mock.method(
    RegExp.prototype,
    'test',
    function (this: RegExp, value: string) {
      if (this.source.includes('scalarAliasGuard')) {
        calls++;
        assert.ok(
          Array.from(value).length <= limit,
          'oversized value reached an alias regex',
        );
      }
      return original.call(this, value);
    },
  );
  for (const current of fixtures) {
    limit = current.limit;
    const before = calls;
    for (const value of ['aaa', '😀😀😀', 'a'.repeat(100_000)]) {
      for (const schema of current.validators) {
        const result = schema.safeParse(value);
        assert.equal(result.success, false);
        if (!result.success)
          assert.deepEqual(result.error.issues, [
            { path: [], message: 'string is too long' },
          ]);
      }
      assert.throws(() => current.operation.build({ body: value }));
      assert.equal(
        current.operation.parseResponse(response(value)).kind,
        'protocol',
      );
    }
    assert.equal(calls, before);
    const accepted = limit === 0 ? '' : 'a😀';
    for (const schema of current.validators)
      assert.equal(schema.parse(accepted), accepted);
    assert.equal(current.operation.build({ body: accepted }).body, accepted);
    assert.equal(
      current.operation.parseResponse(response(accepted)).kind,
      'success',
    );
    assert.ok(
      calls > before,
      'bounded values still exercise their patterns and formats',
    );
  }
});

void test('shared terminal and constrained sources preserve JSON and YAML generated bytes', async () => {
  const terminal = { type: 'string', pattern: '^a' };
  const constrained = { ...ref('Alpha'), minLength: 2, pattern: 'b$' };
  const inline = { ...ref('Beta'), maxLength: 4 };
  const schemas = {
    Alpha: terminal,
    Beta: terminal,
    AlphaBound: constrained,
    BetaBound: constrained,
    Root: {
      type: 'object',
      properties: {
        first: inline,
        second: inline,
        alpha: ref('AlphaBound'),
        beta: ref('BetaBound'),
      },
      required: ['first', 'second', 'alpha', 'beta'],
    },
  };
  const operations = [
    { name: 'a-root', schema: ref('Root') },
    { name: 'b-inline', schema: inline },
    { name: 'c-inline', schema: inline },
  ];
  const document = fixture(schemas, operations);
  const options = {
    clients: ['consumer'],
    surfaces: { consumer: operations.map(({ name }) => name) },
    standalone: {
      root: { schema: ref('Root').$ref, usage: 'request' as const },
    },
  };
  const duplicate: unknown = JSON.parse(JSON.stringify(document));
  const expected = await compile(duplicate, options);
  assert.deepEqual(await compile(document, options), expected);
  assert.deepEqual(
    await compile(parseYaml(stringify(document), 'shared.yaml'), options),
    expected,
  );
});

void test('parser bindings own their scalar cache entries even when normalized nodes are shared', () => {
  function render(shared: boolean): string {
    const terminal = () =>
      normalizeSchema({ type: 'string', pattern: '^a' }, 'terminal');
    const alias = () =>
      normalizeSchema(
        { ...ref('Alpha'), minLength: 2, pattern: 'b$' },
        'alias',
      );
    const inline = { ...ref('Beta'), maxLength: 4 };
    const first = terminal();
    const constrained = alias();
    const root = normalizeSchema(
      { type: 'object', properties: { first: inline, second: inline } },
      'root',
    );
    assert.ok(root.kind === 'object');
    const properties = new Map(root.properties);
    if (shared) properties.set('second', present(properties.get('first')));
    const schemas = new Map<string, NormalizedSchema>([
      ['Alpha', first],
      ['Beta', shared ? first : terminal()],
      ['AlphaBound', constrained],
      ['BetaBound', shared ? constrained : alias()],
      ['Root', { ...root, properties }],
    ]);
    const renderer = schemaRenderer(
      { request: schemas, response: schemas },
      (name, direction) => identifier(parseSymbol(name, direction)),
      (schema, direction) => schemaType(schema, direction),
    );
    for (const direction of ['request', 'response'] as const)
      for (const name of orderSchemas(schemas)) {
        const schema = schemas.get(name)!;
        const symbol = parseSymbol(name, direction);
        renderer.define(
          schema,
          direction,
          name,
          symbol,
          symbol,
          schemaType(schema, direction),
          false,
        );
      }
    return renderer.takeDeclarations();
  }
  assert.equal(render(true), render(false));
});
