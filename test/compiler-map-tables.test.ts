import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import { buildDescriptor } from '../dist/descriptor.js';
import { normalizeFormats } from '../dist/schemas.js';
import { parseSelection } from '../dist/selection.js';
import {
  constraintRecord,
  hasConstraints,
  schemaNode,
} from '../dist/schema-node.js';
import { intersectConstraints } from '../dist/scalar-rules.js';
import type { Schema } from '../dist/model.js';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { object, ref } from './schema-helpers.ts';
import { infiniteFixture, infiniteSelection } from './infinite-fixture.ts';
import { offsetFixture, offsetSelection } from './offset-fixture.ts';

function expectMap(value: unknown): void {
  assert.ok(value instanceof Map);
}

// @ts-expect-error Normalized Schema requires the fixed slots for its kind.
void ({ kind: 'string' } satisfies Schema);

void test('container reference validation ignores inherited literal restrictions', async () => {
  const document = {
    openapi: '3.1.2',
    info: { title: 'Synthetic container aliases', version: '1' },
    paths: {},
    components: {
      schemas: {
        List: { type: 'array', items: { type: 'string' } },
        Record: object({ value: { type: 'string' } }),
        Dictionary: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        ListAlias: ref('List'),
        RecordAlias: ref('Record'),
        DictionaryAlias: ref('Dictionary'),
        Root: object({
          list: ref('ListAlias'),
          record: ref('RecordAlias'),
          dictionary: ref('DictionaryAlias'),
        }),
      },
    },
  };
  const options = {
    clients: [],
    standalone: { root: { schema: ref('Root').$ref, usage: 'request' } },
  } as const;
  const baseline = await compile(document, options);
  const previous = Object.getOwnPropertyDescriptor(
    Object.prototype,
    'literals',
  );
  try {
    for (const value of [[], ['inherited'], null, false]) {
      Object.defineProperty(Object.prototype, 'literals', {
        value,
        configurable: true,
        writable: true,
      });
      assert.deepEqual(await compile(document, options), baseline);
    }
  } finally {
    if (previous) Object.defineProperty(Object.prototype, 'literals', previous);
    else Reflect.deleteProperty(Object.prototype, 'literals');
  }
});

void test('normalized pagination dispatch ignores inherited fields from the other binding variant', async () => {
  for (const [document, options] of [
    [infiniteFixture(), infiniteSelection],
    [offsetFixture(), offsetSelection],
  ] as const) {
    const before = structuredClone(options);
    const baseline = await compile(document, options);
    for (const name of ['offset', 'cursor', 'kind']) {
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, name);
      Object.defineProperty(Object.prototype, name, {
        value: name === 'kind' ? 'offset' : 'after',
        configurable: true,
        writable: true,
      });
      try {
        assert.deepEqual(await compile(document, options), baseline, name);
      } finally {
        if (previous) Object.defineProperty(Object.prototype, name, previous);
        else Reflect.deleteProperty(Object.prototype, name);
      }
    }
    assert.deepEqual(options, before);
  }
});

void test('normalized fixed slots survive spreading and empty constraint merges under inherited defaults', () => {
  const inherited = {
    readOnly: true,
    writeOnly: true,
    minLength: 50,
    maxLength: 0,
    minItems: 50,
    maxItems: 0,
    pattern: '^never$',
    format: 'binary',
    literals: ['inherited'],
    sourceTypeArray: true,
    discriminator: { propertyName: 'inherited', mapping: new Map() },
    targets: { consumer: 'native' },
    queries: { consumer: ['read'] },
    infiniteQueries: {
      consumer: {
        read: { cursor: 'after', nextCursor: 'next', items: 'items' },
      },
    },
  };
  const previous = new Map(
    Object.keys(inherited).map(
      (name) =>
        [
          name,
          Object.getOwnPropertyDescriptor(Object.prototype, name),
        ] as const,
    ),
  );
  try {
    for (const [name, value] of Object.entries(inherited))
      Object.defineProperty(Object.prototype, name, {
        value,
        configurable: true,
        writable: true,
      });
    const string = schemaNode({ kind: 'string' });
    const array = schemaNode({ kind: 'array', items: string });
    const union = schemaNode({
      kind: 'union',
      branches: [string, schemaNode({ kind: 'null' })],
    });
    for (const [node, absent] of [
      [string, ['minLength', 'maxLength', 'pattern', 'format', 'literals']],
      [array, ['minItems', 'maxItems']],
      [union, ['sourceTypeArray', 'discriminator']],
    ] as const)
      for (const value of [node, { ...node }]) {
        assert.equal(Object.hasOwn(value, 'readOnly'), true);
        assert.equal(Object.hasOwn(value, 'writeOnly'), true);
        assert.equal(value.readOnly, false);
        assert.equal(value.writeOnly, false);
        for (const name of absent) {
          assert.equal(Object.hasOwn(value, name), true, name);
          assert.equal(Reflect.get(value, name), undefined, name);
        }
      }
    const empty = constraintRecord();
    assert.equal(Object.hasOwn(empty, 'minLength'), true);
    assert.ok(Object.keys(empty).length > 0);
    assert.equal(hasConstraints(empty), false);
    const base = constraintRecord({ minLength: 2, maxLength: 4 });
    const merged = intersectConstraints(base, { ...empty });
    assert.equal(merged.minLength, 2);
    assert.equal(merged.maxLength, 4);
    assert.equal(Object.hasOwn(merged, 'minimum'), true);
    assert.equal(merged.minimum, undefined);
    const selection = parseSelection({ clients: ['consumer'] });
    assert.equal(selection.targets.size, 0);
    assert.equal(selection.queries.size, 0);
    assert.equal(selection.infiniteQueries.size, 0);
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(Object.prototype, name, descriptor);
      else Reflect.deleteProperty(Object.prototype, name);
    }
  }
});

