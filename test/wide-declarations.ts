import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { commandError } from './assertions.ts';
import { executionFixture, executionSelection } from './execution-fixture.ts';
import { object, ref } from './schema-helpers.ts';

const wideFieldCount = 1024;

export function wideDeclarationFixture() {
  const document = executionFixture();
  // Enough independent names to exceed declaration serialization limits when
  // inferred registries or factories expand their members' complete schemas.
  const fields = Array.from(
    { length: wideFieldCount },
    (_, index) => `field${index}`,
  );
  const aliases = Array.from({ length: 64 }, (_, index) => `Alias${index}`);
  Object.assign(document.components.schemas, {
    LargeLiteral: {
      type: 'string',
      enum: Array.from({ length: 2048 }, (_, index) => `v${index}`),
    },
    Wide: object(
      Object.fromEntries(fields.map((name) => [name, { type: 'string' }])),
    ),
    ...Object.fromEntries(aliases.map((name) => [name, ref('Wide')])),
    Rows: { type: 'array', items: ref('Wide'), maxItems: 3 },
    RowsAlias: { ...ref('Rows'), maxItems: 2 },
  });
  const queries: string[] = [...executionSelection.queries.consumer];
  for (const [index, name] of aliases.entries()) {
    const operation = {
      'x-pom': document.paths['/commands'].post['x-pom'],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: {
          description: 'Wide response',
          content: { 'application/json': { schema: ref(name) } },
        },
      },
    };
    Object.assign(document.paths, {
      [`/wide/${index}/{id}`]: {
        get: { ...operation, operationId: `readWide${index}` },
        post: {
          ...operation,
          operationId: `writeWide${index}`,
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref(name) } },
          },
        },
      },
    });
    queries.push(`readWide${index}`);
  }
  Object.assign(document.paths, {
    '/large-literal': {
      post: {
        operationId: 'checkLargeLiteral',
        'x-pom': document.paths['/commands'].post['x-pom'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('LargeLiteral') } },
        },
        responses: {
          200: {
            description: 'Large literal',
            content: { 'application/json': { schema: ref('LargeLiteral') } },
          },
        },
      },
    },
    '/rows': {
      post: {
        operationId: 'writeRows',
        'x-pom': document.paths['/commands'].post['x-pom'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('RowsAlias') } },
        },
        responses: {
          200: {
            description: 'Rows',
            content: { 'application/json': { schema: ref('RowsAlias') } },
          },
        },
      },
    },
  });
  return {
    document,
    selection: {
      ...executionSelection,
      clients: ['consumer'],
      executionClients: ['consumer'],
      queries: { consumer: queries },
    },
  };
}

