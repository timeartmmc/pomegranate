import assert from 'node:assert/strict';
import { json, present, record } from './assertions.ts';
import type { RuntimeClient } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

export interface ResponseDefinition {
  [keyword: string]: unknown;
  description: string;
  content?: Record<string, { schema: Schema }>;
  headers?: Record<string, { required?: boolean; schema: Schema }>;
}
export interface ResponseReference {
  [keyword: string]: unknown;
  $ref: string;
  summary?: string;
  description?: string;
}
export type ResponseEntry = ResponseDefinition | ResponseReference;
export const responseReference = (name: string): ResponseReference => ({
  $ref: `#/components/responses/${name}`,
});
const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const traceHeaders = () => ({
  'X-Trace': { required: true, schema: { type: 'string', minLength: 1 } },
});
const pageResponse = (): ResponseDefinition => ({
  description: 'Synthetic result',
  headers: {
    ...traceHeaders(),
    'X-Mode': { schema: { type: 'string', const: 'full' } },
  },
  content: { 'application/json': { schema: schemaRef('Payload') } },
});
const emptyResponse = (): ResponseDefinition => ({
  description: 'Synthetic bodyless response',
  headers: traceHeaders(),
});
const problemResponse = (): ResponseDefinition => ({
  description: 'Synthetic problem',
  headers: traceHeaders(),
  content: { 'application/json': { schema: schemaRef('Problem') } },
});

export const responseReferenceSelection = {
  clients: ['consumer', 'staff'],
  surfaces: {
    consumer: ['readResults', 'headResults', 'resetResults', 'cacheResults'],
    staff: ['staffRead'],
    internal: ['internalRead'],
  },
};

export function responseReferenceFixture() {
  const responses: Record<string, ResponseEntry> = {
    Page: pageResponse(),
    '9.page_v1': { ...responseReference('Page'), summary: 'Page alias' },
    PageAlias: { ...responseReference('9.page_v1'), description: 'Alias docs' },
    OtherPageAlias: responseReference('Page'),
    Empty: emptyResponse(),
    EmptyAlias: responseReference('Empty'),
    Problem: problemResponse(),
    Internal: {
      description: 'Unselected response',
      content: { 'application/json': { schema: schemaRef('Secret') } },
    },
    Unused: {
      description: 'Unused response',
      content: { 'application/json': { schema: schemaRef('UnusedValue') } },
    },
  };
  const schemas: Record<string, Schema> = {
    Payload: {
      type: 'object',
      required: [
        'id',
        'code',
        'label',
        'note',
        'entries',
        'attributes',
        'secret',
      ],
      properties: {
        id: { type: 'string', minLength: 1, readOnly: true },
        code: { type: 'integer', minimum: 1 },
        label: { type: 'string', minLength: 1 },
        note: { type: ['string', 'null'] },
        entries: { type: 'array', items: { type: 'string', minLength: 1 } },
        attributes: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
        secret: { type: 'string', writeOnly: true, default: 'annotation' },
      },
    },
    Problem: {
      type: 'object',
      required: ['message'],
      properties: { message: { type: 'string', minLength: 1 } },
    },
    Secret: { type: 'boolean' },
    UnusedValue: { type: 'number' },
  };
  return {
    openapi: '3.1.1',
    info: { title: 'Synthetic reusable responses', version: '1' },
    components: { schemas, responses },
    paths: {
      '/results': {
        get: {
          operationId: 'readResults',
          responses: {
            200: responseReference('PageAlias'),
            201: responseReference('OtherPageAlias'),
            404: responseReference('Problem'),
            410: responseReference('EmptyAlias'),
          } as Record<string, ResponseEntry>,
        },
      },
      '/health': {
        head: {
          operationId: 'headResults',
          responses: { 204: responseReference('EmptyAlias') } as Record<
            string,
            ResponseEntry
          >,
        },
      },
      '/reset': {
        post: {
          operationId: 'resetResults',
          responses: { 205: responseReference('Empty') } as Record<
            string,
            ResponseEntry
          >,
        },
      },
      '/cache': {
        get: {
          operationId: 'cacheResults',
          responses: {
            200: responseReference('Page'),
            304: responseReference('Empty'),
          } as Record<string, ResponseEntry>,
        },
      },
      '/staff': {
        get: {
          operationId: 'staffRead',
          responses: { 200: responseReference('PageAlias') } as Record<
            string,
            ResponseEntry
          >,
        },
      },
      '/internal': {
        get: {
          operationId: 'internalRead',
          responses: { 200: responseReference('Internal') } as Record<
            string,
            ResponseEntry
          >,
        },
      },
    },
  };
}

