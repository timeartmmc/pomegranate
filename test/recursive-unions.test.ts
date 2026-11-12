import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compile } from '../dist/index.js';
import { record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { object, ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

async function generated(
  t: TestContext,
  schemas: Record<string, Schema>,
  name = 'Node',
) {
  const root = await generatedTestWorkspace(
    t,
    await compile(
      {
        openapi: '3.1.2',
        info: { title: 'Synthetic recursive union isolation', version: '1' },
        paths: {},
        components: { schemas },
      },
      {
        clients: [],
        standalone: {
          request: { schema: ref(name).$ref, usage: 'request' },
          response: { schema: ref(name).$ref, usage: 'response' },
        },
      },
    ),
  );
  const load = async (name: string) =>
    (await importGenerated<StandaloneModule>(root, `standalone.${name}.ts`))
      .schema;
  return { request: await load('request'), response: await load('response') };
}

const lateSchemas: Record<string, Schema> = {
  ...Object.fromEntries(
    ['a', 'b', 'c', 'd'].map((tag) => [
      tag,
      object(
        {
          kids: { type: 'array', items: ref('Node') },
          z: object({ tag: { const: tag } }),
          left: ref('Node'),
          right: ref('Node'),
          byId: { type: 'object', additionalProperties: ref('Node') },
        },
        ['kids', 'z'],
      ),
    ]),
  ),
  Node: { anyOf: ['a', 'b', 'c', 'd'].map(ref) },
};
const node = (kids: unknown[] = []) => ({ kids, z: { tag: 'd' } });

// Check the observable ownership guarantee across all positions, including
// containers that were already parsed during a rejected alternative.
function independent(input: unknown, output: unknown) {
  const sources = new Set<object>();
  function gather(value: unknown) {
    if (value === null || typeof value !== 'object' || sources.has(value))
      return;
    sources.add(value);
    for (const child of Object.values(value)) gather(child);
  }
  gather(input);
  const outputs = new Set<object>();
  function visit(value: unknown) {
    if (value === null || typeof value !== 'object') return;
    assert.ok(!sources.has(value), 'output retains caller data');
    assert.ok(!outputs.has(value), 'different positions share mutable output');
    outputs.add(value);
    for (const child of Object.values(value)) visit(child);
  }
  visit(output);
}

void test('late recursive branch selection fits the work allowance and detaches fields, arrays and maps', async (t) => {
  const { request, response } = await generated(t, lateSchemas);
  const tree = (depth: number): unknown =>
    node(depth ? [tree(depth - 1), tree(depth - 1)] : []);
  const input = tree(9);
  for (const schema of [request, response]) {
    const output = schema.parse(input);
    assert.deepEqual(output, input);
    independent(input, output);
    const shared = node([node()]);
    const pair = {
      ...node([shared, shared]),
      left: shared,
      right: shared,
      byId: { a: shared, b: shared },
    };
    const parsed = record(schema.parse(pair));
    assert.deepEqual(parsed, pair);
    independent(pair, parsed);
    record(record(parsed.left).z).tag = 'changed';
    assert.deepEqual(parsed.right, shared);
    assert.deepEqual(schema.parse(pair), pair);
  }
});

void test('different unions at the same occurrence retain their own directional projection', async (t) => {
  const id = object({ id: { type: 'integer' }, next: ref('Node') }, ['id']);
  const value = object({ value: { type: 'integer' }, next: ref('Node') }, [
    'value',
  ]);
  const envelope = (child: string, tag: string) =>
    object(
      {
        child: ref(child),
        z: object({ tag: { const: tag } }),
        id: { type: 'string', readOnly: true },
        secret: { type: 'string', writeOnly: true },
      },
      ['child', 'z', 'id', 'secret'],
    );
  const { request, response } = await generated(t, {
    A: id,
    B: value,
    UA: { anyOf: [ref('A'), object({ text: { type: 'string' } })] },
    UB: { anyOf: [ref('B'), object({ enabled: { type: 'boolean' } })] },
    PA: envelope('UA', 'a'),
    PB: envelope('UB', 'b'),
    Node: { anyOf: [ref('PA'), ref('PB')] },
  });
  const input = {
    id: 'public',
    secret: 'private',
    child: { id: 1, value: 2 },
    z: { tag: 'b' },
  };
  assert.deepEqual(response.parse(input), {
    id: 'public',
    child: { value: 2 },
    z: { tag: 'b' },
  });
  input.z.tag = 'a';
  assert.deepEqual(response.parse(input), {
    id: 'public',
    child: { id: 1 },
    z: { tag: 'a' },
  });
  const sent = { secret: 'private', child: { value: 2 }, z: { tag: 'b' } };
  assert.deepEqual(request.parse(sent), sent);
});

void test('speculative required scalars use one field capture and reject before child reads', async (t) => {
  const branch = (kind: string) =>
    object({
      children: { type: 'array', items: ref('Node') },
      kind: { const: kind },
      scalar: {
        anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }],
      },
      label: {
        allOf: [
          { type: 'string', pattern: '^a' },
          { type: 'string', pattern: 'z$' },
        ],
      },
    });
  const { response } = await generated(t, {
    Node: { anyOf: [branch('and'), branch('or')] },
  });
  let reads = 0;
  const input = {
    children: [],
    scalar: null,
    label: 'az',
    get kind() {
      reads++;
      return 'and';
    },
  };
  assert.deepEqual(response.parse(input), {
    children: [],
    kind: 'and',
    scalar: null,
    label: 'az',
  });
  assert.equal(reads, 1);
  const failure = response.safeParse({
    kind: 'and',
    scalar: null,
    label: 'invalid',
    get children(): unknown {
      throw new Error('must reject the scalar first');
    },
  });
  assert.equal(failure.success, false);
  if (!failure.success)
    assert.ok(
      failure.error.issues.some(
        ({ path, message }) => path[0] === 'label' && /pattern/.test(message),
      ),
    );
  const mixed = response.safeParse({
    kind: 'and',
    scalar: false,
    label: 'az',
    get children(): unknown {
      throw new Error('must reject the scalar union first');
    },
  });
  assert.equal(mixed.success, false);
  if (!mixed.success)
    assert.ok(mixed.error.issues.some(({ path }) => path[0] === 'scalar'));
});

