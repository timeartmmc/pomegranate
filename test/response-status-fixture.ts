import assert from 'node:assert/strict';
import { present } from './assertions.ts';
import type {
  ObservedResponse,
  PreparedRequest,
  ProtocolResult,
  Responses,
} from '../src/runtime.ts';
import type { Schema } from './schema-helpers.ts';

export interface ResponseStatusClient {
  operations: Record<
    string,
    {
      build(input?: unknown): PreparedRequest<Responses>;
      parseResponse(response: ObservedResponse): ProtocolResult<Responses>;
    }
  >;
}

// Each declaration accepts only its own literal, so a result identifies the
// declaration that validated it.
const source = (name: string): Schema => ({
  type: 'object',
  required: ['source'],
  properties: { source: { type: 'string', enum: [name] } },
});
const json = (schema: Schema) => ({ 'application/json': { schema } });
const ref = (name: string): Schema => ({
  $ref: `#/components/schemas/${name}`,
});

export function responseStatusFixture(modern = true) {
  const page = {
    description: 'A page',
    content: json(ref('Page')),
  };
  return {
    openapi: modern ? '3.1.2' : '3.0.4',
    info: { title: 'Synthetic status ranges and defaults', version: '1' },
    components: {
      schemas: {
        Problem: source('default'),
        Page: {
          type: 'object',
          required: ['items', 'next'],
          properties: {
            items: { type: 'array', items: { type: 'string' } },
            next: modern
              ? { type: ['string', 'null'] }
              : { type: 'string', nullable: true },
          },
        },
      } satisfies Record<string, Schema>,
      responses: {
        Fallback: {
          description: 'Every status without a more specific declaration',
          content: json(ref('Problem')),
        },
      },
    },
    paths: {
      '/mixed': {
        get: {
          operationId: 'mixed',
          responses: {
            200: { description: 'Exact', content: json(source('exact')) },
            '2XX': {
              description: 'Other successes',
              content: json(source('success')),
            },
            404: { description: 'Exact error without content' },
            '4XX': {
              description: 'Other client errors',
              headers: {
                'X-Reason': {
                  required: true,
                  schema: { type: 'string', enum: ['quota'] },
                },
              },
              content: json(source('client')),
            },
            default: {
              description: 'Redirects and server errors',
              content: {
                'text/plain': { schema: { type: 'string', enum: ['other'] } },
              },
            },
          },
        },
        head: {
          operationId: 'probe',
          responses: {
            '2XX': { description: 'Reachable' },
            default: { description: 'Unreachable' },
          },
        },
      },
      '/fallback': {
        get: {
          operationId: 'fallback',
          responses: {
            200: { description: 'Exact', content: json(source('exact')) },
            default: { $ref: '#/components/responses/Fallback' },
          },
        },
      },
      '/only': {
        get: {
          operationId: 'only',
          responses: { default: { description: 'Any final status' } },
        },
      },
      '/ranges': {
        post: {
          operationId: 'ranges',
          responses: {
            '2XX': { description: 'Accepted without content' },
            '5XX': {
              description: 'Server errors',
              content: json(source('server')),
            },
          },
        },
      },
      '/pages': {
        get: {
          operationId: 'pages',
          parameters: [
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: page,
            '2XX': page,
            default: { $ref: '#/components/responses/Fallback' },
          },
        },
      },
    },
  };
}

export const responseStatusSelection = {
  clients: ['consumer'],
  executionClients: ['consumer'],
  surfaces: {
    consumer: ['mixed', 'probe', 'fallback', 'only', 'ranges', 'pages'],
  },
  queries: { consumer: ['mixed', 'probe', 'fallback', 'only', 'pages'] },
  infiniteQueries: {
    consumer: {
      pages: { cursor: 'cursor', nextCursor: 'next', items: 'items' },
    },
  },
} as const;

const body = (name: string) => JSON.stringify({ source: name });
const jsonHeaders = { 'Content-Type': 'application/json' };
type Outcome = 'success' | 'error' | 'protocol';
// Operation, status, headers, body, outcome and validated data.
type Case = readonly [
  string,
  number,
  Record<string, string>,
  string,
  Outcome,
  unknown?,
];

