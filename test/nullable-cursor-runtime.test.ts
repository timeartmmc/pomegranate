import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { compile } from '../dist/index.js';
import { runtimeInput } from './assertions.ts';
import { generatedWorkspace } from './generated-workspace.ts';
import { infiniteChecks } from './infinite-checks.ts';
import { infiniteFixture, infiniteSelection } from './infinite-fixture.ts';
import { infiniteLifecycleChecks } from './infinite-lifecycle-checks.ts';

type Module = typeof import('./.generated/infinite/client.consumer.queries.ts');
let root: string;
let module: Module;

before(async () => {
  root = await generatedWorkspace(
    await compile(infiniteFixture(true), infiniteSelection),
  );
  module = (await import(
    pathToFileURL(join(root, 'client.consumer.queries.ts')).href
  )) as Module;
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

// Nullable cursors must preserve the same wire, cache and lifecycle guarantees
// as nonnullable cursors, including validation before transport and hydration.
for (const [name, check] of Object.entries({
  ...infiniteChecks,
  ...infiniteLifecycleChecks,
}))
  void test(`nullable request cursor: ${name}`, async () => {
    await check(module);
  });

void test('nullable ordinary cursors omit null while infinite cursors remain pagination-owned', () => {
  const config = {
    namespace: 'nullable-cursor',
    execute: async () => {
      throw new Error('must not execute');
    },
  };
  const ordinary = module.createQueries(config).listItems;
  const infinite = module.createInfiniteQueries(config).listItems;
  const args = { context: {}, input: { path: { collection: 'widgets' } } };
  const omitted = ordinary.key(args);
  const nullCursor = {
    ...args,
    input: { ...args.input, query: { after: null } },
  };
  assert.deepEqual(runtimeInput(ordinary.key, nullCursor), omitted);
  for (const after of ['', 'null', 'undefined'])
    assert.notDeepEqual(
      ordinary.key({ ...args, input: { ...args.input, query: { after } } }),
      omitted,
    );
  for (const factory of [infinite, infinite.body()]) {
    assert.throws(() => runtimeInput(factory.options, nullCursor), {
      name: 'RequestValidationError',
    });
    assert.throws(() => runtimeInput(factory.key, nullCursor), {
      name: 'RequestValidationError',
    });
    assert.equal(factory.options(args).initialPageParam, null);
  }
});
