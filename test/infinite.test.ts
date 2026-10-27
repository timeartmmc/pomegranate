import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile, ContractError, runProject } from '../dist/index.js';
import { invalidOptions, runtimeInput } from './assertions.ts';
import { temporary, fileSnapshot } from './helpers.ts';
import { infiniteFixture, infiniteSelection } from './infinite-fixture.ts';
import { verifyInfiniteQueries } from './infinite-checks.ts';
import { verifyQueryDeclarations } from './query-declarations.ts';

type Module = typeof import('./.generated/infinite/client.consumer.queries.ts');
const exec = promisify(execFile);

async function checkConsumer(
  t: TestContext,
  files: Readonly<Record<string, string>>,
  consumer = '',
) {
  const root = await temporary(t);
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries(files))
    await writeFile(join(root, name), source);
  await writeFile(join(root, 'consumer.ts'), consumer);
  const config = join(root, 'tsconfig.json');
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ['*.ts'],
    }),
  );
  await exec(process.execPath, [
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    '-p',
    config,
  ]);
}

void test('infinite factories preserve pagination, cache, failure and cancellation guarantees', async (t) => {
  const root = await temporary(t);
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const generated = join(root, 'query-generated');
  await mkdir(generated);
  for (const [name, source] of Object.entries(
    await compile(infiniteFixture(), infiniteSelection),
  ))
    await writeFile(join(generated, name), source);
  const module = (await import(
    pathToFileURL(join(generated, 'client.consumer.queries.ts')).href
  )) as Module;
  await verifyInfiniteQueries(
    module.createInfiniteQueries,
    module.QueryResponseError,
  );
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
  await verifyQueryDeclarations(
    root,
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    fileURLToPath(new URL('./query-types.ts', import.meta.url)),
    fileURLToPath(new URL('./infinite-types.ts', import.meta.url)),
  );
});

void test('infinite selection is explicit, deterministic and isolated from ordinary query keys', async (t) => {
  const document = infiniteFixture();
  const normal = await compile(document, {
    clients: ['consumer'],
    queries: { consumer: ['listItems'] },
  });
  const infinite = await compile(document, {
    clients: ['consumer'],
    infiniteQueries: infiniteSelection.infiniteQueries,
  });
  const source = infinite['client.consumer.queries.ts']!;
  assert.match(source, /createInfiniteQueries/);
  assert.doesNotMatch(source, /function createQueries/);
  assert.equal(
    infinite['client.consumer.operations.ts'],
    normal['client.consumer.operations.ts'],
  );
  assert.deepEqual(
    infinite,
    await compile(document, {
      infiniteQueries: infiniteSelection.infiniteQueries,
      clients: ['consumer'],
    }),
  );
  const root = await temporary(t);
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [name, bytes] of Object.entries(
    await compile(document, infiniteSelection),
  ))
    await writeFile(join(root, name), bytes);
  const module = (await import(
    pathToFileURL(join(root, 'client.consumer.queries.ts')).href
  )) as Module;
  const config = {
    namespace: 'separate',
    execute: async () => ({ status: 200, headers: {}, body: '' }),
  };
  const args = { context: {}, input: { path: { collection: 'same' } } };
  assert.notDeepEqual(
    module.createQueries(config).listItems.key(args),
    module.createInfiniteQueries(config).listItems.key(args),
  );
});