export const responseStatusCases: readonly Case[] = [
  // An exact status wins over its range, and the range over default.
  ['mixed', 200, jsonHeaders, body('exact'), 'success', { source: 'exact' }],
  [
    'mixed',
    201,
    jsonHeaders,
    body('success'),
    'success',
    { source: 'success' },
  ],
  [
    'mixed',
    299,
    jsonHeaders,
    body('success'),
    'success',
    { source: 'success' },
  ],
  ['mixed', 404, {}, '', 'error', undefined],
  [
    'mixed',
    400,
    { ...jsonHeaders, 'X-Reason': 'quota' },
    body('client'),
    'error',
    { source: 'client' },
  ],
  [
    'mixed',
    499,
    { ...jsonHeaders, 'X-Reason': 'quota' },
    body('client'),
    'error',
    { source: 'client' },
  ],
  ['mixed', 300, { 'Content-Type': 'text/plain' }, 'other', 'error', 'other'],
  ['mixed', 399, { 'Content-Type': 'text/plain' }, 'other', 'error', 'other'],
  ['mixed', 500, { 'Content-Type': 'text/plain' }, 'other', 'error', 'other'],
  ['mixed', 599, { 'Content-Type': 'text/plain' }, 'other', 'error', 'other'],
  // Only the matched declaration validates: a neighbor's body does not pass.
  ['mixed', 200, jsonHeaders, body('success'), 'protocol'],
  ['mixed', 201, jsonHeaders, body('exact'), 'protocol'],
  ['mixed', 404, jsonHeaders, body('client'), 'protocol'],
  ['mixed', 400, jsonHeaders, body('client'), 'protocol'],
  ['mixed', 400, { 'Content-Type': 'text/plain' }, 'other', 'protocol'],
  ['mixed', 500, jsonHeaders, body('client'), 'protocol'],
  // Without a 2XX range, default also answers the other 2xx statuses.
  ['fallback', 200, jsonHeaders, body('exact'), 'success', { source: 'exact' }],
  [
    'fallback',
    201,
    jsonHeaders,
    body('default'),
    'success',
    { source: 'default' },
  ],
  [
    'fallback',
    302,
    jsonHeaders,
    body('default'),
    'error',
    { source: 'default' },
  ],
  [
    'fallback',
    404,
    jsonHeaders,
    body('default'),
    'error',
    { source: 'default' },
  ],
  [
    'fallback',
    503,
    jsonHeaders,
    body('default'),
    'error',
    { source: 'default' },
  ],
  ['fallback', 200, jsonHeaders, body('default'), 'protocol'],
  ['fallback', 201, jsonHeaders, body('exact'), 'protocol'],
  // A lone default is the success and every error.
  ['only', 200, {}, '', 'success', undefined],
  ['only', 204, {}, '', 'success', undefined],
  ['only', 304, {}, '', 'error', undefined],
  ['only', 404, {}, '', 'error', undefined],
  ['only', 599, {}, '', 'error', undefined],
  ['only', 200, {}, 'unexpected', 'protocol'],
  // Ranges alone leave the other classes undeclared.
  ['ranges', 200, {}, '', 'success', undefined],
  ['ranges', 205, {}, '', 'success', undefined],
  ['ranges', 500, jsonHeaders, body('server'), 'error', { source: 'server' }],
  ['ranges', 302, {}, '', 'protocol'],
  ['ranges', 404, {}, '', 'protocol'],
  ['probe', 200, {}, '', 'success', undefined],
  ['probe', 404, {}, '', 'error', undefined],
];

export function verifyResponseStatuses(client: ResponseStatusClient): void {
  for (const [name, status, headers, text, kind, data] of responseStatusCases) {
    const result = present(client.operations[name]).parseResponse({
      status,
      headers,
      body: text,
    });
    const label = `${name} ${status} ${text}`;
    assert.equal(result.kind, kind, label);
    assert.equal(result.status, status, label);
    if (result.kind !== 'protocol') assert.deepEqual(result.data, data, label);
  }
  // Fallbacks describe final statuses only. Anything else stays undeclared,
  // including where a default would otherwise accept the empty body.
  for (const status of [0, 100, 101, 199, 600, 999, 200.5, -200, NaN, Infinity])
    for (const name of ['only', 'ranges', 'mixed']) {
      const result = present(client.operations[name]).parseResponse({
        status,
        headers: {},
        body: '',
      });
      assert.equal(result.kind, 'protocol', `${name} ${status}`);
      if (result.kind === 'protocol')
        assert.deepEqual(result.issues, [
          { part: 'status', message: 'undeclared response status' },
        ]);
    }
  // 204, 205 and 304 have no content. A range or default that declares content
  // cannot validate one, whatever the transport reports beside it.
  for (const [name, status] of [
    ['mixed', 204],
    ['mixed', 205],
    ['mixed', 304],
    ['fallback', 204],
    ['fallback', 304],
  ] as const)
    for (const [headers, text] of [
      [{}, ''],
      [jsonHeaders, body(name === 'mixed' ? 'success' : 'default')],
      [{ 'Content-Type': 'text/plain' }, 'other'],
    ] as const) {
      const result = present(client.operations[name]).parseResponse({
        status,
        headers,
        body: text,
      });
      assert.equal(result.kind, 'protocol', `${name} ${status}`);
      if (result.kind === 'protocol')
        assert.deepEqual(result.issues, [
          {
            part: 'status',
            message: `a ${status} response cannot carry the declared content`,
          },
        ]);
    }
  const missingHeader = present(client.operations.mixed).parseResponse({
    status: 429,
    headers: jsonHeaders,
    body: body('client'),
  });
  assert.equal(missingHeader.kind, 'protocol');
  if (missingHeader.kind === 'protocol')
    assert.deepEqual(
      missingHeader.issues.map((issue) => [issue.part, issue.path]),
      [['headers', ['x-reason']]],
    );
}

