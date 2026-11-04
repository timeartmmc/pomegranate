import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { QueryClient } from '@tanstack/query-core';
import { compile, ContractError, runProject } from '../dist/index.js';
import { invalidOptions, runtimeInput } from './assertions.ts';
import { temporary, fileSnapshot } from './helpers.ts';
import { infiniteFixture, infiniteSelection } from './infinite-fixture.ts';
import { infiniteChecks } from './infinite-checks.ts';
import { verifyQueryDeclarations } from './query-declarations.ts';
import { generatedWorkspace } from './generated-workspace.ts';
import { nullable, ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

type Module = typeof import('./.generated/infinite/client.consumer.queries.ts');
const exec = promisify(execFile);
let root: string;
let module: Module;

before(async () => {
  root = await generatedWorkspace(
    await compile(infiniteFixture(), infiniteSelection),
    'query-generated',
  );
  module = (await import(
    pathToFileURL(join(root, 'query-generated/client.consumer.queries.ts')).href
  )) as Module;
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

for (const [name, check] of Object.entries(infiniteChecks))
  void test(name, async () => {
    await check(module);
  });

async function checkConsumer(
  t: TestContext,
  files: Readonly<Record<string, string>>,
  consumer = '',
) {
  const root = await generatedWorkspace(files);
  t.after(() => rm(root, { recursive: true, force: true }));
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

void test('infinite inputs reject missing, unknown and cursor-owned fields', () => {
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

void test('infinite declarations preserve factories, options and item types', async () => {
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
  const root = await generatedWorkspace(
    await compile(document, infiniteSelection),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
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
          { schema: { type: ['integer', 'null'] } },
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
        Object.assign(d.components.schemas.Page.properties, {
          continuation: {
            anyOf: [{ type: 'string' }, { type: 'integer' }],
          },
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

const cursorString = { type: 'string', maxLength: 4 };
const nullableCursors: [string, Schema, Record<string, Schema>][] = [
  ['type array', { ...cursorString, type: ['string', 'null'] }, {}],
  ['reversed type array', { ...cursorString, type: ['null', 'string'] }, {}],
  ['anyOf', nullable(cursorString), {}],
  ['null-first anyOf', { anyOf: [{ type: 'null' }, cursorString] }, {}],
  [
    'reference aliases',
    ref('CursorAlias'),
    { CursorAlias: ref('Cursor'), Cursor: nullable(cursorString) },
  ],
  [
    'referenced branches with constraints',
    { anyOf: [ref('NoCursor'), { ...ref('CursorString'), maxLength: 4 }] },
    { NoCursor: { type: 'null' }, CursorString: { type: 'string' } },
  ],
];

for (const [name, schema, definitions] of nullableCursors)
  void test(`nullable cursor ${name} preserves request and response validation`, async (t) => {
    const document = infiniteFixture();
    Object.assign(document.components.schemas, definitions);
    Object.assign(
      document.paths['/collections/{collection}/items'].get.parameters[1]!,
      { schema },
    );
    // Exercise the same nullable shape on both sides of the binding.
    Object.assign(document.components.schemas.Page.properties, {
      continuation: schema,
    });
    const before = structuredClone(document);
    const files = await compile(document, infiniteSelection);
    assert.deepEqual(document, before);
    const root = await generatedWorkspace(files);
    t.after(() => rm(root, { recursive: true, force: true }));
    const { operations } = (await import(
      pathToFileURL(join(root, 'client.consumer.operations.ts')).href
    )) as typeof import('./.generated/infinite/client.consumer.operations.ts');
    const input = { path: { collection: 'widgets' } };
    for (const after of [undefined, null, '', 'next']) {
      const request = runtimeInput(operations.listItems.build, {
        ...input,
        ...(after === undefined ? {} : { query: { after } }),
      });
      assert.equal(
        new URL(request.url, 'https://synthetic.invalid').searchParams.get(
          'after',
        ),
        after ?? null,
      );
      const result = request.parseResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ results: [], continuation: after ?? null }),
      });
      assert.equal(result.kind, 'success');
    }
    for (const after of ['longer', false, 0, []]) {
      assert.throws(
        () =>
          runtimeInput(operations.listItems.build, {
            ...input,
            query: { after },
          }),
        { name: 'RequestValidationError' },
      );
      assert.equal(
        operations.listItems.build(input).parseResponse({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ results: [], continuation: after }),
        }).kind,
        'protocol',
      );
    }
  });

void test('nullable cursor types admit null only in full inputs and preserve page parameter types', async (t) => {
  const document = infiniteFixture();
  Object.assign(document.components.schemas, {
    Cursor: nullable(cursorString),
    CursorAlias: ref('Cursor'),
  });
  Object.assign(
    document.paths['/collections/{collection}/items'].get.parameters[1]!,
    { schema: ref('CursorAlias') },
  );
  await checkConsumer(
    t,
    await compile(document, infiniteSelection),
    `
    import { QueryClient } from '@tanstack/query-core';
    import { operations } from './client.consumer.operations.ts';
    import { createQueries, createInfiniteQueries } from './client.consumer.queries.ts';
    const config = { namespace: 'nullable', execute: async () => ({ status: 200, headers: {}, body: '' }) };
    const input = { path: { collection: 'items' }, query: { after: null } };
    operations.listItems.build(input);
    const ordinary = createQueries(config).listItems;
    ordinary.options({ context: {}, input });
    ordinary.body().key({ context: {}, input });
    // @ts-expect-error Nullability does not admit other scalar types.
    operations.listItems.build({ path: input.path, query: { after: 0 } });
    const infinite = createInfiniteQueries(config).listItems;
    // @ts-expect-error Null remains pagination-owned in base inputs.
    infinite.options({ context: {}, input: { path: input.path, query: { after: null } } });
    // @ts-expect-error Body storage has the same base input restriction.
    infinite.body().key({ context: {}, input: { path: input.path, query: { after: null } } });
    const args = { context: {}, input: { path: input.path } };
    const initial: null = infinite.options(args).initialPageParam;
    const cache = new QueryClient();
    const envelopes = cache.getQueryData(infinite.key(args));
    const bodies = cache.getQueryData(infinite.body().key(args));
    const envelopeParam: string | null | undefined = envelopes?.pageParams[0];
    const bodyParam: string | null | undefined = bodies?.pageParams[0];
    // @ts-expect-error Nullable request schemas do not widen page parameters.
    const numericParam: number = bodies!.pageParams[0]!;
    void [initial, envelopeParam, bodyParam, numericParam];
  `,
  );
});

void test('nullable cursor defaults and literal narrowing retain ordinary request semantics', async (t) => {
  for (const schema of [
    { type: ['string', 'null'], default: null },
    { type: ['string', 'null'], default: 'seed' },
    { type: ['string', 'null'], enum: ['next', null] },
    { type: ['string', 'null'], enum: ['next'] },
    { type: ['string', 'null'], const: 'next' },
  ]) {
    const document = infiniteFixture();
    Object.assign(
      document.paths['/collections/{collection}/items'].get.parameters[1]!,
      { schema },
    );
    const root = await generatedWorkspace(
      await compile(document, infiniteSelection),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const generated = (await import(
      pathToFileURL(join(root, 'client.consumer.queries.ts')).href
    )) as Module;
    const { operations } = (await import(
      pathToFileURL(join(root, 'client.consumer.operations.ts')).href
    )) as typeof import('./.generated/infinite/client.consumer.operations.ts');
    const input = { path: { collection: 'items' } };
    operations.listItems.build({ ...input, query: { after: 'next' } });
    const buildNull = () =>
      runtimeInput(operations.listItems.build, {
        ...input,
        query: { after: null },
      });
    if ('const' in schema || ('enum' in schema && !schema.enum.includes(null)))
      assert.throws(buildNull, { name: 'RequestValidationError' });
    else assert.equal(buildNull().url.includes('after='), false);
    if ('const' in schema || 'enum' in schema)
      assert.throws(
        () =>
          operations.listItems.build({ ...input, query: { after: 'other' } }),
        { name: 'RequestValidationError' },
      );
    let calls = 0;
    const options = generated
      .createInfiniteQueries({
        namespace: 'nullable-literals',
        execute: async (request) => {
          calls++;
          const after = new URL(
            request.url,
            'https://synthetic.invalid',
          ).searchParams.get('after');
          assert.equal(after, calls === 1 ? null : 'next');
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              results: [],
              continuation: after === null ? 'next' : null,
            }),
          };
        },
      })
      .listItems.options({
        context: {},
        input,
      });
    const client = new QueryClient();
    try {
      const result = await client.fetchInfiniteQuery({ ...options, pages: 3 });
      assert.deepEqual(result.pageParams, [null, 'next']);
      assert.equal(calls, 2);
    } finally {
      client.clear();
    }
  }
});

void test('nullable cursor bindings reject neighboring scalar types and required presence', async () => {
  for (const type of ['number', 'integer', 'boolean']) {
    const document = infiniteFixture();
    Object.assign(
      document.paths['/collections/{collection}/items'].get.parameters[1]!,
      { schema: { type: [type, 'null'] } },
    );
    await assert.rejects(compile(document, infiniteSelection), {
      name: 'ContractError',
      message:
        /\.cursor: cursor must name an optional string or nullable string query parameter/,
    });
  }
  for (const schema of [
    { type: ['string', 'null'] },
    nullable({ type: 'string' }),
    ref('Cursor'),
  ]) {
    const document = infiniteFixture();
    Object.assign(document.components.schemas, {
      Cursor: nullable({ type: 'string' }),
    });
    Object.assign(
      document.paths['/collections/{collection}/items'].get.parameters[1]!,
      { required: true, schema },
    );
    await assert.rejects(
      compile(document, infiniteSelection),
      /nullable query parameters must be optional/,
    );
  }
  for (const schema of [
    { type: ['string', 'null'], const: null },
    { type: ['string', 'null'], enum: [null] },
  ]) {
    const document = infiniteFixture();
    Object.assign(
      document.paths['/collections/{collection}/items'].get.parameters[1]!,
      { schema },
    );
    await assert.rejects(
      compile(document, infiniteSelection),
      /parameters require primitive schemas/,
    );
  }
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
    JSON.stringify(infiniteFixture(true)),
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
