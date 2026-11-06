import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const leaf = { type: 'string', minLength: 1 };
const array = { type: 'array', items: leaf };
const fixed = (width: number, required = true): Schema => {
  const properties = Object.fromEntries(
    Array.from({ length: width }, (_, index) => [field(index), array]),
  );
  return {
    type: 'object',
    properties,
    required: required ? Object.keys(properties) : [],
  };
};
function field(index: number): string {
  return `field${String(index).padStart(3, '0')}`;
}
const definitions: Record<string, Schema> = {
  Array: array,
  TypedArray: { type: 'array', items: { type: 'string' } },
  Map: { type: 'object', additionalProperties: leaf },
  NestedArray: { type: 'array', items: array },
  MapArray: { type: 'object', additionalProperties: array },
  Fixed: fixed(3),
  Optional: fixed(3, false),
  Wide: fixed(257),
  Nullable: {
    anyOf: [{ $ref: '#/components/schemas/Fixed' }, { type: 'null' }],
  },
  BranchA: {
    type: 'object',
    properties: { kind: { type: 'string', const: 'a' }, values: array },
    required: ['kind', 'values'],
  },
  BranchB: {
    type: 'object',
    properties: { kind: { type: 'string', const: 'b' } },
    required: ['kind'],
  },
  Tagged: {
    oneOf: [
      { $ref: '#/components/schemas/BranchA' },
      { $ref: '#/components/schemas/BranchB' },
    ],
    discriminator: {
      propertyName: 'kind',
      mapping: {
        a: '#/components/schemas/BranchA',
        b: '#/components/schemas/BranchB',
      },
    },
  },
  RefinedArray: { $ref: '#/components/schemas/Array', minItems: 0 },
  RefinedMap: { $ref: '#/components/schemas/Map', minProperties: 0 },
};
const forms = [
  'Array',
  'Map',
  'NestedArray',
  'MapArray',
  'Fixed',
  'Optional',
  'Wide',
  'Nullable',
  'Tagged',
  'RefinedArray',
  'RefinedMap',
] as const;
type Form = (typeof forms)[number];
type Path = readonly (string | number)[];
type Plan =
  | { kind: 'leaf'; index: number }
  | { kind: 'literal'; value: string }
  | {
      kind: 'array' | 'object';
      entries: readonly (readonly [string | number, Plan])[];
    };

// This input plan describes traversal order independently of generated parser
// code. Each invalid leaf is a correctly typed, empty string: it contributes one
// nonfatal minLength issue, including through nullable and tagged alternatives.
function plan(form: Form, length: number): Plan {
  let next = 0;
  const leaves = (count: number): Plan => ({
    kind: 'array',
    entries: Array.from(
      { length: count },
      (_, index) => [index, { kind: 'leaf', index: next++ }] as const,
    ),
  });
  if (form === 'Array' || form === 'RefinedArray') return leaves(length);
  if (form === 'Map' || form === 'RefinedMap')
    return {
      kind: 'object',
      entries: Array.from(
        { length },
        (_, index) => [String(index), { kind: 'leaf', index: next++ }] as const,
      ),
    };
  if (form === 'Tagged')
    return {
      kind: 'object',
      entries: [
        ['kind', { kind: 'literal', value: 'a' }],
        ['values', leaves(length)],
      ],
    };
  const width =
    form === 'Wide'
      ? 257
      : form === 'NestedArray' || form === 'MapArray'
        ? 5
        : 3;
  return {
    kind: form === 'NestedArray' ? 'array' : 'object',
    entries: Array.from(
      { length: width },
      (_, index) =>
        [
          form === 'NestedArray' ? index : field(index),
          leaves(Math.floor(length / width) + (index < length % width ? 1 : 0)),
        ] as const,
    ),
  };
}

