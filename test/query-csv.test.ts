import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { QueryClient } from '@tanstack/query-core';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import type { OperationCall } from '../src/call-runtime.ts';
import type { ClientConfig } from '../src/execution-runtime.ts';
import type { QueryConfig, QueryFactory } from '../src/query-runtime.ts';
import type { Responses } from '../src/runtime.ts';
import { present, record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import {
  queryCsvConsumer,
  queryCsvFixture as fixture,
  queryCsvSelection as selection,
  verifyQueryCsv,
} from './query-csv-fixture.ts';
import type { RuntimeClient } from './runtime-types.ts';

const exec = promisify(execFile);

async function generated(t: TestContext, document = fixture()) {
  const root = await generatedTestWorkspace(
    t,
    await compile(document, selection),
  );
  return {
    root,
    client: await importGenerated<RuntimeClient>(root, 'client.consumer.ts'),
  };
}

async function rejectsAt(document: unknown, location: string, message: RegExp) {
  const before = structuredClone(document);
  await assert.rejects(compile(document, selection), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, location);
    assert.match(error.message, message);
    return true;
  });
  assert.deepEqual(document, before);
}

void test('CSV query arrays preserve separators, primitive values and existing repeated-key bytes', async (t) => {
  verifyQueryCsv((await generated(t)).client);
});

void test('CSV parameter aliases retain inline bytes, YAML equivalence and nonmutating compilation', async () => {
  const document = fixture();
  const before = structuredClone(document);
  const expected = await compile(document, selection);
  assert.deepEqual(document, before);
  assert.deepEqual(
    await compile(parseYaml(stringify(document), 'csv.yaml'), selection),
    expected,
  );
  const inline = fixture();
  inline.paths['/search'].parameters = [
    present(inline.components.parameters.Tags),
  ];
  inline.paths['/required'].get.parameters = [
    present(inline.components.parameters.RequiredTags),
  ];
  Reflect.deleteProperty(inline.components, 'parameters');
  assert.deepEqual(await compile(inline, selection), expected);
  const implicit = fixture();
  const explicit = fixture();
  for (const path of ['/search', '/repeated'] as const)
    for (const entry of explicit.paths[path].get.parameters) {
      const value = record(entry);
      if (value.name === 'repeat' || value.name === 'tag') value.explode = true;
    }
  assert.deepEqual(
    await compile(implicit, selection),
    await compile(explicit, selection),
  );
});

void test('operation overrides can replace inherited CSV serialization as a complete parameter', async (t) => {
  const document = fixture();
  document.paths['/search'].get.parameters.push({
    name: 'tags',
    in: 'query',
    schema: { type: 'array', items: { type: 'string' } },
  });
  const { client } = await generated(t, document);
  assert.equal(
    present(client.operations.search).build({ query: { tags: ['a,b', 'c'] } })
      .url,
    '/search?tags=a%2Cb&tags=c',
  );
  const scalar = fixture();
  scalar.paths['/search'].get.parameters.push({
    name: 'tags',
    in: 'query',
    explode: false,
    schema: { type: 'string' },
  });
  const scalarClient = (await generated(t, scalar)).client;
  assert.equal(
    present(scalarClient.operations.search).build({ query: { tags: 'a,b c' } })
      .url,
    '/search?tags=a%2Cb+c',
  );
});

void test('CSV encoding round-trips delimiters and Unicode without collapsing distinct arrays', async (t) => {
  const { client } = await generated(t);
  const search = present(client.operations.search);
  const values = [
    '',
    ',',
    ',,',
    '%',
    '%2C',
    '+',
    ' ',
    '&',
    '=',
    '?',
    '#',
    '/',
    ':',
    ';',
    '[',
    ']',
    '~',
    '*',
    "'",
    '雪',
    '🙂',
    '\u0000',
    '\r\n',
  ];
  const urls = new Set<string>();
  for (const value of values) {
    const items = [value, 'tail'];
    const built = search.build({ query: { tags: items } });
    const raw = present(built.url.split('tags=')[1]);
    assert.deepEqual(raw.split(',').map(decodeURIComponent), items);
    assert.equal(
      new Request(`https://synthetic.invalid${built.url}`).url,
      `https://synthetic.invalid${built.url}`,
    );
    assert.equal(urls.has(built.url), false);
    urls.add(built.url);
  }
  assert.notEqual(
    search.build({ query: { tags: ['a,b'] } }).url,
    search.build({ query: { tags: ['a', 'b'] } }).url,
  );
});

