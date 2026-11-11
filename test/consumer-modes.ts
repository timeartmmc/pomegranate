import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { executionFixture, executionSelection } from './execution-fixture.ts';
import type { Schema } from './schema-helpers.ts';

export function consumerModesFixture() {
  const document = executionFixture();
  const schemas: Record<string, Schema> = {};
  const standalone: Record<
    string,
    { schema: string; usage: 'request' | 'response' }
  > = {};
  schemas.NullFields = {
    type: 'object',
    required: ['required'],
    properties: {
      required: { type: 'null' },
      optional: { type: 'null' },
      read: { type: 'null', readOnly: true },
      write: { type: 'null', writeOnly: true },
    },
  };
  for (const usage of ['request', 'response'] as const)
    standalone[`null-${usage}`] = {
      schema: '#/components/schemas/NullFields',
      usage,
    };
  const operation = (name: string, operationId: string) => {
    const content = {
      'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
    };
    return {
      operationId,
      'x-pom': {
        auth: 'session',
        retry: 'never',
        timeout: 'interactive',
        surfaces: ['consumer'],
      },
      requestBody: { required: true, content },
      responses: { 200: { description: 'Synthetic null fields', content } },
    };
  };
  Object.assign(document.paths, {
    '/nulls': { post: operation('NullFields', 'saveNulls') },
  });
  schemas.NullValue = { type: 'null' };
  schemas.NullAlias = { $ref: '#/components/schemas/NullValue' };
  // Exercise both sides of the table/chunk boundary with direct, aliased and
  // literal null-only fields. The consumer checks run on both TypeScript lines.
  for (const width of [128, 129]) {
    const name = `WideNull${width}`;
    schemas[name] = {
      type: 'object',
      required: ['direct', 'reference', 'enumeration', 'constant'],
      properties: Object.fromEntries(
        Array.from({ length: width }, (_, index): [string, Schema] => {
          if (index === 0) return ['direct', { type: 'null' }];
          if (index === 1) return ['optional', { type: 'null' }];
          if (index === 63)
            return ['reference', { $ref: '#/components/schemas/NullAlias' }];
          if (index === 64)
            return ['enumeration', { type: ['string', 'null'], enum: [null] }];
          if (index === width - 1)
            return ['constant', { type: ['number', 'null'], const: null }];
          return [`field${index}`, { type: 'string' }];
        }),
      ),
    };
    for (const usage of ['request', 'response'] as const)
      standalone[`wide-null${width}-${usage}`] = {
        schema: `#/components/schemas/${name}`,
        usage,
      };
    Object.assign(document.paths, {
      [`/nulls-${width}`]: {
        post: operation(name, `saveWideNull${width}`),
      },
    });
  }
  // Distinct chains exercise flattened rule dependencies, pure links and shared
  // ancestors in both directions, without depending on a random seed.
  for (let index = 0; index < 21; index++) {
    const base = `Base${index}`;
    const middle = `Middle${index}`;
    const end = `End${index}`;
    schemas[base] = { type: 'string', minLength: 1 };
    schemas[middle] = { $ref: `#/components/schemas/${base}`, maxLength: 32 };
    schemas[end] = {
      $ref: `#/components/schemas/${middle}`,
      pattern: '^[a-z]+$',
      minLength: 2,
    };
    const root = `Root${index}`;
    schemas[root] =
      index % 3 === 0
        ? { $ref: `#/components/schemas/${end}` }
        : {
            type: 'object',
            properties: { value: { $ref: `#/components/schemas/${end}` } },
            required: ['value'],
          };
    standalone[`root${index}`] = {
      schema: `#/components/schemas/${root}`,
      usage: index % 2 === 0 ? 'request' : 'response',
    };
  }
  Object.assign(document.components.schemas, schemas);
  const item = {
    description: 'An item',
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/Item' } },
    },
  };
  const empty = { description: 'No response body' };
  const queryResponses = {
    mixedBody: { 200: item, 204: empty },
    defaultBody: { default: item },
    defaultEmpty: { 200: item, default: empty },
    rangedBody: { '2XX': item, default: empty },
    rangedEmpty: { 200: item, '2XX': empty },
    nullBody: {
      200: {
        description: 'JSON null is a body',
        content: { 'application/json': { schema: { type: 'null' } } },
      },
    },
    textBody: {
      200: {
        description: 'A text body',
        content: { 'text/plain': { schema: { type: 'string' } } },
      },
    },
    requiredQuery: { 200: item },
  };
  Object.assign(
    document.paths,
    Object.fromEntries(
      Object.entries(queryResponses).map(([operationId, responses]) => [
        `/consumer-modes/${operationId}`,
        {
          get: {
            operationId,
            'x-pom': {
              auth: 'session',
              retry: 'never',
              timeout: 'interactive',
              surfaces: ['consumer'],
            },
            parameters: [
              {
                name: 'page',
                in: 'query',
                required: operationId === 'requiredQuery',
                schema: { type: 'integer' },
              },
            ],
            responses,
          },
        },
      ]),
    ),
  );
  const items = document.paths['/collections/{collection}/items'].get;
  const records = document.paths['/records/{category}'].get;
  Object.assign(document.paths, {
    '/consumer-modes/unscoped-items': {
      get: {
        ...items,
        operationId: 'unscopedItems',
        parameters: items.parameters.filter(({ name }) => name === 'after'),
      },
    },
    '/consumer-modes/unscoped-records': {
      get: {
        ...records,
        operationId: 'unscopedRecords',
        parameters: records.parameters.filter(({ name }) => name === 'start'),
      },
    },
  });
  return {
    document,
    options: {
      ...executionSelection,
      standalone,
      queries: {
        ...executionSelection.queries,
        consumer: [
          ...executionSelection.queries.consumer,
          ...Object.keys(queryResponses),
        ],
      },
      infiniteQueries: {
        consumer: {
          ...executionSelection.infiniteQueries.consumer,
          unscopedItems: executionSelection.infiniteQueries.consumer.listItems,
          unscopedRecords:
            executionSelection.infiniteQueries.consumer.listRecords,
        },
      },
    },
  };
}