// Shared by source tests and the installed minimum-peer consumer. Delete the
// producer sources before checking ordinary downstream application declarations.
export async function verifyWideDeclarations(
  directory: string,
  compiler: string,
): Promise<void> {
  const options = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    lib: ['ES2022', 'DOM'],
    types: [],
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    noPropertyAccessFromIndexSignature: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    skipLibCheck: false,
  };
  await writeFile(
    join(directory, 'wide-wrapper.ts'),
    `
    import { createClient, operations } from './wide-generated/client.consumer.ts';
    import { requestSchemas, responseSchemas } from './wide-generated/client.consumer.schemas.ts';
    import { createQueries, createInfiniteQueries } from './wide-generated/client.consumer.queries.ts';
    const config = { namespace: 'wide-publication', execute: async () => ({ status: 204, headers: {}, body: '' }) };
    export { operations, requestSchemas, responseSchemas };
    export const client = createClient(config);
    export const queries = createQueries(config);
    export const infinite = createInfiniteQueries(config);
    export const nested = { client, queries, infinite, operations, requestSchemas, responseSchemas };
    export function createApi() { return { client: createClient(config), queries: createQueries(config), infinite: createInfiniteQueries(config) }; }
  `,
  );
  const config = join(directory, 'wide-publication.json');
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        ...options,
        declaration: true,
        emitDeclarationOnly: true,
        rewriteRelativeImportExtensions: true,
        rootDir: '.',
        outDir: 'wide-publication',
      },
      files: ['wide-wrapper.ts'],
    }),
  );
  async function typecheck(listFiles = false) {
    try {
      return await promisify(execFile)(
        process.execPath,
        [compiler, '-p', config, ...(listFiles ? ['--listFiles'] : [])],
        { cwd: directory, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      );
    } catch (error) {
      const failure = commandError(error);
      failure.message += `\n${failure.stdout}${failure.stderr}`;
      throw failure;
    }
  }
  await typecheck();
  // Generated modules must also publish without inference across files. The
  // application wrapper above deliberately exercises ordinary inferred exports.
  const parserConfig = join(directory, 'parser-types.json');
  await writeFile(
    parserConfig,
    JSON.stringify({
      compilerOptions: {
        ...options,
        declaration: true,
        emitDeclarationOnly: true,
        isolatedDeclarations: true,
        rewriteRelativeImportExtensions: true,
        rootDir: 'wide-generated',
        outDir: 'parser-types',
        noUnusedLocals: false,
      },
      include: ['wide-generated/*.ts'],
    }),
  );
  const checkParsers = () =>
    promisify(execFile)(process.execPath, [compiler, '-p', parserConfig], {
      cwd: directory,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  await checkParsers();
  const parserFile = join(
    directory,
    'wide-generated/client.consumer.schemas.ts',
  );
  const originalSource = await readFile(parserFile, 'utf8');
  const literalStart = originalSource.indexOf(
    'export const parse_LargeLiteral_request:',
  );
  assert.ok(literalStart >= 0);
  const literalMember = originalSource.indexOf("'v0'", literalStart);
  assert.ok(literalMember >= 0);
  const corruptions = [
    originalSource.replace(
      '{ id: stringValue, label: stringValue }',
      '{ id: integerValue, label: stringValue }',
    ),
    originalSource.replace('field0: stringValue', 'field0: integerValue'),
    originalSource.slice(0, literalMember) +
      "'undeclared'" +
      originalSource.slice(literalMember + "'v0'".length),
  ];
  try {
    for (const corrupted of corruptions) {
      assert.notEqual(
        corrupted,
        originalSource,
        'negative control must change a parser output or constructor table',
      );
      await writeFile(parserFile, corrupted);
      await assert.rejects(checkParsers(), (error: unknown) => {
        const failure = commandError(error);
        return failure.code === 2 && /error TS2322/.test(failure.stdout);
      });
    }
  } finally {
    await writeFile(parserFile, originalSource);
  }
  await rm(join(directory, 'wide-generated'), { recursive: true });
  await rm(join(directory, 'wide-wrapper.ts'));
  await writeFile(
    join(directory, 'wide-consumer.ts'),
    `
    import type { Validator } from './wide-publication/wide-generated/runtime.js';
    import { client, queries, infinite, nested, createApi, operations, requestSchemas, responseSchemas } from './wide-publication/wide-wrapper.js';
    import type { Client, RequestTypes, ResponseTypes } from './wide-publication/wide-generated/client.consumer.js';
    import type { Queries, InfiniteQueries } from './wide-publication/wide-generated/client.consumer.queries.js';
    import type { ExecutionClient } from './wide-publication/wide-generated/call-runtime.js';
    import type { QueryFactories } from './wide-publication/wide-generated/query-runtime.js';
    const api = createApi();
    const sameClient: Client = api.client;
    const sameQueries: Queries = api.queries;
    const sameInfinite: InfiniteQueries = api.infinite;
    const dictionaries: Record<string, unknown>[] = [client, queries, infinite, nested, requestSchemas, responseSchemas];
    void [sameClient, sameQueries, sameInfinite, dictionaries];
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    type Expect<T extends true> = T;
    export type ClientShape = Expect<Equal<typeof client, ExecutionClient<typeof operations>>>;
    export type QueryShape = Expect<Equal<typeof queries, QueryFactories<Pick<typeof operations, keyof typeof queries>>>>;
    export type RequestFields = Expect<Equal<keyof RequestTypes['Alias63'], ${Array.from({ length: wideFieldCount }, (_, index) => JSON.stringify('field' + index)).join(' | ')}>>;
    export type ResponseFields = Expect<Equal<keyof ResponseTypes['Alias63'], keyof RequestTypes['Alias63']>>;
    export type LiteralFields = Expect<Equal<RequestTypes['LargeLiteral'], ${Array.from({ length: 2048 }, (_, index) => JSON.stringify('v' + index)).join(' | ')}>>;
    const literal: ResponseTypes['LargeLiteral'] = 'v2047';
    // @ts-expect-error Large literal membership remains exact.
    const wrongLiteral: RequestTypes['LargeLiteral'] = 'v2048';
    void [literal, wrongLiteral];
    const request: Validator<RequestTypes['Wide'][]> = requestSchemas.RowsAlias;
    const response = responseSchemas.RowsAlias;
    const output: ResponseTypes['Wide'][] = response.parse([]);
    void [request, output];
    // @ts-expect-error All wide fields remain required.
    const missing: RequestTypes['Alias63'] = {};
    void missing;
    // @ts-expect-error Array element types remain precise.
    const wrongArray: Parameters<typeof operations.writeRows.build>[0] = { body: [{}] };
    void wrongArray;
    // @ts-expect-error The operation needs its path input.
    client.readWide63.call({ context: {} });
    // @ts-expect-error A required request body must not become optional.
    client.writeWide63.call({ context: {}, input: { path: { id: 'one' } } });
    // @ts-expect-error Factories remain readonly.
    client.readWide63 = client.readWide0;
    // @ts-expect-error Query factories remain readonly.
    queries.readWide63 = queries.readWide0;
    // @ts-expect-error Infinite factories remain readonly.
    infinite.listItems = infinite.listItems;
    // @ts-expect-error Schema registries remain readonly.
    requestSchemas.Alias63 = requestSchemas.Alias0;
    // @ts-expect-error Query membership stays exact.
    void queries.writeWide63;
    // @ts-expect-error Registry keys stay exact.
    void responseSchemas.Unknown;
    export async function readLastField() {
      const result = await nested.client.readWide63.call({ context: {}, input: { path: { id: 'one' } } });
      const status: 200 = result.status;
      const value: string = result.data.field255;
      // @ts-expect-error Fields outside the contract are absent.
      void result.data.unknown;
      return { status, value };
    }
    const cursor = infinite.listItems.options({ context: {}, input: { path: { collection: 'items' } } });
    const offset = infinite.listRecords.options({ context: {}, input: { path: { category: 'records' } } });
    const firstCursor: null = cursor.initialPageParam;
    const firstOffset: 0 = offset.initialPageParam;
    void [firstCursor, firstOffset];
    // @ts-expect-error Infinite inputs retain required path parameters.
    infinite.listItems.options({ context: {} });
  `,
  );
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        ...options,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      files: ['wide-consumer.ts'],
    }),
  );
  const consumer = await typecheck(true);
  const original = resolve(directory, 'wide-generated') + sep;
  assert.ok(
    !consumer.stdout.split(/\r?\n/).some((line) => line.startsWith(original)),
    'declaration consumers must not resolve producer sources',
  );
}