void test('schema/property/discriminator maps preserve named keys, missing references and numeric field order', async (t) => {
  const document = {
    openapi: '3.1.2',
    info: { title: 'Synthetic compiler map dictionaries', version: '1' },
    paths: {},
    components: {
      schemas: {
        toString: { type: 'string', enum: ['leaf'] },
        A: object({ kind: { type: 'string', const: 'toString' } }),
        B: object({ kind: { type: 'string', const: 'valueOf' } }),
        Choice: {
          oneOf: [ref('A'), ref('B')],
          discriminator: {
            propertyName: 'kind',
            mapping: { toString: ref('A').$ref, valueOf: ref('B').$ref },
          },
        },
        Root: object({
          '10': ref('toString'),
          '2': ref('toString'),
          alpha: ref('toString'),
          choice: ref('Choice'),
        }),
      },
    },
  };
  const descriptor = buildDescriptor(document);
  expectMap(descriptor.schemas.request);
  expectMap(descriptor.schemas.response);
  assert.equal(descriptor.schemas.request.get('hasOwnProperty'), undefined);
  assert.equal(descriptor.schemas.request.has('hasOwnProperty'), false);
  const rootSchema = present(descriptor.schemas.request.get('Root'));
  assert.ok(rootSchema.kind === 'object');
  expectMap(rootSchema.properties);
  assert.deepEqual(
    [...rootSchema.properties.keys()],
    ['2', '10', 'alpha', 'choice'],
  );
  assert.equal(rootSchema.properties.get('toString'), undefined);
  const choice = present(descriptor.schemas.request.get('Choice'));
  assert.ok(choice.kind === 'union' && choice.discriminator);
  expectMap(choice.discriminator.mapping);
  // Tags select branch positions; each position holds its mapped reference.
  for (const [tag, name] of [
    ['toString', 'A'],
    ['valueOf', 'B'],
  ] as const) {
    const branch: Schema | undefined =
      choice.branches[present(choice.discriminator.mapping.get(tag))];
    assert.ok(branch?.kind === 'ref');
    assert.equal(branch.name, name);
  }
  assert.equal(choice.discriminator.mapping.get('hasOwnProperty'), undefined);
  const formats = normalizeFormats({
    toString: { type: 'string', pattern: '^a' },
  });
  expectMap(formats);
  assert.equal(formats.get('toString')?.name, 'toString');
  assert.equal(formats.get('hasOwnProperty'), undefined);
  assert.throws(
    () => buildDescriptor(document, { surfaces: undefined }),
    (error) =>
      error instanceof ContractError &&
      error.location === 'surfaces' &&
      /expected an object/.test(error.message),
  );
  const files = await compile(document, {
    clients: [],
    standalone: { root: { schema: ref('Root').$ref, usage: 'request' } },
  });
  const root = await generatedTestWorkspace(t, files);
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.root.ts',
  );
  const input = {
    '2': 'leaf',
    '10': 'leaf',
    alpha: 'leaf',
    choice: { kind: 'toString' },
  };
  assert.deepEqual(schema.parse(input), input);
  assert.equal(
    schema.safeParse({ ...input, choice: { kind: 'hasOwnProperty' } }).success,
    false,
  );
  const invalid = schema.safeParse({
    '2': 2,
    '10': 10,
    alpha: 1,
    choice: { kind: 'toString' },
  });
  assert.equal(invalid.success, false);
  if (!invalid.success)
    assert.deepEqual(
      invalid.error.issues.map((issue) => issue.path),
      [['2'], ['10'], ['alpha']],
    );
  Object.assign(document.components.schemas, {
    Missing: ref('hasOwnProperty'),
  });
  assert.throws(
    () => buildDescriptor(document),
    (error) =>
      error instanceof ContractError &&
      error.location === 'components.schemas.Missing.$ref' &&
      /unresolved reference hasOwnProperty/.test(error.message),
  );
});

