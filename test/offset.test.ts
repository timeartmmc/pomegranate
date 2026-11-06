import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { QueryClient } from '@tanstack/query-core';
import { compile, runProject } from '../dist/index.js';
import { invalidOptions } from './assertions.ts';
import { temporary, fileSnapshot } from './helpers.ts';
import { offsetFixture, offsetSelection } from './offset-fixture.ts';
import { offsetArgs, offsetChecks } from './offset-checks.ts';
import { infiniteFixture, infiniteSelection } from './infinite-fixture.ts';
import { verifyQueryDeclarations } from './query-declarations.ts';
import { generatedWorkspace } from './generated-workspace.ts';

type Module = typeof import('./.generated/offset/client.consumer.queries.ts');
const exec = promisify(execFile);
const compiler = fileURLToPath(
  new URL('../node_modules/typescript/bin/tsc', import.meta.url),
);
let root: string;
let module: Module;

before(async () => {
  root = await generatedWorkspace(
    await compile(infiniteFixture(), infiniteSelection),
    'query-generated',
  );
  const directory = join(root, 'offset-generated');
  await mkdir(directory);
  for (const [name, source] of Object.entries(
    await compile(offsetFixture(), offsetSelection),
  ))
    await writeFile(join(directory, name), source);
  module = (await import(
    pathToFileURL(join(directory, 'client.consumer.queries.ts')).href
  )) as Module;
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
for (const [name, check] of Object.entries(offsetChecks))
  void test(name, async () => {
    await check(module);
  });

void test('offset sources and published declarations retain numeric parameters, item types and skip inference', async () => {
  await writeFile(
    join(root, 'offset-types.ts'),
    await readFile(new URL('./offset-types.ts', import.meta.url), 'utf8'),
  );
  const config = join(root, 'offset-types.json');
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        types: ['node'],
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ['offset-types.ts'],
    }),
  );
  await exec(process.execPath, [compiler, '-p', config]);
  await verifyQueryDeclarations(
    root,
    compiler,
    fileURLToPath(new URL('./query-types.ts', import.meta.url)),
    fileURLToPath(new URL('./infinite-types.ts', import.meta.url)),
    fileURLToPath(new URL('./offset-types.ts', import.meta.url)),
  );
});

void test('offset bindings diagnose incomplete, mixed and ambiguous fields', async () => {
  const binding = offsetSelection.infiniteQueries.consumer.listRecords;
  for (const [bad, field, detail] of [
    [{ offset: 'start' }, '.responseOffset', /expected a nonempty string/],
    [
      { ...binding, offset: 'missing' },
      '.offset',
      /offset must name a nonnullable integer query parameter/,
    ],
    [
      { ...binding, responseOffset: '' },
      '.responseOffset',
      /expected a nonempty string/,
    ],
    [
      { ...binding, responseLimit: 'start' },
      '',
      /offset pagination response fields must be distinct/,
    ],
    [
      { ...binding, total: 'entries' },
      '',
      /offset pagination response fields must be distinct/,
    ],
    [
      { ...binding, cursor: 'cursor' },
      '.cursor',
      /unsupported keyword; supported keys:/,
    ],
    [
      { ...binding, nextCursor: 'next' },
      '.nextCursor',
      /unsupported keyword; supported keys:/,
    ],
    [
      { ...binding, typo: 'value' },
      '.typo',
      /unsupported keyword; supported keys:/,
    ],
  ] as const)
    await assert.rejects(
      invalidOptions(compile, offsetFixture(), {
        ...offsetSelection,
        infiniteQueries: { consumer: { listRecords: bad } },
      }),
      {
        name: 'ContractError',
        location: `infiniteQueries.consumer.listRecords${field}`,
        message: detail,
      },
    );
});