function sample(form: Form, bad: readonly boolean[], label: string) {
  const paths: Path[] = [];
  const reads: number[] = [];
  let failures = 0;
  let active = false;
  const inspect = (path: Path): void => {
    if (active)
      assert.ok(
        failures < 100,
        `${label}: input observed after the quota at ${JSON.stringify(path)}`,
      );
  };
  function build(node: Plan, path: Path): unknown {
    if (node.kind === 'leaf') {
      paths[node.index] = path;
      return bad[node.index] ? '' : 'valid';
    }
    if (node.kind === 'literal') return node.value;
    const target: object = node.kind === 'array' ? [] : {};
    for (const [key, child] of node.entries) {
      const childPath = [...path, key];
      const value = build(child, childPath);
      Object.defineProperty(target, key, {
        enumerable: true,
        get() {
          if (active && child.kind === 'leaf') {
            reads.push(child.index);
            if (bad[child.index]) failures++;
          }
          return value;
        },
      });
    }
    return new Proxy(target, {
      get(target, key, receiver) {
        inspect([...path, String(key)]);
        const value: unknown = Reflect.get(target, key, receiver);
        return value;
      },
      ownKeys(target) {
        inspect(path);
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        inspect([...path, String(key)]);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      getPrototypeOf(target) {
        inspect(path);
        return Reflect.getPrototypeOf(target);
      },
      has(target, key) {
        inspect([...path, String(key)]);
        return Reflect.has(target, key);
      },
    });
  }
  const input = build(plan(form, bad.length), []);
  return {
    input,
    paths,
    reads,
    parse(module: StandaloneModule) {
      active = true;
      try {
        return module.schema.safeParse(input);
      } finally {
        active = false;
      }
    },
  };
}

function positions(
  count: number,
  mode: 'terminal' | 'tail' | 'mixed',
): boolean[] {
  // A successful traversal must exceed the diagnostic quota too; otherwise a
  // parser that truncates valid containers at 100 could satisfy every case.
  const result = Array.from(
    {
      length:
        count === 0 && mode === 'mixed'
          ? 1_000
          : count + (mode === 'terminal' ? 0 : 17),
    },
    (_, index) => index < count,
  );
  if (mode === 'mixed') {
    let seed = 0x706f6d + count;
    for (let index = result.length - 1; index > 0; index--) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      const other = seed % (index + 1);
      [result[index], result[other]] = [result[other]!, result[index]!];
    }
  }
  return result;
}

void test('generated containers preserve valid data and stop value, key, descriptor, prototype and membership reads at the issue quota', async (t) => {
  const standalone: Record<
    string,
    { schema: string; usage: 'request' | 'response' }
  > = {};
  for (const form of forms)
    for (const usage of ['request', 'response'] as const)
      standalone[`${form.toLowerCase()}-${usage}`] = {
        schema: `#/components/schemas/${form}`,
        usage,
      };
  standalone['typed-request'] = {
    schema: '#/components/schemas/TypedArray',
    usage: 'request',
  };
  const root = await generatedTestWorkspace(
    t,
    await compile(
      {
        openapi: '3.1.2',
        info: { title: 'Synthetic generated validation quotas', version: '1' },
        paths: {},
        components: { schemas: definitions },
      },
      { clients: [], standalone },
    ),
  );
  for (const form of forms)
    for (const usage of ['request', 'response'] as const) {
      const module = await importGenerated<StandaloneModule>(
        root,
        `standalone.${form.toLowerCase()}-${usage}.ts`,
      );
      for (const count of [0, 1, 99, 100, 101, 1_000])
        for (const mode of ['terminal', 'tail', 'mixed'] as const) {
          const label = `${form}/${usage}/${count}/${mode}`;
          const bad = positions(count, mode);
          const witness = sample(form, bad, label);
          const result = witness.parse(module);
          assert.equal(result.success, count === 0, label);
          let expectedReads = bad.length;
          let seen = 0;
          for (const [index, invalid] of bad.entries())
            if (invalid && ++seen === 100) {
              expectedReads = index + 1;
              break;
            }
          assert.deepEqual(
            witness.reads,
            Array.from({ length: expectedReads }, (_, index) => index),
            `${label}: traversal prefix`,
          );
          if (result.success) {
            assert.notEqual(result.data, witness.input, label);
            assert.deepEqual(result.data, witness.input, label);
            continue;
          }
          const details = result.error.issues.filter(
            (issue) => !issue.message.includes('omitted'),
          );
          const markers = result.error.issues.filter((issue) =>
            issue.message.includes('omitted'),
          );
          assert.equal(details.length, Math.min(count, 100), label);
          assert.deepEqual(
            details.map((issue) => issue.path),
            witness.paths.filter((_, index) => bad[index]).slice(0, 100),
            label,
          );
          assert.ok(
            details.every((issue) => issue.message === 'string is too short'),
            label,
          );
          assert.ok(markers.length <= 1, label);
          assert.ok(result.error.message.length <= 8_192, label);
          // At exactly 100 errors, skipped valid values or object-key checks may
          // warrant the conservative marker. Invalid-leaf count alone cannot tell.
          if (count < 100) assert.equal(markers.length, 0, label);
          if (count > 100 || expectedReads < bad.length)
            assert.equal(markers.length, 1, label);
          for (const marker of markers)
            assert.deepEqual(marker.path, [], label);
        }
      if (form === 'Nullable')
        assert.deepEqual(module.schema.safeParse(null), {
          success: true,
          data: null,
        });
    }
  const typed = await importGenerated<StandaloneModule>(
    root,
    'standalone.typed-request.ts',
  );
  for (const tail of [0, 1]) {
    const result = typed.schema.safeParse([
      ...Array<unknown>(100).fill(false),
      ...Array<string>(tail).fill('valid'),
    ]);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(
        result.error.issues.filter(
          (issue) => !issue.message.includes('omitted'),
        ).length,
        100,
      );
      assert.equal(
        result.error.issues.filter((issue) => issue.message.includes('omitted'))
          .length,
        tail,
      );
    }
  }
});
