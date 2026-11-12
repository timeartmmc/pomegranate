import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { object, ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

function document(schemas: Record<string, Schema>) {
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic recursive schema depth', version: '1' },
    paths: {},
    components: { schemas },
  };
}
function selected(schema: string) {
  return {
    clients: [],
    standalone: {
      root: { schema: ref(schema).$ref, usage: 'response' as const },
    },
  };
}
function arrays(
  schemas: Record<string, Schema>,
  count: number,
  target: string,
) {
  for (let i = 0; i < count; i++)
    schemas[`Wrapper${i}`] = {
      type: 'array',
      items: ref(i === 0 ? target : `Wrapper${i - 1}`),
    };
  return count === 0 ? target : `Wrapper${count - 1}`;
}
function objects(depth: number, leaf: Schema): Schema {
  let result = leaf;
  for (let i = 0; i < depth; i++) result = object({ child: result }, []);
  return result;
}
async function boundary(
  schemas: Record<string, Schema>,
  root: string,
  accepted: boolean,
) {
  if (accepted) await compile(document(schemas), selected(root));
  else
    await assert.rejects(
      compile(document(schemas), selected(root)),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.match(
          error.message,
          /schema nesting exceeds the supported limit of 128 levels/,
        );
        return true;
      },
    );
}
async function generated(
  t: TestContext,
  schemas: Record<string, Schema>,
  name: string,
) {
  const root = await generatedTestWorkspace(
    t,
    await compile(document(schemas), selected(name)),
  );
  return (await importGenerated<StandaloneModule>(root, 'standalone.root.ts'))
    .schema;
}

void test('wide productive recursive rings and stars compile and validate shallow values', async (t) => {
  const count = 192;
  const cases: [Record<string, Schema>, unknown][] = [];
  for (const size of [192, 1000])
    cases.push([
      Object.fromEntries(
        Array.from({ length: size }, (_, i) => [
          `N${i}`,
          object(
            { value: { type: 'integer' }, next: ref(`N${(i + 1) % size}`) },
            ['value'],
          ),
        ]),
      ),
      { value: 0, next: { value: 1 } },
    ]);
  const star: Record<string, Schema> = {
    N0: object(
      {
        value: { type: 'integer' },
        ...Object.fromEntries(
          Array.from({ length: count - 1 }, (_, i) => [
            `n${i + 1}`,
            ref(`N${i + 1}`),
          ]),
        ),
      },
      ['value'],
    ),
    ...Object.fromEntries(
      Array.from({ length: count - 1 }, (_, i) => [
        `N${i + 1}`,
        object({ value: { type: 'integer' }, back: ref('N0') }, ['value']),
      ]),
    ),
  };
  cases.push([
    star,
    { value: 0, n1: { value: 1, back: { value: 0 } }, n191: { value: 191 } },
  ]);
  for (const [schemas, input] of cases) {
    const schema = await generated(t, schemas, 'N0');
    const output = schema.parse(input);
    assert.deepEqual(output, input);
    assert.notEqual(output, input);
    assert.equal(schema.safeParse({ value: 'invalid' }).success, false);
  }
});

void test('recursive members retain their own depth through direct, pure-alias and constrained-alias references', async () => {
  for (const target of ['Body', 'Alias', 'Limited']) {
    for (const count of [97, 98]) {
      let body: Schema = ref('Limited');
      for (let i = 0; i < 31; i++) body = { type: 'array', items: body };
      const schemas: Record<string, Schema> = {
        Body: body,
        Alias: ref('Body'),
        Limited: { ...ref('Alias'), maxItems: 2 },
      };
      await boundary(schemas, arrays(schemas, count, target), count === 97);
    }
  }
});

void test('a shallow recursive member does not inherit the depth of a deeper sibling', async () => {
  for (const count of [127, 128]) {
    const schemas: Record<string, Schema> = {
      Deep: objects(31, ref('Shallow')),
      Shallow: object({ back: ref('Deep') }, []),
    };
    await boundary(schemas, arrays(schemas, count, 'Shallow'), count === 127);
  }
});

void test('recursive members preserve inline and external depth along each branch', async () => {
  for (const externalDepth of [97, 98]) {
    const schemas: Record<string, Schema> = { Leaf: { type: 'string' } };
    const external = arrays(schemas, externalDepth - 1, 'Leaf');
    schemas.A = objects(
      30,
      object({ back: ref('B'), finite: ref(external) }, []),
    );
    schemas.B = object({ back: ref('A') }, []);
    await boundary(schemas, 'A', externalDepth === 97);
  }
  for (const wrappers of [27, 28]) {
    const schemas: Record<string, Schema> = { Leaf: { type: 'string' } };
    // The cyclic branch has depth31; the finite branch has depth101.
    let external = 'Leaf';
    for (let i = 0; i < 99; i++) {
      const name = `External${i}`;
      schemas[name] = { type: 'array', items: ref(external) };
      external = name;
    }
    schemas.A = object(
      { cycle: objects(30, ref('B')), finite: ref(external) },
      [],
    );
    schemas.B = object({ back: ref('A') }, []);
    await boundary(schemas, arrays(schemas, wrappers, 'A'), wrappers === 27);
  }
});

void test('inline nullable wrappers still contribute depth inside a recursive group', async () => {
  for (const count of [125, 126]) {
    const schemas: Record<string, Schema> = {
      Node: object({ next: { anyOf: [ref('Node'), { type: 'null' }] } }, []),
    };
    await boundary(schemas, arrays(schemas, count, 'Node'), count === 125);
  }
});