// Independent inline declarations are the output oracle: component names and
// aliases must not create a second generated format or widen exact statuses.
export function inlineResponseFixture() {
  const document = responseReferenceFixture();
  document.paths['/results'].get.responses = {
    200: pageResponse(),
    201: pageResponse(),
    404: problemResponse(),
    410: emptyResponse(),
  };
  document.paths['/health'].head.responses = { 204: emptyResponse() };
  document.paths['/reset'].post.responses = { 205: emptyResponse() };
  document.paths['/cache'].get.responses = {
    200: pageResponse(),
    304: emptyResponse(),
  };
  document.paths['/staff'].get.responses = { 200: pageResponse() };
  document.paths['/internal'].get.responses = {
    200: {
      description: 'Unselected response',
      content: { 'application/json': { schema: schemaRef('Secret') } },
    },
  };
  Reflect.deleteProperty(document.components, 'responses');
  return document;
}

export const responseReferenceConsumer = `
import { operations } from './client.consumer.ts';
export const parse: typeof operations.readResults.parseResponse = operations.readResults.parseResponse;
const result = parse({status:200,headers:{},body:''});
if (result.kind === 'success') {
  const status: 200 | 201 = result.status;
  const id: string = result.data.id;
  const note: string | null = result.data.note;
  const item: string | undefined = result.data.entries[0];
  const trace: string | undefined = result.headers['x-trace'];
  // @ts-expect-error Write-only properties are absent from response data.
  void result.data.secret;
  // @ts-expect-error Referenced schema properties keep their exact types.
  const wrong: number = result.data.label;
  void [status,id,note,item,trace,wrong];
} else if (result.kind === 'error' && result.status === 404) {
  const message: string = result.data.message;
  // @ts-expect-error The declared error is not a success payload.
  void result.data.id;
  void message;
} else if (result.kind === 'error') {
  const status: 410 = result.status;
  const empty: undefined = result.data;
  void [status,empty];
}
const head = operations.headResults.parseResponse({status:204,headers:{},body:''});
if(head.kind === 'success') {
  const status: 204 = head.status;
  const empty: undefined = head.data;
  void [status,empty];
}
`;

export function verifyResponseReferences(
  client: RuntimeClient,
  staff?: RuntimeClient,
): void {
  const read = present(client.operations.readResults);
  const payload = {
    id: 'synthetic',
    code: 1,
    label: 'first',
    note: null,
    entries: ['item'],
    attributes: { retained: 'map value' },
  };
  const headers = {
    'Content-Type': 'application/json',
    'X-Trace': 'trace',
    'X-Mode': 'full',
  };
  for (const status of [200, 201]) {
    const result = read.parseResponse({
      status,
      headers,
      body: JSON.stringify({ ...payload, secret: 42 }),
    });
    assert.equal(result.kind, 'success');
    assert.equal(result.status, status);
    assert.deepEqual(json(JSON.stringify(result.data)), payload);
    assert.equal(Object.hasOwn(record(result.data), 'secret'), false);
    assert.equal(result.validatedHeaders['x-trace'], 'trace');
  }
  for (const invalid of [
    { ...payload, code: 0 },
    { ...payload, entries: [''] },
    { ...payload, note: 3 },
    { ...payload, attributes: { value: 4 } },
    { ...payload, id: '' },
  ])
    assert.equal(
      read.parseResponse({
        status: 200,
        headers,
        body: JSON.stringify(invalid),
      }).kind,
      'protocol',
    );
  for (const invalidHeaders of [
    { 'Content-Type': 'application/json' },
    { ...headers, 'X-Mode': 'wrong' },
    { ...headers, 'Content-Type': 'text/plain' },
  ])
    assert.equal(
      read.parseResponse({
        status: 200,
        headers: invalidHeaders,
        body: JSON.stringify(payload),
      }).kind,
      'protocol',
    );
  const problem = read.parseResponse({
    status: 404,
    headers,
    body: '{"message":"missing"}',
  });
  assert.equal(problem.kind, 'error');
  assert.deepEqual(problem.data, { message: 'missing' });
  const gone = read.parseResponse({
    status: 410,
    headers: { 'X-Trace': 'trace' },
    body: '',
  });
  assert.equal(gone.kind, 'error');
  assert.equal(gone.data, undefined);
  assert.equal(
    read.parseResponse({ status: 299, headers, body: JSON.stringify(payload) })
      .kind,
    'protocol',
  );
  for (const [operation, status] of [
    ['headResults', 204],
    ['resetResults', 205],
    ['cacheResults', 304],
  ] as const) {
    const result = present(client.operations[operation]).parseResponse({
      status,
      headers: { 'X-Trace': 'trace' },
      body: '',
    });
    assert.equal(result.kind, status < 300 ? 'success' : 'error');
    assert.equal(result.data, undefined);
    assert.equal(result.validatedHeaders['x-trace'], 'trace');
  }
  assert.equal(Object.hasOwn(client.operations, 'internalRead'), false);
  if (staff)
    assert.equal(
      present(staff.operations.staffRead).parseResponse({
        status: 200,
        headers,
        body: JSON.stringify(payload),
      }).kind,
      'success',
    );
}
