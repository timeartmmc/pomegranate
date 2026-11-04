import assert from 'node:assert/strict';
import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { compile } from '../dist/index.js';
import { present, runtimeInput } from './assertions.ts';
import { generatedWorkspace, importGenerated } from './generated-workspace.ts';
import { infiniteChecks } from './infinite-checks.ts';
import { infiniteFixture, infiniteSelection } from './infinite-fixture.ts';
import { infiniteLifecycleChecks } from './infinite-lifecycle-checks.ts';

type Module = typeof import('./.generated/infinite/client.consumer.queries.ts');
const modules = new Map<boolean, Module>();
const roots: string[] = [];
const variants = [
  { name: 'string request cursor', nullable: false },
  { name: 'nullable request cursor', nullable: true },
];
const checks = [
  ...Object.entries(infiniteChecks),
  ...Object.entries(infiniteLifecycleChecks),
];

// Register teardown outside before: an ambient after() inside that hook belongs
// to the hook itself and would delete the fixtures before these tests run.
after(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});
before(async () => {
  for (const { nullable } of variants) {
    const root = await generatedWorkspace(
      await compile(infiniteFixture(nullable), infiniteSelection),
    );
    roots.push(root);
    modules.set(
      nullable,
      await importGenerated<Module>(root, 'client.consumer.queries.ts'),
    );
  }
});

void test('suite workspaces support generated imports after setup completes', async () => {
  for (const root of roots) {
    // Check disk as well as imports so a cached module cannot hide early cleanup.
    await access(join(root, 'client.consumer.ts'));
    const { operations } = await importGenerated<
      typeof import('./.generated/infinite/client.consumer.ts')
    >(root, 'client.consumer.ts');
    assert.equal(
      operations.listItems.build({ path: { collection: 'late-import' } }).url,
      '/collections/late-import/items',
    );
  }
});

// Both request schemas share the wire, cache and lifecycle contract. Compile
// each variant once and run the same checks against its generated module.
for (const { name: variant, nullable } of variants)
  for (const [name, check] of checks)
    void test(`${variant}: ${name}`, async () => {
      await check(present(modules.get(nullable)));
    });

void test('infinite inputs reject missing, unknown and cursor-owned fields', () => {
  const module = present(modules.get(false));
  const queries = module.createInfiniteQueries({
    namespace: 'invalid-inputs',
    execute: async () => {
      throw new Error('must not execute');
    },
  });
  for (const args of [
    { context: {} },
    { context: {}, input: { path: { collection: '' } } },
    {
      context: {},
      input: { path: { collection: 'ok' }, query: { after: 'override' } },
    },
    { context: {}, input: { path: { collection: 'ok' }, query: { limit: 0 } } },
    { context: {}, input: { path: { collection: 'ok' }, body: {} } },
  ])
    assert.throws(() => runtimeInput(queries.listItems.options, args), {
      name: 'RequestValidationError',
    });
  for (const args of [
    { input: { path: { collection: 'ok' } } },
    { context: { session: {} }, input: { path: { collection: 'ok' } } },
    { context: {}, extra: true },
  ])
    assert.throws(
      () => runtimeInput(queries.listItems.options, args),
      TypeError,
    );
});

void test('nullable ordinary cursors omit null while infinite cursors remain pagination-owned', () => {
  const module = present(modules.get(true));
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
