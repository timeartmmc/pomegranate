import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { QueryClient } from '@tanstack/query-core';
import { build } from 'esbuild';
import { compile } from '../dist/index.js';
import { entry, runtimeInput } from './assertions.ts';
import { addUnusedOperations } from './bundle-fixture.ts';
import { generatedWorkspace } from './generated-workspace.ts';
import { infiniteFixture, infiniteSelection } from './infinite-fixture.ts';
import { offsetFixture, offsetSelection } from './offset-fixture.ts';
import {
  multipartFixture,
  multipartSelection,
  verifyMultipart,
} from './multipart-fixture.ts';
import { queryFixture, querySelection } from './query-fixture.ts';
import { schemaFixture, verifySchemas } from './schema-fixture.ts';

type Bundler = 'esbuild' | 'bun';
type QueryModule =
  typeof import('./.generated/queries/client.consumer.queries.ts');
type InfiniteModule =
  typeof import('./.generated/infinite/client.consumer.queries.ts');
type OffsetModule =
  typeof import('./.generated/offset/client.consumer.queries.ts');
type CoreModule = typeof import('./.generated/queries/client.consumer.ts');
type SchemaModule =
  typeof import('./.generated/queries/client.consumer.schemas.ts');

async function workspace(
  t: TestContext,
  files: Readonly<Record<string, string>>,
) {
  const root = await generatedWorkspace(files);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function bundle(
  root: string,
  source: string,
  bundler: Bundler,
  name: string,
) {
  const input = join(root, `${name}.ts`);
  const output = join(root, `${name}.js`);
  await writeFile(input, source);
  if (bundler === 'esbuild') {
    await build({
      entryPoints: [input],
      outfile: output,
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      minify: true,
      logLevel: 'silent',
    });
  } else {
    await promisify(execFile)('bun', [
      'build',
      input,
      '--target=browser',
      '--format=esm',
      '--minify',
      `--outfile=${output}`,
    ]);
  }
  return {
    code: await readFile(output, 'utf8'),
    url: pathToFileURL(output).href,
  };
}

void test('generated validators bundle without a schema library and preserve schema validation and diagnostics', async (t) => {
  const files = await compile(schemaFixture(), {
    clients: ['samples'],
    transportHeaders: ['X-Origin'],
  });
  // Native validators are generated functions over local runtime helpers.
  for (const source of Object.values(files))
    assert.doesNotMatch(source, /from 'zod'|import\('zod'\)/);
  const source =
    "export { operations, RequestValidationError } from './client.samples.ts';";
  const output = await bundle(
    await workspace(t, files),
    source,
    'esbuild',
    'native',
  );
  assert.doesNotMatch(output.code, /\bzod\b/i);
  const module = (await import(
    output.url
  )) as typeof import('./.generated/schema/client.samples.ts');
  verifySchemas(module.operations, module.RequestValidationError);
});

for (const bundler of ['esbuild', 'bun'] as const) {
  void test(`${bundler} removes unselected query contracts and preserves full aggregate instances`, async (t) => {
    const selection = {
      ...querySelection,
      clients: ['consumer'],
      queries: { consumer: ['readItem'] },
    };
    const small = await workspace(t, await compile(queryFixture(), selection));
    const large = await workspace(
      t,
      await compile(addUnusedOperations(queryFixture(), 100), selection),
    );
    const source =
      "export { createQueries, QueryResponseError } from './client.consumer.queries.ts';";
    const single = await bundle(small, source, bundler, 'single');
    const sparse = await bundle(large, source, bundler, 'sparse');
    assert.ok(
      Math.abs(gzipSync(sparse.code).length - gzipSync(single.code).length) <
        200,
      'unselected operations must not increase the selected bundle',
    );
    assert.ok(!sparse.code.includes('unused-response-'));
    // String validation must not retain predicates for undeclared formats.
    assert.doesNotMatch(
      sparse.code,
      /expected (?:an email address|a URI|a calendar date|a UUID)/,
    );
    const module = (await import(sparse.url)) as QueryModule;
    const queries = module.createQueries({
      namespace: 'bundle',
      execute: async (request) => {
        assert.equal(request.url, '/items/a%2Fb');
        return {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: '{"id":"a/b","label":"bundled","extra":true}',
        };
      },
    });
    const cache = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    try {
      assert.deepEqual(
        (
          await cache.fetchQuery(
            queries.readItem.options({
              context: {},
              input: { path: { id: 'a/b' } },
            }),
          )
        ).data,
        { id: 'a/b', label: 'bundled' },
      );
      assert.deepEqual(
        await cache.fetchQuery(
          queries.readItem
            .body()
            .options({ context: {}, input: { path: { id: 'a/b' } } }),
        ),
        { id: 'a/b', label: 'bundled' },
      );
    } finally {
      cache.clear();
    }

    const full = await bundle(
      large,
      `
      export { operations } from './client.consumer.ts';
      export { requestSchemas, responseSchemas } from './client.consumer.schemas.ts';
      export { operation_readItem } from './client.consumer.operations.ts';
    `,
      bundler,
      'full',
    );
    const api = (await import(full.url)) as CoreModule &
      SchemaModule & {
        operation_readItem: CoreModule['operations']['readItem'];
      };
    assert.equal(Object.keys(api.operations).length, 104);
    assert.ok(Object.isFrozen(api.operations));
    assert.ok(Object.isFrozen(api.requestSchemas));
    assert.ok(Object.isFrozen(api.responseSchemas));
    assert.equal(api.operation_readItem, api.operations.readItem);
    for (let index = 0; index < 100; index++) {
      const operation = entry(api.operations, `unused${index}`);
      const body = {
        tag: `unused-response-${index}`,
        attributes: { ['__proto__']: null, constructor: 1 },
      };
      const valid = operation.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(valid.kind, 'success');
      assert.deepEqual(valid.data, body);
      assert.equal(
        operation.parseResponse({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: '{"tag":"wrong","attributes":{}}',
        }).kind,
        'protocol',
      );
      assert.equal(
        runtimeInput(operation.build, { headers: { 'X-Trace': body.tag } }).url,
        `/unused/${index}`,
      );
      assert.throws(() =>
        runtimeInput(operation.build, { headers: { 'X-Trace': 'wrong' } }),
      );
      assert.equal(
        entry(api.responseSchemas, `Unused${index}Alias`),
        entry(api.responseSchemas, `Unused${index}`),
      );
    }
  });

  for (const profile of ['cursor', 'offset'] as const) {
    void test(`${bundler} keeps ${profile} base schemas while dropping unrelated contracts`, async (t) => {
      const cursor = profile === 'cursor';
      const document = cursor ? infiniteFixture() : offsetFixture();
      // The offset fixture is public; the added unused operations use the
      // session vocabulary already declared by the cursor/query fixture.
      if (!cursor)
        Object.assign(document['x-pom-policy'].auth, {
          session: { transport: 'none' },
        });
      const original = cursor ? infiniteSelection : offsetSelection;
      const selection = { ...original, clients: ['consumer'], queries: {} };
      const small = await workspace(t, await compile(document, selection));
      const large = await workspace(
        t,
        await compile(addUnusedOperations(document, 100), selection),
      );
      const source =
        "export { createInfiniteQueries } from './client.consumer.queries.ts';";
      const single = await bundle(small, source, bundler, 'single');
      const sparse = await bundle(large, source, bundler, 'sparse');
      assert.ok(!sparse.code.includes('unused-response-'));
      assert.ok(
        Math.abs(gzipSync(sparse.code).length - gzipSync(single.code).length) <
          200,
      );
      const cache = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: Infinity } },
      });
      try {
        if (cursor) {
          const module = (await import(sparse.url)) as InfiniteModule;
          const queries = module.createInfiniteQueries({
            namespace: 'bundle',
            execute: async () => ({
              status: 200,
              headers: { 'Content-Type': 'application/json' },
              body: '{"results":[{"id":"one","label":"bundled"}],"continuation":null}',
            }),
          });
          const args = { context: {}, input: { path: { collection: 'all' } } };
          const factory = queries.listItems;
          const result = await cache.fetchInfiniteQuery(factory.options(args));
          assert.deepEqual(result.pageParams, [null]);
          assert.deepEqual(factory.items(result), [
            { id: 'one', label: 'bundled' },
          ]);
          const body = factory.body();
          const bodyResult = await cache.fetchInfiniteQuery(body.options(args));
          assert.deepEqual(bodyResult.pageParams, [null]);
          assert.deepEqual(body.items(bodyResult), [
            { id: 'one', label: 'bundled' },
          ]);
        } else {
          const module = (await import(sparse.url)) as OffsetModule;
          const queries = module.createInfiniteQueries({
            namespace: 'bundle',
            execute: async () => ({
              status: 200,
              headers: { 'Content-Type': 'application/json' },
              body: '{"entries":[{"id":"one"}],"start":0,"size":1,"count":1,"next":null}',
            }),
          });
          const args = { context: {}, input: { path: { category: 'all' } } };
          const factory = queries.listRecords;
          const result = await cache.fetchInfiniteQuery(factory.options(args));
          assert.deepEqual(result.pageParams, [0]);
          assert.deepEqual(factory.items(result), [{ id: 'one' }]);
          const body = factory.body();
          const bodyResult = await cache.fetchInfiniteQuery(body.options(args));
          assert.deepEqual(bodyResult.pageParams, [0]);
          assert.deepEqual(body.items(bodyResult), [{ id: 'one' }]);
        }
      } finally {
        cache.clear();
      }
    });
  }

  void test(`${bundler} preserves browser and native multipart validation`, async (t) => {
    const root = await workspace(
      t,
      await compile(multipartFixture(), multipartSelection),
    );
    const output = await bundle(
      root,
      `
      export { operations as browser, RequestValidationError } from './client.browser.ts';
      export { operations as native } from './client.native.ts';
    `,
      bundler,
      'multipart',
    );
    const module = (await import(output.url)) as {
      browser: typeof import('./.generated/multipart/client.browser.ts').operations;
      native: typeof import('./.generated/multipart/client.native.ts').operations;
      RequestValidationError: typeof import('./.generated/multipart/client.browser.ts').RequestValidationError;
    };
    await verifyMultipart(
      module.browser,
      module.native,
      module.RequestValidationError,
    );
  });
}
