import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { QueryClient } from '@tanstack/query-core';
import type {
  FetchInfiniteQueryOptions,
  InfiniteData,
} from '@tanstack/query-core';
import { compile, ContractError } from '../dist/index.js';
import type { Executor } from '../src/execution-runtime.ts';
import { present, record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { Schema } from './schema-helpers.ts';

const vendor = 'application/vnd.page+json';
const bindings = {
  cursor: { cursor: 'after', nextCursor: 'next', items: 'items' },
  offset: {
    offset: 'start',
    responseOffset: 'start',
    responseLimit: 'limit',
    total: 'total',
    items: 'items',
  },
} as const;
type Profile = keyof typeof bindings;
const ordinary = {
  clients: ['consumer'],
  surfaces: { consumer: ['listItems'] },
  queries: { consumer: ['listItems'] },
};
const selection = (profile: Profile) => ({
  ...ordinary,
  infiniteQueries: { consumer: { listItems: bindings[profile] } },
});

function fixture(modern = true, reversed = false) {
  const page = (itemType: string) => {
    const properties: Record<string, Schema> = {
      items: { type: 'array', items: { type: itemType } },
      next: modern
        ? { type: ['string', 'null'] }
        : { type: 'string', nullable: true },
      start: { type: 'integer' },
      limit: { type: 'integer' },
      total: { type: 'integer' },
    };
    return { type: 'object', required: Object.keys(properties), properties };
  };
  const content: Record<string, { schema: Schema }> = {
    'application/json': { schema: { $ref: '#/components/schemas/First' } },
    [vendor]: { schema: { $ref: '#/components/schemas/Alias' } },
  };
  return {
    openapi: modern ? '3.1.2' : '3.0.4',
    info: { title: 'Synthetic response media pagination', version: '1' },
    components: {
      schemas: {
        First: page('string'),
        Second: page('integer'),
        Alias: { $ref: '#/components/schemas/Second' },
      },
    },
    paths: {
      '/items': {
        get: {
          operationId: 'listItems',
          parameters: [
            { name: 'after', in: 'query', schema: { type: 'string' } },
            {
              name: 'start',
              in: 'query',
              schema: { type: 'integer', minimum: 0 },
            },
          ],
          responses: {
            200: {
              description: 'Pages',
              content: reversed
                ? Object.fromEntries(Object.entries(content).reverse())
                : content,
            },
            400: {
              description: 'Text error is not a pagination page',
              content: { 'text/plain': { schema: { type: 'string' } } },
            },
          },
        },
      },
    },
  };
}

void test('cursor and offset pagination accept every valid JSON representation through aliases independent of declaration order', async () => {
  for (const profile of ['cursor', 'offset'] as const) {
    const expected = await compile(fixture(), selection(profile));
    for (const modern of [false, true])
      for (const reversed of [false, true])
        assert.deepEqual(
          await compile(fixture(modern, reversed), selection(profile)),
          expected,
        );
  }
});

void test('ordinary queries retain mixed response media while pagination rejects every incompatible success representation', async () => {
  type Fixture = ReturnType<typeof fixture>;
  type Case = {
    media: string;
    change: (input: Fixture) => void;
    suffix?: string;
    message: RegExp;
  };
  const cases: Case[] = [
    {
      media: 'text/plain',
      change: (input) => {
        input.paths['/items'].get.responses[200].content['text/plain'] = {
          schema: { type: 'string' },
        };
      },
      message: /JSON object body/,
    },
    {
      media: vendor,
      change: (input) => {
        input.paths['/items'].get.responses[200].content[vendor] = {
          schema: { type: 'string' },
        };
      },
      message: /fixed object body/,
    },
    {
      media: vendor,
      change: (input) => {
        input.components.schemas.Second.required =
          input.components.schemas.Second.required.filter(
            (name) => name !== 'items',
          );
      },
      message: /pagination field "items" must be required/,
    },
    {
      media: vendor,
      change: (input) => {
        input.components.schemas.Second.properties.items = { type: 'string' };
      },
      suffix: '.items',
      message: /items must name an array/,
    },
  ];
  for (const profile of ['cursor', 'offset'] as const) {
    const metadata: Case[] =
      profile === 'cursor'
        ? [
            {
              media: vendor,
              change: (input) => {
                input.components.schemas.Second.properties.next = {
                  type: 'string',
                };
              },
              suffix: '.next',
              message: /nextCursor must name a nullable string/,
            },
          ]
        : ['start', 'limit', 'total'].map((name) => ({
            media: vendor,
            change: (input: Fixture) => {
              input.components.schemas.Second.properties[name] = {
                type: 'number',
              };
            },
            suffix: `.${name}`,
            message: /required nonnullable integer/,
          }));
    for (const reversed of [false, true])
      for (const value of [...cases, ...metadata]) {
        const input = fixture(true, reversed);
        value.change(input);
        const before = structuredClone(input);
        await compile(input, ordinary);
        await assert.rejects(compile(input, selection(profile)), (error) => {
          assert.ok(error instanceof ContractError);
          assert.equal(
            error.location,
            `infiniteQueries.consumer.listItems.responses.200.content.${value.media}${value.suffix ?? ''}`,
          );
          assert.match(error.message, value.message);
          return true;
        });
        assert.deepEqual(input, before);
      }
  }
});

interface RuntimeFactory {
  options(args: {
    context: Record<string, never>;
  }): FetchInfiniteQueryOptions<unknown, Error>;
  body(): RuntimeFactory;
  items(data: InfiniteData<unknown> | undefined): unknown[];
}
interface RuntimeQueries {
  createInfiniteQueries(config: {
    namespace: string;
    execute: Executor;
  }): Record<string, RuntimeFactory>;
}

void test('both JSON media reach cursor and offset page helpers in raw/scoped execution and envelope/body caches', async (t) => {
  for (const profile of ['cursor', 'offset'] as const) {
    const root = await generatedTestWorkspace(
      t,
      await compile(fixture(), selection(profile)),
    );
    const module = await importGenerated<RuntimeQueries>(
      root,
      'client.consumer.queries.ts',
    );
    for (const contentType of ['application/json', vendor])
      for (const scoped of [false, true])
        for (const body of [false, true]) {
          const page = {
            items: contentType === vendor ? [2] : ['first'],
            next: null,
            start: 0,
            limit: 1,
            total: 1,
          };
          const execute: Executor = async (_request, execution) => {
            const observed = {
              status: 200,
              headers: { 'Content-Type': contentType },
              body: JSON.stringify(page),
            };
            return scoped ? execution.validateResponse(observed) : observed;
          };
          const base = present(
            module.createInfiniteQueries({
              namespace: `${profile}/${contentType}/${scoped}/${body}`,
              execute,
            }).listItems,
          );
          const factory = body ? base.body() : base;
          const client = new QueryClient();
          try {
            const data = await client.fetchInfiniteQuery(
              factory.options({ context: {} }),
            );
            const result = present(data.pages[0]);
            assert.deepEqual(body ? result : record(result).data, page);
            if (!body) assert.equal(record(result).contentType, contentType);
            assert.deepEqual(factory.items(data), page.items);
          } finally {
            client.clear();
          }
        }
    await writeFile(
      join(root, 'consumer.ts'),
      `
      import {createInfiniteQueries} from './client.consumer.queries.ts';
      import type {QueryExecutor} from './client.consumer.queries.ts';
      export function inspect(execute:QueryExecutor) {
        const family=createInfiniteQueries({namespace:'types',execute}).listItems;
        const items:Array<string|number>=family.items(undefined);
        // @ts-expect-error Both response representations contribute item types.
        const strings:string[]=family.items(undefined);
        family.body().options({context:{}});
        void strings;
        return items;
      }
    `,
    );
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noEmit: true,
          allowImportingTsExtensions: true,
        },
        include: ['*.ts'],
      }),
    );
    await promisify(execFile)(process.execPath, [
      fileURLToPath(
        new URL('../node_modules/typescript/bin/tsc', import.meta.url),
      ),
      '-p',
      join(root, 'tsconfig.json'),
    ]);
  }
});