void test('invalid pagination configuration and unsupported neighboring contracts receive diagnostics', async () => {
  for (const selection of [
    null,
    [],
    { consumer: {} },
    {
      missing: {
        listItems: infiniteSelection.infiniteQueries.consumer.listItems,
      },
    },
    {
      staff: {
        listItems: infiniteSelection.infiniteQueries.consumer.listItems,
      },
    },
    {
      consumer: {
        missing: infiniteSelection.infiniteQueries.consumer.listItems,
      },
    },
    {
      consumer: { listItems: { cursor: 'after', nextCursor: 'continuation' } },
    },
    {
      consumer: {
        listItems: {
          ...infiniteSelection.infiniteQueries.consumer.listItems,
          typo: true,
        },
      },
    },
    {
      consumer: {
        listItems: {
          ...infiniteSelection.infiniteQueries.consumer.listItems,
          cursor: 'unknown',
        },
      },
    },
  ])
    await assert.rejects(
      invalidOptions(compile, infiniteFixture(), {
        ...infiniteSelection,
        infiniteQueries: selection,
      }),
      ContractError,
    );
  const mutations: ((document: ReturnType<typeof infiniteFixture>) => void)[] =
    [
      (d) => {
        Object.assign(
          d.paths['/collections/{collection}/items'].get.parameters[1]!,
          { required: true },
        );
      },
      (d) => {
        Object.assign(
          d.paths['/collections/{collection}/items'].get.parameters[1]!,
          { schema: { type: 'integer' } },
        );
      },
      (d) => {
        Object.assign(
          d.paths['/collections/{collection}/items'].get.parameters[1]!,
          { schema: { type: ['string', 'null'] } },
        );
      },
      (d) => {
        d.components.schemas.Page.required = ['results'];
      },
      (d) => {
        d.components.schemas.Page.required = ['continuation'];
      },
      (d) => {
        Object.assign(d.components.schemas.Page.properties.results, {
          type: 'string',
        });
        Reflect.deleteProperty(
          d.components.schemas.Page.properties.results,
          'items',
        );
      },
      (d) => {
        Object.assign(d.components.schemas.Page.properties.continuation, {
          type: 'string',
        });
      },
      (d) => {
        Object.assign(d.components.schemas.Page.properties.continuation, {
          type: 'null',
        });
      },
      (d) => {
        Object.assign(
          d.paths['/collections/{collection}/items'].get.responses,
          { 201: { description: 'Bodyless success' } },
        );
      },
      (d) => {
        Object.assign(
          d.paths['/collections/{collection}/items'].get.responses,
          {
            201: {
              description: 'Wrong neighboring success',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        );
      },
    ];
  for (const mutate of mutations) {
    const document = infiniteFixture();
    mutate(document);
    await assert.rejects(compile(document, infiniteSelection), ContractError);
  }
});

void test('cursor-only and referenced base inputs produce strict usable modules', async (t) => {
  const document = infiniteFixture();
  const operation = document.paths['/collections/{collection}/items'].get;
  // A referenced cursor belongs to the full request but is absent from base inputs.
  Object.assign(document.components.schemas, { Cursor: { type: 'string' } });
  const cursor = {
    name: 'after',
    in: 'query',
    schema: { $ref: '#/components/schemas/Cursor' },
  };
  Object.assign(document.paths, {
    '/cursor-only': {
      get: { ...operation, operationId: 'cursorOnly', parameters: [cursor] },
    },
  });
  const files = await compile(document, {
    clients: ['consumer'],
    infiniteQueries: {
      consumer: {
        cursorOnly: infiniteSelection.infiniteQueries.consumer.listItems,
      },
    },
  });
  await checkConsumer(
    t,
    files,
    `
    import { createInfiniteQueries } from './client.consumer.queries.ts';
    const queries = createInfiniteQueries({ namespace: 'cursor-only', execute: async () => ({ status: 200, headers: {}, body: '' }) });
    queries.cursorOnly.options({ context: {} });
  `,
  );
  // Other base fields may use component references and their full constraints.
  Object.assign(operation.parameters[2]!, {
    schema: { $ref: '#/components/schemas/Limit' },
  });
  Object.assign(document.components.schemas, {
    Limit: { type: 'integer', minimum: 1 },
  });
  const referenced = await compile(document, infiniteSelection);
  await checkConsumer(t, referenced);
});

void test('different success statuses retain their own page and item types', async (t) => {
  const document = infiniteFixture();
  Object.assign(
    document.paths['/collections/{collection}/items'].get.responses,
    {
      201: {
        description: 'A different item type',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['results', 'continuation'],
              properties: {
                results: { type: 'array', items: { type: 'boolean' } },
                continuation: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
    },
  );
  await checkConsumer(
    t,
    await compile(document, infiniteSelection),
    `
    import { createInfiniteQueries } from './client.consumer.queries.ts';
    const queries = createInfiniteQueries({ namespace: 'mixed', execute: async () => ({ status: 200, headers: {}, body: '' }) });
    const items = queries.listItems.items(undefined);
    for (const item of items) {
      if (typeof item === 'boolean') { const flag: boolean = item; void flag; }
      else { const id: string = item.id; void id; }
    }
    // @ts-expect-error Mixed page items are not an untyped or numeric array.
    const invalid: number[] = items;
    void invalid;
  `,
  );
});

void test('infinite outputs retain read-only drift and safe cleanup ownership', async (t) => {
  const root = await temporary(t);
  const config = {
    version: 2,
    openapi: './openapi.json',
    output: './generated',
    ...infiniteSelection,
    queries: {},
  };
  const configFile = join(root, 'pom.json');
  await writeFile(
    join(root, 'openapi.json'),
    JSON.stringify(infiniteFixture()),
  );
  await writeFile(configFile, JSON.stringify(config));
  await runProject(configFile);
  const output = join(root, 'generated');
  const before = await fileSnapshot(output);
  await writeFile(
    configFile,
    JSON.stringify({
      ...config,
      infiniteQueries: {
        consumer: {
          unknown: infiniteSelection.infiniteQueries.consumer.listItems,
        },
      },
    }),
  );
  await assert.rejects(runProject(configFile), /belong to this client/);
  assert.deepEqual(await fileSnapshot(output), before);
  await writeFile(
    configFile,
    JSON.stringify({ ...config, infiniteQueries: {} }),
  );
  assert.equal((await runProject(configFile, { check: true })).clean, false);
  assert.deepEqual(await fileSnapshot(output), before);
  await runProject(configFile);
  assert.equal(
    Object.hasOwn(await fileSnapshot(output), 'query-runtime.ts'),
    false,
  );
  await writeFile(configFile, JSON.stringify(config));
  await runProject(configFile);
  await writeFile(
    join(output, 'client.consumer.queries.ts'),
    `${await readFile(join(output, 'client.consumer.queries.ts'), 'utf8')}\n// Application edit\n`,
  );
  await writeFile(
    configFile,
    JSON.stringify({ ...config, infiniteQueries: {} }),
  );
  const edited = await fileSnapshot(output);
  await assert.rejects(runProject(configFile), /modified/);
  assert.deepEqual(await fileSnapshot(output), edited);
});