void test('offset contracts reject unsupported request and success shapes rather than silently dropping pages', async () => {
  const mutations: readonly [
    (document: ReturnType<typeof offsetFixture>) => void,
    string,
    string,
  ][] = [
    [
      (d) => {
        // Keep the neighboring header valid so this reaches pagination binding
        // validation rather than failing the header's source schema first.
        Object.assign(d.paths['/records/{category}'].get.parameters[1]!, {
          in: 'header',
          schema: { type: 'string' },
        });
      },
      '.offset',
      'offset must name a nonnullable integer query parameter',
    ],
    [
      (d) => {
        Object.assign(d.paths['/records/{category}'].get.parameters[1]!, {
          schema: { type: 'number' },
        });
      },
      '.offset',
      'offset must name a nonnullable integer query parameter',
    ],
    [
      (d) => {
        Object.assign(d.paths['/records/{category}'].get.parameters[1]!, {
          schema: { type: ['integer', 'null'] },
        });
      },
      '.offset',
      'offset must name a nonnullable integer query parameter',
    ],
    ...[
      { type: 'integer', minimum: 1 },
      { type: 'integer', maximum: -1 },
      { type: 'integer', exclusiveMinimum: 0 },
      { type: 'integer', enum: [1, 2] },
    ].map(
      (
        schema,
      ): [
        (document: ReturnType<typeof offsetFixture>) => void,
        string,
        string,
      ] => [
        (d) => {
          Object.assign(d.paths['/records/{category}'].get.parameters[1]!, {
            schema,
          });
        },
        '.offset',
        'offset schema must accept the initial value 0',
      ],
    ),
    [
      (d) => {
        d.components.schemas.Page.required = [
          'entries',
          'start',
          'size',
          'next',
        ];
      },
      '.responses.200.content.application/json',
      'pagination field "count" must be required',
    ],
    [
      (d) => {
        d.components.schemas.PartialPage.required = [
          'entries',
          'start',
          'size',
          'next',
          'segment',
        ];
      },
      '.responses.206.content.application/json',
      'pagination field "count" must be required',
    ],
    [
      (d) => {
        Object.assign(d.components.schemas.Page.properties.count, {
          type: 'number',
        });
      },
      '.responses.200.content.application/json.count',
      'offset pagination metadata must name required nonnullable integer fields',
    ],
    [
      (d) => {
        Object.assign(d.components.schemas.Page.properties.size, {
          type: ['integer', 'null'],
        });
      },
      '.responses.200.content.application/json.size',
      'offset pagination metadata must name required nonnullable integer fields',
    ],
    [
      (d) => {
        Object.assign(d.components.schemas.Page.properties.entries, {
          type: 'string',
        });
        Reflect.deleteProperty(
          d.components.schemas.Page.properties.entries,
          'items',
        );
      },
      '.responses.200.content.application/json.entries',
      'items must name an array field',
    ],
    [
      (d) => {
        Object.assign(d.paths['/records/{category}'].get.responses, {
          204: { description: 'Bodyless' },
        });
      },
      '.responses.204',
      'every infinite-query success must have a JSON object body',
    ],
  ];
  for (const [mutate, field, detail] of mutations) {
    const document = offsetFixture();
    mutate(document);
    const location = `infiniteQueries.consumer.listRecords${field}`;
    await assert.rejects(compile(document, offsetSelection), {
      name: 'ContractError',
      location,
      message: `${location}: ${detail}`,
    });
  }
  const document = offsetFixture();
  Object.assign(document.components.schemas, {
    Origin: { type: 'integer', minimum: 1 },
  });
  Object.assign(document.paths['/records/{category}'].get.parameters[1]!, {
    schema: { $ref: '#/components/schemas/Origin' },
  });
  const location = 'infiniteQueries.consumer.listRecords.offset';
  const expected = {
    name: 'ContractError',
    location,
    message: `${location}: offset schema must accept the initial value 0`,
  };
  await assert.rejects(compile(document, offsetSelection), expected);
  Object.assign(document.components.schemas, {
    Origin: { type: 'integer', minimum: 0 },
  });
  Object.assign(document.paths['/records/{category}'].get.parameters[1]!, {
    schema: { $ref: '#/components/schemas/Origin', exclusiveMinimum: 0 },
  });
  await assert.rejects(compile(document, offsetSelection), expected);
});

void test('required referenced offsets support zero without inserting annotated request defaults', async () => {
  const document = offsetFixture();
  Object.assign(document.components.schemas, {
    Origin: { type: 'integer', minimum: 0, maximum: 10 },
  });
  Object.assign(document.paths['/records/{category}'].get.parameters[1]!, {
    required: true,
    schema: { $ref: '#/components/schemas/Origin' },
  });
  const files = await compile(document, offsetSelection);
  assert.match(files['client.consumer.queries.ts']!, /defineOffsetQuery/);
  assert.doesNotMatch(
    files['client.staff.queries.ts'] ?? '',
    /defineOffsetQuery/,
  );
  assert.deepEqual(
    files,
    await compile(document, {
      ...offsetSelection,
      infiniteQueries: {
        consumer: {
          listRecords: {
            ...offsetSelection.infiniteQueries.consumer.listRecords,
          },
        },
      },
    }),
  );
});