export const responseStatusConsumer = `
import { operations, createClient } from './client.consumer.ts';
import type { Executor } from './client.consumer.ts';
import { createQueries, createInfiniteQueries } from './client.consumer.queries.ts';

const observed = { status: 200, headers: {}, body: '' };
const mixed = operations.mixed.parseResponse(observed);
if (mixed.kind !== 'protocol') {
  if (mixed.status === 200) {
    const data: { source: 'exact' } = mixed.data;
    const kind: 'success' = mixed.kind;
    void [data, kind];
  } else if (mixed.status === 201 || mixed.status === 299) {
    const data: { source: 'success' } = mixed.data;
    const kind: 'success' = mixed.kind;
    void [data, kind];
  } else if (mixed.status === 404) {
    const data: undefined = mixed.data;
    void data;
  } else if (mixed.status === 400 || mixed.status === 499) {
    const data: { source: 'client' } = mixed.data;
    const kind: 'error' = mixed.kind;
    void [data, kind];
  } else if (mixed.status === 302 || mixed.status === 500) {
    const data: 'other' = mixed.data;
    const media: 'text/plain' = mixed.contentType;
    const kind: 'error' = mixed.kind;
    void [data, media, kind];
  }
  // @ts-expect-error Interim statuses are never declared results.
  if (mixed.status === 101) void mixed;
  // @ts-expect-error Statuses above 599 are never declared results.
  if (mixed.status === 600) void mixed;
}
if (mixed.kind === 'success') {
  // Default yields 2xx statuses to the declared 2XX range.
  const data: { source: 'exact' } | { source: 'success' } = mixed.data;
  // @ts-expect-error A success of this operation is never the default body.
  const other: 'other' = mixed.data;
  void [data, other];
}

const fallback = operations.fallback.parseResponse(observed);
if (fallback.kind === 'success') {
  if (fallback.status === 200) {
    const data: { source: 'exact' } = fallback.data;
    // @ts-expect-error The exact status excludes the default body.
    const other: { source: 'default' } = fallback.data;
    void [data, other];
  } else {
    // Without a 2XX range, default answers the remaining 2xx statuses.
    const data: { source: 'default' } = fallback.data;
    // @ts-expect-error Default never receives the exactly declared status.
    const exact: 200 = fallback.status;
    void [data, exact];
  }
} else if (fallback.kind === 'error') {
  const data: { source: 'default' } = fallback.data;
  // @ts-expect-error Errors never carry a 2xx status.
  const success: 201 = fallback.status;
  void [data, success];
}

const only = operations.only.parseResponse(observed);
if (only.kind !== 'protocol') {
  const data: undefined = only.data;
  const kind: 'success' | 'error' = only.kind;
  void [data, kind];
  if (only.status === 204) { const kind: 'success' = only.kind; void kind; }
  if (only.status === 503) { const kind: 'error' = only.kind; void kind; }
}

const ranges = operations.ranges.parseResponse(observed);
if (ranges.kind === 'error') {
  const data: { source: 'server' } = ranges.data;
  // @ts-expect-error No declaration covers a client error.
  const client: 404 = ranges.status;
  void [data, client];
}

const execute: Executor = async () => observed;
export async function call() {
  const client = createClient({ namespace: 'statuses', execute });
  const result = await client.fallback.call({ context: {} });
  if (result.status === 200) {
    const data: { source: 'exact' } = result.data; void data;
  } else {
    const data: { source: 'default' } = result.data; void data;
  }
  try {
    await client.mixed.call({ context: {} });
  } catch (error) {
    if (client.mixed.isError(error) && error.result.kind === 'error') {
      if (error.result.status === 404) {
        const data: undefined = error.result.data; void data;
      } else if (error.result.status === 418) {
        const data: { source: 'client' } = error.result.data; void data;
      } else if (error.result.status === 503) {
        const data: 'other' = error.result.data; void data;
      }
    }
  }
  const empty = await client.only.call({ context: {} });
  const none: undefined = empty.data;
  return none;
}

const queries = createQueries({ namespace: 'statuses', execute });
// Every success of these operations has content, including a default success.
queries.mixed.body().options({ context: {} });
queries.fallback.body().options({ context: {} });
// @ts-expect-error A default without content can be the success.
queries.only.body();
// @ts-expect-error A 2XX range without content can be the success.
queries.probe.body();
const pages = createInfiniteQueries({ namespace: 'statuses', execute }).pages;
export const items: string[] = pages.items(undefined);
`;