void test('shared union children are checked at each depth and against the active ancestors', async (t) => {
  const shared = { value: 1, next: { value: 2 } };
  function chain(length: number, tail: unknown): unknown {
    let result = tail;
    for (let i = 0; i < length; i++) result = { value: i, next: result };
    return result;
  }
  // Cache the shared value shallowly before reaching it on a deeper path.
  const { response: pair } = await generated(
    t,
    {
      Node: {
        anyOf: [
          object({ next: ref('Node'), value: { type: 'integer' } }, ['value']),
          { type: 'null' },
          { type: 'string' },
        ],
      },
      Pair: object({ shallow: ref('Node'), deep: ref('Node') }),
    },
    'Pair',
  );
  const valid = { shallow: shared, deep: chain(125, shared) };
  const output = pair.parse(valid);
  assert.deepEqual(output, valid);
  independent(valid, output);
  const failure = pair.safeParse({ shallow: shared, deep: chain(126, shared) });
  assert.equal(failure.success, false);
  if (!failure.success)
    assert.match(failure.error.issues[0]?.message ?? '', /depth exceeds 128/);
  const cycle: Record<string, unknown> = { value: 1 };
  cycle.next = cycle;
  const cyclic = pair.safeParse({ shallow: shared, deep: cycle });
  assert.equal(cyclic.success, false);
  if (!cyclic.success)
    assert.match(cyclic.error.issues[0]?.message ?? '', /cyclic input/);
  assert.deepEqual(pair.parse({ shallow: shared, deep: shared }), {
    shallow: shared,
    deep: shared,
  });
});

void test('recursive union state is isolated across reentrant calls, exceptions and later input changes', async (t) => {
  const { response } = await generated(t, lateSchemas);
  let inner: unknown;
  const child = node();
  const reentrant = {
    ...node(),
    get left() {
      inner = response.parse(node());
      return child;
    },
  };
  const output = response.parse(reentrant);
  assert.deepEqual(inner, node());
  independent(reentrant, output);
  const exception = {
    ...node(),
    get left(): unknown {
      throw new Error('synthetic accessor');
    },
  };
  assert.throws(() => response.parse(exception), /synthetic accessor/);
  const input = node();
  assert.deepEqual(response.parse(input), input);
  input.z.tag = 'bad';
  const failure = response.safeParse(input);
  assert.equal(failure.success, false);
  if (!failure.success)
    assert.ok(
      failure.error.issues.some(
        ({ path, message }) =>
          path.join('.') === 'z.tag' && /expected/.test(message),
      ),
    );
  input.z.tag = 'd';
  assert.deepEqual(response.parse(input), input);
});