void test('unsupported CSV neighbors fail eagerly even in unused components and unselected operations', async () => {
  for (const [key, value, message] of [
    ['style', 'spaceDelimited', /unsupported parameter serialization/],
    ['style', 'pipeDelimited', /unsupported parameter serialization/],
    ['style', 'deepObject', /unsupported parameter serialization/],
    ['explode', 'false', /expected a boolean/],
    ['allowReserved', true, /only false on query parameters/],
    [
      'schema',
      { type: 'array', items: { type: ['string', 'null'] } },
      /parameters require/,
    ],
    [
      'schema',
      { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      /parameters require/,
    ],
    [
      'schema',
      { type: 'array', items: { type: 'object', properties: {} } },
      /parameters require/,
    ],
    [
      'schema',
      { type: ['array', 'null'], items: { type: 'string' } },
      /parameters require/,
    ],
  ] as const) {
    for (const unused of [true, false]) {
      const document = fixture();
      const parameter = {
        name: 'unsupported',
        in: 'query',
        explode: false,
        schema: { type: 'array', items: { type: 'string' } },
        [key]: value,
      };
      if (unused)
        Object.assign(document.components.parameters, { Unused: parameter });
      else document.paths['/internal'].get.parameters.push(parameter);
      await rejectsAt(
        document,
        `${unused ? 'components.parameters.Unused' : 'paths./internal.get.parameters[0]'}.${key}`,
        message,
      );
    }
  }
});

interface QueriesModule {
  createQueries: (
    config: QueryConfig,
  ) => Record<string, QueryFactory<unknown, Responses>>;
}
interface ExecutableModule {
  createClient: (
    config: ClientConfig,
  ) => Record<string, OperationCall<unknown, Responses>>;
}

void test('CSV query keys and direct execution retain validated snapshots and unambiguous array identity', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), {
      ...selection,
      executionClients: ['consumer'],
      queries: { consumer: ['search'] },
    }),
  );
  const queryModule = await importGenerated<QueriesModule>(
    root,
    'client.consumer.queries.ts',
  );
  const executable = await importGenerated<ExecutableModule>(
    root,
    'client.consumer.ts',
  );
  const seen: string[] = [];
  const query = present(
    queryModule.createQueries({
      namespace: 'csv-array-identity',
      execute: async (request) => {
        await Promise.resolve();
        seen.push(request.url);
        return { status: 204, headers: {}, body: '' };
      },
    }).search,
  );
  const input = { query: { tags: ['a,b', 'c'] } };
  const options = query.options({ context: {}, input });
  const before = structuredClone(options.queryKey);
  input.query.tags[0] = 'changed';
  assert.deepEqual(options.queryKey, before);
  assert.notDeepEqual(options.queryKey, query.key({ context: {}, input }));
  assert.notDeepEqual(
    query.key({ context: {}, input: { query: { tags: ['a,b'] } } }),
    query.key({ context: {}, input: { query: { tags: ['a', 'b'] } } }),
  );
  assert.deepEqual(
    query.key({ context: {}, input: {} }),
    query.key({ context: {}, input: { query: { tags: [] } } }),
  );
  assert.notDeepEqual(
    query.key({ context: {}, input: {} }),
    query.key({ context: {}, input: { query: { tags: [''] } } }),
  );
  const cache = new QueryClient();
  t.after(() => cache.clear());
  assert.equal((await cache.fetchQuery(options)).kind, 'success');
  assert.deepEqual(seen, ['/search?tags=a%2Cb,c']);
  const direct = present(
    executable.createClient({
      namespace: 'csv-direct-snapshot',
      execute: async (request, execution) => {
        await Promise.resolve();
        seen.push(request.url);
        return execution.validateResponse({
          status: 204,
          headers: {},
          body: '',
        });
      },
    }).search,
  );
  const directInput = { query: { tags: ['a', 'b,c'] } };
  const pending = direct.call({ context: {}, input: directInput });
  directInput.query.tags.push('late');
  assert.equal((await pending).kind, 'success');
  assert.deepEqual(seen, ['/search?tags=a%2Cb,c', '/search?tags=a,b%2Cc']);
});

void test('CSV array types survive source generation and declaration-only publication', async (t) => {
  const { root } = await generated(t);
  await writeFile(join(root, 'consumer.ts'), queryCsvConsumer);
  const options = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    exactOptionalPropertyTypes: true,
    types: [],
  };
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        ...options,
        allowImportingTsExtensions: true,
        declaration: true,
        emitDeclarationOnly: true,
        isolatedDeclarations: true,
        outDir: './declarations',
      },
      include: ['./*.ts'],
    }),
  );
  const tsc = fileURLToPath(
    new URL('../node_modules/typescript/bin/tsc', import.meta.url),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')]);
  await writeFile(
    join(root, 'published.ts'),
    `
    import { search } from './declarations/consumer.js';
    search({query:{tags:['a,b'],ids:[1]}});
    // @ts-expect-error Declaration-only consumers retain array element types.
    search({query:{tags:[false]}});
  `,
  );
  await writeFile(
    join(root, 'published.json'),
    JSON.stringify({
      compilerOptions: { ...options, noEmit: true },
      include: ['./published.ts', './declarations/*.d.ts'],
    }),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'published.json')]);
});

void test('invalid CSV declarations preserve generated files during generation and read-only checks', async (t) => {
  const root = await temporary(t);
  const input = join(root, 'openapi.json');
  const config = join(root, 'pom.json');
  const output = join(root, 'generated');
  await writeFile(input, JSON.stringify(fixture()));
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      ...selection,
    }),
  );
  await runProject(config);
  const snapshot = await fileSnapshot(output);
  assert.equal((await runProject(config, { check: true })).clean, true);
  const document = fixture();
  Object.assign(present(document.components.parameters.Tags), {
    allowReserved: true,
  });
  const source = JSON.stringify(document);
  await writeFile(input, source);
  for (const check of [false, true])
    await assert.rejects(runProject(config, { check }), ContractError);
  assert.deepEqual(await fileSnapshot(output), snapshot);
  assert.equal(await readFile(input, 'utf8'), source);
});
