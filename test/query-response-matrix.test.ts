import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { QueryClient } from '@tanstack/query-core';
import { compile } from '../dist/index.js';
import { generatedWorkspace } from './generated-workspace.ts';
import type {
  QueryExecutor,
  QueryFactory,
  QueryResponseError,
} from '../src/query-runtime.ts';
import type { ObservedResponse, Responses } from '../src/runtime.ts';
import { queryFixture } from './query-fixture.ts';
import type { Schema } from './schema-helpers.ts';

type ResponseCase = Readonly<{
  name: string;
  status: number;
  schema?: Schema;
  body: string;
  expected: unknown;
  invalid: string;
  otherStatus: number;
}>;

// Wire samples and expectations are authored independently of generated code.
// Include falsy payloads: TanStack must cache the envelope, not the raw payload.
const cases: readonly ResponseCase[] = [
  {
    name: 'null',
    status: 200,
    schema: { type: 'null' },
    body: 'null',
    expected: null,
    invalid: '0',
    otherStatus: 201,
  },
  {
    name: 'false',
    status: 201,
    schema: { type: 'boolean' },
    body: 'false',
    expected: false,
    invalid: '"false"',
    otherStatus: 202,
  },
  {
    name: 'zero',
    status: 202,
    schema: { type: 'integer', minimum: 0 },
    body: '0',
    expected: 0,
    invalid: '0.5',
    otherStatus: 203,
  },
  {
    name: 'empty text',
    status: 203,
    schema: { type: 'string', maxLength: 0 },
    body: '""',
    expected: '',
    invalid: '"present"',
    otherStatus: 206,
  },
  {
    name: 'bodyless',
    status: 204,
    body: '',
    expected: undefined,
    invalid: 'null',
    otherStatus: 200,
  },
  {
    name: 'empty array',
    status: 206,
    schema: { type: 'array', items: { type: 'integer', minimum: 0 } },
    body: '[]',
    expected: [],
    invalid: '[false]',
    otherStatus: 207,
  },
  {
    name: 'empty object',
    status: 207,
    schema: { type: 'object' },
    body: '{}',
    expected: {},
    invalid: '[]',
    otherStatus: 200,
  },
  {
    name: 'nested reference',
    status: 208,
    schema: {
      type: 'object',
      required: ['items', 'optional'],
      properties: {
        items: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
        optional: { type: ['integer', 'null'], minimum: 0 },
      },
    },
    body: '{"items":[{"id":"one","label":"Synthetic","extra":true}],"optional":null,"extra":true}',
    expected: { items: [{ id: 'one', label: 'Synthetic' }], optional: null },
    invalid: '{"items":[{"id":"one","label":false}],"optional":null}',
    otherStatus: 201,
  },
  {
    name: 'constrained reference',
    status: 209,
    schema: { $ref: '#/components/schemas/Score', minimum: 0, multipleOf: 0.1 },
    body: '0.3',
    expected: 0.3,
    invalid: '0.31',
    otherStatus: 200,
  },
  {
    name: 'typed map',
    status: 210,
    schema: {
      type: 'object',
      additionalProperties: { type: 'integer', minimum: 0 },
    },
    body: '{"__proto__":0,"constructor":1}',
    expected: { ['__proto__']: 0, constructor: 1 },
    invalid: '{"__proto__":false}',
    otherStatus: 202,
  },
];

type Module = Readonly<{
  createQueries: (
    config: Readonly<{ namespace: string; execute: QueryExecutor }>,
  ) => Readonly<{ readOutcome: QueryFactory<undefined, Responses> }>;
  QueryResponseError: typeof QueryResponseError;
}>;

let root: string;
let module: Module;

before(async () => {
  const document = queryFixture();
  Object.assign(document.components.schemas, {
    Score: { type: 'number', minimum: -1, maximum: 1 },
  });
  const responses = Object.fromEntries(
    cases.map((sample) => [
      sample.status,
      {
        description: sample.name,
        ...(sample.schema === undefined
          ? {}
          : {
              content: { 'application/json': { schema: sample.schema } },
            }),
      },
    ]),
  );
  responses['409'] = {
    description: 'Declared HTTP error with falsy data',
    content: { 'application/json': { schema: { type: 'boolean' } } },
  };
  Object.assign(document.paths['/outcome'].get, { responses });
  const files = await compile(document, {
    clients: ['consumer'],
    transportHeaders: ['X-Language'],
    queries: { consumer: ['readOutcome'] },
  });
  root = await generatedWorkspace(files);
  module = (await import(
    pathToFileURL(join(root, 'client.consumer.queries.ts')).href
  )) as Module;
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function evidence(sample: ResponseCase): ObservedResponse {
  return {
    status: sample.status,
    headers:
      sample.schema === undefined ? {} : { 'Content-Type': 'application/json' },
    body: sample.body,
  };
}

void test('query success envelopes cache falsy, empty and structured bodies at their exact statuses', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  });
  try {
    for (const sample of cases) {
      let calls = 0;
      const queries = module.createQueries({
        namespace: `response-${sample.name}`,
        execute: async () => {
          calls += 1;
          return evidence(sample);
        },
      });
      const options = queries.readOutcome.options({ context: {} });
      const result = await client.fetchQuery({
        ...options,
        staleTime: Infinity,
      });
      assert.equal(result.kind, 'success', sample.name);
      assert.equal(result.status, sample.status, sample.name);
      assert.ok(Object.hasOwn(result, 'data'), sample.name);
      assert.deepEqual(result.data, sample.expected, sample.name);
      assert.equal(client.getQueryData(options.queryKey), result, sample.name);
      assert.equal(
        await client.fetchQuery({ ...options, staleTime: Infinity }),
        result,
        sample.name,
      );
      assert.equal(calls, 1, sample.name);
    }
  } finally {
    client.clear();
  }
});

void test('invalid values, mismatched statuses and HTTP errors preserve previous query envelopes even with falsy data', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity } },
  });
  try {
    for (const sample of cases) {
      let observed = evidence(sample);
      const queries = module.createQueries({
        namespace: `response-failures-${sample.name}`,
        execute: async () => observed,
      });
      const options = queries.readOutcome.options({ context: {} });
      const previous = await client.fetchQuery(options);
      for (const [next, kind] of [
        [{ ...evidence(sample), body: sample.invalid }, 'protocol'],
        [{ ...evidence(sample), status: sample.otherStatus }, 'protocol'],
        [
          {
            status: 409,
            headers: { 'Content-Type': 'application/json' },
            body: 'false',
          },
          'error',
        ],
        [{ ...evidence(sample), status: 299 }, 'protocol'],
      ] as const) {
        observed = next;
        await assert.rejects(client.fetchQuery(options), (error: unknown) => {
          assert.ok(error instanceof module.QueryResponseError, sample.name);
          assert.equal(error.result.kind, kind, sample.name);
          assert.equal(error.result.status, next.status, sample.name);
          if (error.result.kind === 'error')
            assert.equal(error.result.data, false, sample.name);
          else
            assert.equal(
              Object.hasOwn(error.result, 'data'),
              false,
              sample.name,
            );
          return true;
        });
        assert.equal(
          client.getQueryData(options.queryKey),
          previous,
          sample.name,
        );
        assert.deepEqual(previous.data, sample.expected, sample.name);
      }
    }
  } finally {
    client.clear();
  }
});