void test('nested union mismatches retain their path while committed objects collect sibling diagnostics', async (t) => {
  const { response } = await generated(t, lateSchemas);
  const leaf = node();
  leaf.z.tag = 'invalid';
  const bad = node([node([leaf])]);
  const failure = response.safeParse(bad);
  assert.equal(failure.success, false);
  if (!failure.success)
    assert.ok(
      failure.error.issues.some(
        ({ path, message }) =>
          path.join('.') === 'kids.0.kids.0.z.tag' && /expected/.test(message),
      ),
    );
  const { request: committed } = await generated(t, {
    Node: object(
      {
        child: ref('Node'),
        count: { type: 'integer' },
        title: { type: 'string', minLength: 2 },
      },
      ['count', 'title'],
    ),
  });
  const errors = committed.safeParse({ count: 1.5, title: '', extra: true });
  assert.equal(errors.success, false);
  if (!errors.success)
    assert.deepEqual(errors.error.issues, [
      { path: ['count'], message: 'expected an integer' },
      { path: ['title'], message: 'string is too short' },
      { path: [], message: 'unrecognized key: "extra"' },
    ]);
});

void test('shared array and map union values retain separate outputs and scalar values', async (t) => {
  const { request, response } = await generated(t, {
    Node: {
      anyOf: [
        { type: 'array', maxItems: 0, items: ref('Node') },
        { type: 'array', items: ref('Node') },
        { type: 'object', additionalProperties: ref('Node') },
        { type: 'integer' },
      ],
    },
  });
  const array = [0, -0, { value: 3 }];
  const map = { items: array };
  const input = { a: array, b: array, c: map, d: map };
  for (const schema of [request, response]) {
    const output = schema.parse(input);
    assert.deepEqual(output, input);
    independent(input, output);
  }
});

void test('wide speculative objects check required scalars before every child', async (t) => {
  const fillers = Object.fromEntries(
    Array.from({ length: 129 }, (_, i) => [`field${i}`, { type: 'string' }]),
  );
  const { response } = await generated(t, {
    A: object({ aChild: ref('Node'), ...fillers, zKind: { const: 'a' } }, [
      'zKind',
    ]),
    B: object({ zKind: { const: 'b' } }),
    Node: { anyOf: [ref('A'), ref('B')] },
  });
  const input: Record<string, unknown> = { zKind: 'b' };
  input.aChild = input;
  assert.deepEqual(response.parse(input), { zKind: 'b' });
  const cyclic: Record<string, unknown> = { zKind: 'a' };
  cyclic.aChild = cyclic;
  const invalid = response.safeParse(cyclic);
  assert.equal(invalid.success, false);
  if (!invalid.success)
    assert.match(invalid.error.issues[0]?.message ?? '', /cyclic input/);
});

void test('stable own, inherited and class getters retain independent shared-value outputs', async (t) => {
  const { request, response } = await generated(
    t,
    {
      Number: object({ value: { type: 'number' }, next: ref('Node') }, [
        'value',
      ]),
      String: object({ value: { type: 'string' }, next: ref('Node') }, [
        'value',
      ]),
      Node: { anyOf: [ref('Number'), ref('String')] },
      Pair: object({ left: ref('Node'), right: ref('Node') }),
    },
    'Pair',
  );
  for (const value of [1, 'stable']) {
    const source = {
      get value() {
        return value;
      },
    };
    class StableValue {
      get value() {
        return value;
      }
    }
    const sources: unknown[] = [
      source,
      Object.create(source),
      new StableValue(),
    ];
    for (const schema of [request, response]) {
      for (const shared of sources) {
        const input = { left: shared, right: shared };
        const output = schema.parse(input);
        assert.deepEqual(output, { left: { value }, right: { value } });
        independent(input, output);
      }
    }
  }
});

void test('recursive union cache slots ignore inherited cache-shaped data', async (t) => {
  const { response } = await generated(t, lateSchemas);
  const input = node([node(), node([node()])]);
  for (const key of ['children', 'outputs', 'selections']) {
    await t.test(key, () => {
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
      let output: unknown;
      try {
        const inherited = {
          __proto__: null,
          value: {},
          configurable: true,
        };
        Object.defineProperty(Object.prototype, key, inherited);
        output = response.parse(input);
      } finally {
        if (previous) {
          const restore = { __proto__: null, ...previous };
          Object.defineProperty(Object.prototype, key, restore);
        } else Reflect.deleteProperty(Object.prototype, key);
      }
      assert.deepEqual(output, input);
      independent(input, output);
    });
  }
});