void test('one client can mix cursor and offset profiles, including an offset-only required request', async (t) => {
  const document = offsetFixture();
  const operation = document.paths['/records/{category}'].get;
  Object.assign(document.paths, {
    '/offset-only': {
      get: {
        ...operation,
        operationId: 'offsetOnly',
        parameters: [{ ...operation.parameters[1], required: true }],
      },
    },
    '/cursor-only': {
      get: {
        ...operation,
        operationId: 'cursorOnly',
        parameters: operation.parameters.filter(
          (parameter) => parameter.in !== 'path',
        ),
      },
    },
  });
  const files = await compile(document, {
    ...offsetSelection,
    infiniteQueries: {
      consumer: {
        listRecords: offsetSelection.infiniteQueries.consumer.listRecords,
        offsetOnly: offsetSelection.infiniteQueries.consumer.listRecords,
        cursorOnly: { cursor: 'cursor', nextCursor: 'next', items: 'entries' },
      },
    },
  });
  const directory = await generatedWorkspace(files);
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'consumer.ts'),
    `
    import assert from 'node:assert/strict';
    import {QueryClient} from '@tanstack/query-core';
    import {createInfiniteQueries} from './client.consumer.queries.ts';
    const seen: string[] = [];
    const queries = createInfiniteQueries({namespace: 'mixed', execute: async request => {
      seen.push(request.url);
      return {status: 200, headers: {'Content-Type':'application/json'}, body: JSON.stringify({entries:[{id:'one'}],start:0,size:2,count:1,next:null})};
    }});
    const offset = queries.offsetOnly.options({context:{}});
    const cursor = queries.cursorOnly.options({context:{}});
    const zero:0 = offset.initialPageParam;
    const omitted:null = cursor.initialPageParam;
    void [zero, omitted];
    const client = new QueryClient({defaultOptions:{queries:{gcTime:Infinity}}});
    try {
      const offsets = await client.fetchInfiniteQuery(offset);
      const cursors = await client.fetchInfiniteQuery(cursor);
      const numeric:number|undefined = offsets.pageParams[0];
      const text:string|null|undefined = cursors.pageParams[0];
      void [numeric, text];
      assert.deepEqual(offsets.pageParams,[0]);
      assert.deepEqual(cursors.pageParams,[null]);
      assert.deepEqual(seen,['/offset-only?start=0','/cursor-only']);
    } finally {client.clear();}
  `,
  );
  await writeFile(
    join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        types: ['node'],
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ['*.ts'],
    }),
  );
  await exec(process.execPath, [
    compiler,
    '-p',
    join(directory, 'tsconfig.json'),
  ]);
  await exec(process.execPath, [join(directory, 'consumer.ts')]);
});

void test('ordinary, cursor and offset factories isolate cache families even when their initial URLs agree', async (t) => {
  const cursorFiles = await compile(offsetFixture(), {
    ...offsetSelection,
    infiniteQueries: {
      consumer: {
        listRecords: { cursor: 'cursor', nextCursor: 'next', items: 'entries' },
      },
    },
  });
  const directory = await generatedWorkspace(cursorFiles);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = {
    namespace: 'same',
    execute: async () => ({ status: 200, headers: {}, body: '' }),
  };
  const cursorModule = (await import(
    pathToFileURL(join(directory, 'client.consumer.queries.ts')).href
  )) as {
    createInfiniteQueries: (options: typeof config) => {
      listRecords: {
        key: (args: {
          context: {};
          input: { path: { category: string }; query: { start: number } };
        }) => readonly unknown[];
      };
    };
  };
  const cursorFactory = cursorModule.createInfiniteQueries(config).listRecords;
  const offsets = module.createInfiniteQueries(config).listRecords;
  const ordinary = module.createQueries(config).listRecords;
  const offsetKey = offsets.key(offsetArgs());
  const cursorKey = cursorFactory.key({
    ...offsetArgs(),
    input: { path: { category: 'a/b' }, query: { start: 0 } },
  });
  const ordinaryKey = ordinary.key({
    ...offsetArgs(),
    input: { path: { category: 'a/b' }, query: { start: 0 } },
  });
  assert.deepEqual(offsetKey.slice(1), cursorKey.slice(1));
  assert.deepEqual(offsetKey.slice(1), ordinaryKey.slice(1));
  assert.deepEqual(
    [offsetKey[0], cursorKey[0], ordinaryKey[0]],
    ['pom-offset-v1', 'pom-infinite-v1', 'pom-query-v1'],
  );
  const cache = new QueryClient();
  try {
    for (const key of [offsetKey, cursorKey, ordinaryKey])
      cache.setQueryData(key, { value: true });
    assert.equal(
      cache.getQueryCache().findAll(offsets.filter({ allContexts: true }))
        .length,
      1,
    );
    assert.equal(
      cache.getQueryCache().findAll(ordinary.filter({ allContexts: true }))
        .length,
      1,
    );
  } finally {
    cache.clear();
  }
});

void test('offset output drift is read-only and cleanup preserves application edits', async (t) => {
  const directory = await temporary(t);
  const config = {
    version: 2,
    openapi: './openapi.json',
    output: './generated',
    ...offsetSelection,
    queries: {},
  };
  const path = join(directory, 'pom.json');
  await writeFile(
    join(directory, 'openapi.json'),
    JSON.stringify(offsetFixture()),
  );
  await writeFile(path, JSON.stringify(config));
  await runProject(path);
  const output = join(directory, 'generated');
  const before = await fileSnapshot(output);
  await writeFile(path, JSON.stringify({ ...config, infiniteQueries: {} }));
  assert.equal((await runProject(path, { check: true })).clean, false);
  assert.deepEqual(await fileSnapshot(output), before);
  await runProject(path);
  assert.equal(
    Object.hasOwn(await fileSnapshot(output), 'query-runtime.ts'),
    false,
  );
  await writeFile(path, JSON.stringify(config));
  await runProject(path);
  await writeFile(
    join(output, 'client.consumer.queries.ts'),
    `${await readFile(join(output, 'client.consumer.queries.ts'), 'utf8')}\n// Application edit\n`,
  );
  await writeFile(path, JSON.stringify({ ...config, infiniteQueries: {} }));
  const edited = await fileSnapshot(output);
  await assert.rejects(runProject(path), /modified/);
  assert.deepEqual(await fileSnapshot(output), edited);
});