export async function verifyConsumerModes(
  root: string,
  compiler: string,
  apiModule: string,
): Promise<void> {
  await writeFile(
    join(root, 'compiler-api.ts'),
    `
    import {compile, runProject} from ${JSON.stringify(apiModule)};
    import type {CompileOptions} from ${JSON.stringify(apiModule)};
    export const options: CompileOptions = {clients: []};
    export const output: ReturnType<typeof compile> = compile({}, options);
    export const project: typeof runProject = runProject;
  `,
  );
  await writeFile(
    join(root, 'generated-api.ts'),
    `import { QueryClient, skipToken } from '@tanstack/query-core';
    import { createClient, operations } from './client.consumer.ts';
    import { createQueries, createInfiniteQueries } from './client.consumer.queries.ts';
    import { schema } from './standalone.root0.ts';
    import type { QueryFactory } from './query-runtime.ts';
    import type { EmptyResponse, Parse, Responses } from './runtime.ts';
    import type { JsonResponse } from './endpoint-runtime.ts';

    const config = {
      namespace: 'synthetic-consumer-modes',
      execute: async () => ({ status: 204, headers: {}, body: '' }),
    };
    const client = createClient(config);
    const queries = createQueries(config);
    const infinite = createInfiniteQueries(config);
    const cache = new QueryClient();
    const input = {
      headers: { 'Idempotency-Key': 'synthetic' },
      body: { label: 'Valid', values: ['one'] },
    };
    export const parsed: string = schema.parse('valid');
    export const prepared = operations.createWidget.build(input);
    operations.maybeCreate.build();
    operations.maybeCreate.build(undefined);
    operations.commandOptions.build();
    operations.commandOptions.build(undefined);
    client.maybeCreate.call({ context: {} });
    client.maybeCreate.call({ context: {}, input: undefined });
    client.maybeCreateNullable.call({ context: {} });
    queries.health.options({ context: {} });
    queries.health.options({ context: {}, input: undefined });
    queries.rangedBody.options({ context: {} });
    queries.rangedBody.options({ context: {}, input: undefined });
    queries.rangedBody.options({ context: {}, input: { query: { page: 1 } } });
    infinite.unscopedItems.options({ context: {} });
    infinite.unscopedItems.options({ context: {}, input: undefined });
    infinite.unscopedRecords.options({ context: {} });
    infinite.unscopedRecords.options({ context: {}, input: undefined });
    // @ts-expect-error Required path groups require an options argument in every mode.
    operations.readItem.build();
    // @ts-expect-error Required body/header groups require an options argument.
    operations.createWidget.build();
    // @ts-expect-error A required query group requires an options argument.
    operations.requiredQuery.build();
    // @ts-expect-error A required null-only body still requires its wrapper.
    operations.saveNulls.build();
    // @ts-expect-error An optional body does not make required path/header groups optional.
    operations.maybeUpdate.build();
    // @ts-expect-error Required call input cannot be omitted in non-strict consumers.
    client.readItem.call({ context: {} });
    // @ts-expect-error Required body/header input cannot be omitted.
    client.createWidget.call({ context: {} });
    // @ts-expect-error A required query group requires call input.
    client.requiredQuery.call({ context: {} });
    // @ts-expect-error Optional body requiredness is independent of other input groups.
    client.maybeUpdate.call({ context: {} });
    // @ts-expect-error Ordinary query options retain required input.
    queries.readItem.options({ context: {} });
    // @ts-expect-error A required query group requires query input.
    queries.requiredQuery.options({ context: {} });
    // @ts-expect-error Ordinary query keys retain required input.
    queries.readItem.key({ context: {} });
    // @ts-expect-error Body query options retain required input.
    queries.readItem.body().options({ context: {} });
    // @ts-expect-error Cursor pagination retains its required base path.
    infinite.listItems.options({ context: {} });
    // @ts-expect-error Cursor pagination keys retain their required base path.
    infinite.listItems.key({ context: {} });
    // @ts-expect-error Offset pagination retains its required base path.
    infinite.listRecords.options({ context: {} });
    // @ts-expect-error Body pagination retains its required base path.
    infinite.listRecords.body().options({ context: {} });
    export async function create() {
      const result = await client.createWidget.call({ context: {}, input });
      if (result.status === 201) {
        const label: string = result.data.label;
        return label;
      }
      const reference: string = result.data.reference;
      return reference;
    }
    export async function callBodyless() {
      const result = await client.commandOptions.call({ context: {} });
      const status: 204 = result.status;
      const data: undefined = result.data;
      return { status, data };
    }
    const health = operations.health.parseResponse({ status: 204, headers: {}, body: '' });
    if (health.kind === 'success') {
      const status: 204 = health.status;
      const data: undefined = health.data;
      void [status, data];
    }

    const args = { context: {}, input: { path: { id: 'item' } } };
    const body = queries.readItem.body();
    export const bodyOptions = body.options(args);
    export const skipped = body.options({ context: {}, input: skipToken });
    const cached = cache.getQueryData(bodyOptions.queryKey);
    if (cached) {
      const label: string = cached.label;
      void label;
      // @ts-expect-error Body storage contains the payload rather than an envelope.
      void cached.data;
    }
    export const envelopeOptions = queries.readItem.options(args);
    const envelope = cache.getQueryData(envelopeOptions.queryKey);
    if (envelope) {
      const status: 200 = envelope.status;
      const label: string = envelope.data.label;
      void [status, label];
    }
    export const invalidation = cache.invalidateQueries(body.filter({ context: {} }));
    export const cursorOptions = infinite.listItems.body().options({
      context: {}, input: { path: { collection: 'items' } },
    });
    export const offsetOptions = infinite.listRecords.body().options({
      context: {}, input: { path: { category: 'records' } },
    });
    const cursorData = cache.getQueryData(cursorOptions.queryKey);
    const offsetData = cache.getQueryData(offsetOptions.queryKey);
    export const cursorItems = infinite.listItems.body().items(cursorData);
    export const offsetItems = infinite.listRecords.body().items(offsetData);
    export const defaultOptions = queries.defaultBody.body().options({ context: {} });
    export const rangedOptions = queries.rangedBody.body().options({ context: {} });
    export const nullOptions = queries.nullBody.body().options({ context: {} });
    export const textOptions = queries.textBody.body().options({ context: {} });

    declare const unknownQuery: QueryFactory<undefined, Responses>;
    // @ts-expect-error An unspecified response table may have a bodyless success.
    unknownQuery.body();
    declare const eitherQuery: QueryFactory<undefined,
      { 200: JsonResponse<Parse<string>> } | { 204: EmptyResponse }>;
    // @ts-expect-error Either response table can be selected, including a bodyless one.
    eitherQuery.body();

    // @ts-expect-error A bodyless success cannot use body storage.
    queries.health.body();
    // @ts-expect-error One bodyless exact success makes body storage unavailable.
    queries.mixedBody.body();
    // @ts-expect-error An unshadowed default can produce a bodyless success.
    queries.defaultEmpty.body();
    // @ts-expect-error A bodyless success range remains possible beside exact 200.
    queries.rangedEmpty.body();
    // @ts-expect-error Path values retain their generated types in every mode.
    operations.readItem.build({ path: { id: 7 } });
    // @ts-expect-error Transport-owned headers cannot be supplied by the caller.
    body.options({ context: {}, input: { path: { id: 'item' }, headers: { 'X-Language': 'en' } } });
    `,
  );
  for (const [name, options] of [
    [
      'strict',
      {
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
      },
    ],
    ['nonstrict', { strict: false }],
    ['nonstrict-implicit', { strict: false, noImplicitAny: true }],
  ] as const) {
    const config = join(root, `${name}.json`);
    await writeFile(
      config,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: [],
          noEmit: true,
          allowImportingTsExtensions: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          skipLibCheck: false,
          ...options,
        },
        include: ['./*.ts'],
      }),
    );
    await promisify(execFile)(process.execPath, [compiler, '-p', config], {
      cwd: root,
    });
  }
}