void test('normalized selection, memberships, policy and response content use maps while generated values stay objects', async (t) => {
  const document = {
    openapi: '3.1.2',
    info: { title: 'Synthetic named compiler tables', version: '1' },
    'x-pom-policy': {
      version: 3,
      auth: { toString: { transport: 'none' } },
      fields: {
        priority: { type: 'string', enum: ['low'] },
        '10': { type: 'string' },
        '2': { type: 'boolean' },
      },
      required: ['auth', 'priority', '10', '2'],
    },
    components: {
      schemas: {
        Page: object({
          next: { type: ['string', 'null'] },
          items: { type: 'array', items: { type: 'string' } },
        }),
      },
    },
    paths: {
      '/items': {
        get: {
          operationId: 'read',
          'x-pom': {
            auth: 'toString',
            priority: 'low',
            '10': 'ten',
            '2': false,
          },
          parameters: [
            { name: 'after', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'Synthetic page',
              content: { 'application/json': { schema: ref('Page') } },
            },
          },
        },
      },
    },
  };
  const options = {
    clients: ['constructor'],
    surfaces: { constructor: ['read'] },
    targets: { constructor: 'native' },
    queries: { constructor: ['read'] },
    infiniteQueries: {
      constructor: {
        read: { cursor: 'after', nextCursor: 'next', items: 'items' },
      },
    },
  } as const;
  const selection = parseSelection(options);
  expectMap(selection.targets);
  expectMap(selection.queries);
  expectMap(selection.infiniteQueries);
  assert.equal(selection.targets.get('constructor'), 'native');
  assert.equal(selection.targets.get('toString'), undefined);
  assert.deepEqual(selection.queries.get('constructor'), ['read']);
  assert.equal(selection.queries.get('toString'), undefined);
  const bindings = present(selection.infiniteQueries.get('constructor'));
  expectMap(bindings);
  assert.equal(bindings.get('toString'), undefined);
  assert.deepEqual(bindings.get('read'), {
    kind: 'cursor',
    cursor: 'after',
    nextCursor: 'next',
    items: 'items',
  });
  const numericBindings = parseSelection({
    clients: ['consumer'],
    infiniteQueries: {
      consumer: {
        '10': { cursor: 'after', nextCursor: 'next', items: 'items' },
        '2': { cursor: 'after', nextCursor: 'next', items: 'items' },
      },
    },
  });
  assert.deepEqual(
    [...present(numericBindings.infiniteQueries.get('consumer')).keys()],
    ['2', '10'],
  );
  const descriptor = buildDescriptor(document, { surfaces: options.surfaces });
  expectMap(descriptor.policy.auth);
  expectMap(descriptor.policy.fields);
  assert.deepEqual(
    [...descriptor.policy.fields.keys()],
    ['2', '10', 'auth', 'priority'],
  );
  assert.equal(descriptor.policy.auth.get('toString'), 'none');
  assert.equal(descriptor.policy.auth.get('valueOf'), undefined);
  assert.equal(descriptor.policy.fields.get('valueOf'), undefined);
  const operation = present(descriptor.operations[0]);
  expectMap(operation.policy);
  assert.equal(operation.policy.get('auth'), 'toString');
  assert.equal(operation.policy.get('priority'), 'low');
  assert.equal(operation.policy.get('toString'), undefined);
  const response = present(operation.responses[0]);
  assert.ok(response.body.kind === 'content');
  expectMap(response.body.content);
  assert.equal(response.body.content.get('toString'), undefined);
  assert.equal(response.body.content.get('application/json')?.kind, 'json');
  const files = await compile(document, options);
  const root = await generatedTestWorkspace(t, files);
  const { operations } = await importGenerated<RuntimeClient>(
    root,
    'client.constructor.ts',
  );
  const prepared = present(operations.read).build({});
  assert.equal(prepared.policy instanceof Map, false);
  assert.deepEqual(
    { ...prepared.policy },
    {
      '2': false,
      '10': 'ten',
      auth: 'toString',
      priority: 'low',
    },
  );
  assert.equal(prepared.url, '/items');
  const observed = prepared.parseResponse({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"next":null,"items":["a"]}',
  });
  assert.equal(observed.kind, 'success');
  if (observed.kind === 'success')
    assert.deepEqual(observed.data, { next: null, items: ['a'] });
});
