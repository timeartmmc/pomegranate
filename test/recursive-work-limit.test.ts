import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { compile, ContractError, runProject } from '../dist/index.js';
import type { CompileOptions } from '../dist/index.js';
import { invalidOptions, member, present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { object, ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

function document() {
  const content = { 'application/json': { schema: ref('Batch') } };
  const fields = {
    id: { type: 'integer' },
    label: { type: 'string' },
    category: { type: 'string' },
    enabled: { type: 'boolean' },
    quantity: { type: 'integer' },
    price: { type: 'number' },
    revision: { type: 'integer' },
  };
  const nullable: Record<string, Schema> = {
    NullableNode: object({ next: ref('U0') }),
  };
  for (let i = 0; i < 32; i++)
    nullable[`U${i}`] = {
      anyOf: [ref(i === 31 ? 'NullableNode' : `U${i + 1}`), { type: 'null' }],
    };
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic configured recursive work', version: '1' },
    components: {
      schemas: {
        Node: object({ ...fields, next: ref('Node') }, Object.keys(fields)),
        FlatBatch: { type: 'array', items: object(fields) },
        Batch: { type: 'array', items: ref('Node') },
        UniqueBatch: { type: 'array', uniqueItems: true, items: ref('Node') },
        ...nullable,
      },
    },
    paths: {
      '/batch': {
        post: {
          operationId: 'batch',
          requestBody: { required: true, content },
          responses: { 200: { description: 'Synthetic batch', content } },
        },
      },
    },
  };
}

const selection: CompileOptions = {
  clients: ['consumer'],
  surfaces: { consumer: ['batch'] },
  standalone: {
    request: { schema: ref('Batch').$ref, usage: 'request' },
    response: { schema: ref('Batch').$ref, usage: 'response' },
    node: { schema: ref('Node').$ref, usage: 'response' },
    flat: { schema: ref('FlatBatch').$ref, usage: 'response' },
    unique: { schema: ref('UniqueBatch').$ref, usage: 'response' },
    nullable: { schema: ref('U0').$ref, usage: 'response' },
  },
};
const row = (id = 1) => ({
  id,
  label: `row-${id}`,
  category: 'synthetic',
  enabled: true,
  quantity: 2,
  price: 9.99,
  revision: 1,
});

async function generated(t: TestContext, recursiveWorkLimit?: number) {
  const options =
    recursiveWorkLimit === undefined
      ? selection
      : { ...selection, recursiveWorkLimit };
  const root = await generatedTestWorkspace(
    t,
    await compile(document(), options),
  );
  const load = async (name: string) =>
    (await importGenerated<StandaloneModule>(root, `standalone.${name}.ts`))
      .schema;
  return {
    request: await load('request'),
    response: await load('response'),
    node: await load('node'),
    flat: await load('flat'),
    unique: await load('unique'),
    nullable: await load('nullable'),
    client: await importGenerated<RuntimeClient>(root, 'client.consumer.ts'),
  };
}

void test('a raised work limit admits larger recursive-reachable batches at every validation boundary', async (t) => {
  const input = Array.from({ length: 20_000 }, (_, i) => row(i));
  for (const [limit, accepted] of [
    [undefined, false],
    [250_000, true],
  ] as const) {
    const { request, response, client } = await generated(t, limit);
    for (const schema of [request, response]) {
      const result = schema.safeParse(input);
      assert.equal(result.success, accepted);
      if (result.success) {
        assert.deepEqual(result.data, input);
        assert.notEqual(result.data, input);
        assert.notEqual(member(result.data, 0), input[0]);
      } else assert.match(result.error.message, /work exceeds 100000 visits/);
      assert.deepEqual(schema.parse([row()]), [row()]);
    }
    const operation = present(client.operations.batch);
    if (accepted) {
      const body = operation.build({ body: input }).body;
      assert.deepEqual(body, input);
      assert.notEqual(member(body, 0), input[0]);
    } else
      assert.throws(
        () => operation.build({ body: input }),
        /work exceeds 100000 visits/,
      );
    const result = operation.parseResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    assert.equal(result.kind, accepted ? 'success' : 'protocol');
    if (result.kind === 'success') assert.deepEqual(result.data, input);
    else if (result.kind === 'protocol')
      assert.ok(
        result.issues.some(({ message }) =>
          /work exceeds 100000 visits/.test(message),
        ),
      );
  }
});

void test('a configured smaller limit names its cap and starts a fresh allowance for every call', async (t) => {
  const { request, response, flat, client } = await generated(t, 32);
  const input = Array.from({ length: 10 }, (_, i) => row(i));
  assert.deepEqual(flat.parse(input), input);
  for (const schema of [request, response]) {
    const failure = schema.safeParse(input);
    assert.equal(failure.success, false);
    if (!failure.success)
      assert.match(failure.error.message, /work exceeds 32 visits/);
    for (let i = 0; i < 6; i++)
      assert.deepEqual(schema.parse([row(i)]), [row(i)]);
  }
  const operation = present(client.operations.batch);
  assert.throws(
    () => operation.build({ body: input }),
    /work exceeds 32 visits/,
  );
  assert.deepEqual(operation.build({ body: [row()] }).body, [row()]);
  const observed = (body: unknown) =>
    operation.parseResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const failure = observed(input);
  assert.equal(failure.kind, 'protocol');
  if (failure.kind === 'protocol')
    assert.ok(
      failure.issues.some(({ message }) =>
        /work exceeds 32 visits/.test(message),
      ),
    );
  assert.equal(observed([row()]).kind, 'success');
});

void test('raising recursive work leaves depth, parser-entry, cycle and uniqueness guards intact', async (t) => {
  const { node, nullable, unique } = await generated(t, 1_000_000);
  let deep: unknown = row();
  for (let i = 0; i < 140; i++) deep = { ...row(), next: deep };
  const depth = node.safeParse(deep);
  assert.equal(depth.success, false);
  if (!depth.success)
    assert.match(depth.error.issues[0]?.message ?? '', /depth exceeds 128/);
  const cycle = { ...row(), next: {} };
  cycle.next = cycle;
  const cyclic = node.safeParse(cycle);
  assert.equal(cyclic.success, false);
  if (!cyclic.success)
    assert.match(cyclic.error.issues[0]?.message ?? '', /cyclic input/);
  let bindings: unknown = null;
  for (let i = 0; i < 32; i++) bindings = { next: bindings };
  const parserDepth = nullable.safeParse(bindings);
  assert.equal(parserDepth.success, false);
  if (!parserDepth.success)
    assert.match(
      parserDepth.error.issues[0]?.message ?? '',
      /parser depth exceeds 512/,
    );
  let extra: unknown = 0;
  for (let i = 0; i < 18; i++) extra = { left: extra, right: extra };
  const comparison = unique.safeParse([
    { ...row(), extra },
    { ...row(), extra },
  ]);
  assert.equal(comparison.success, false);
  if (!comparison.success)
    assert.match(
      comparison.error.issues[0]?.message ?? '',
      /uniqueItems comparison exceeds 100000 values/,
    );
  assert.deepEqual(node.parse(row()), row());
});

void test('omitted, undefined and explicit default limits preserve the same generated output', async () => {
  const expected = await compile(document(), selection);
  assert.deepEqual(
    await invalidOptions(compile, document(), {
      ...selection,
      recursiveWorkLimit: undefined,
    }),
    expected,
  );
  assert.deepEqual(
    await compile(document(), { ...selection, recursiveWorkLimit: 100_000 }),
    expected,
  );
  for (const recursiveWorkLimit of [1, Number.MAX_SAFE_INTEGER])
    await compile(document(), { ...selection, recursiveWorkLimit });
});

function invalidLimit(error: unknown) {
  assert.ok(error instanceof ContractError);
  assert.equal(error.location, 'recursiveWorkLimit');
  assert.match(error.message, /positive safe integer/);
  return true;
}

void test('work limits reject invalid values in programmatic compilation', async () => {
  for (const recursiveWorkLimit of [
    0,
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '1000',
    true,
    null,
  ]) {
    await assert.rejects(
      invalidOptions(compile, document(), { ...selection, recursiveWorkLimit }),
      invalidLimit,
    );
  }
});

void test('project work limits share compilation semantics, preserve read-only drift checks and reject before writing', async (t) => {
  const root = await temporary(t);
  const config = join(root, 'pom.json');
  await writeFile(join(root, 'openapi.json'), JSON.stringify(document()));
  const settings = {
    version: 2,
    openapi: './openapi.json',
    output: './generated',
    ...selection,
    recursiveWorkLimit: 250_000,
  };
  await writeFile(config, JSON.stringify(settings));
  await runProject(config);
  const output = join(root, 'generated');
  const expected = await compile(document(), {
    ...selection,
    recursiveWorkLimit: 250_000,
  });
  for (const [name, source] of Object.entries(expected))
    assert.equal(await readFile(join(output, name), 'utf8'), source);
  assert.equal((await runProject(config, { check: true })).clean, true);
  const before = await fileSnapshot(output);
  await writeFile(
    config,
    JSON.stringify({ ...settings, recursiveWorkLimit: 300_000 }),
  );
  assert.equal((await runProject(config, { check: true })).clean, false);
  assert.deepEqual(await fileSnapshot(output), before);
  await runProject(config);
  assert.equal((await runProject(config, { check: true })).clean, true);
  const changed = await fileSnapshot(output);
  for (const recursiveWorkLimit of [
    0,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    '1000',
    true,
    null,
  ]) {
    await writeFile(
      config,
      JSON.stringify({ ...settings, recursiveWorkLimit }),
    );
    for (const check of [true, false])
      await assert.rejects(runProject(config, { check }), invalidLimit);
    assert.deepEqual(await fileSnapshot(output), changed);
  }
});
