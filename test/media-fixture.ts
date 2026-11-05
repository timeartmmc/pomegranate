import assert from 'node:assert/strict';
import { present } from './assertions.ts';
import type {
  ObservedResponse,
  PreparedRequest,
  ProtocolResult,
  RequestValidationError,
  Responses,
} from '../src/runtime.ts';
import type { Schema } from './schema-helpers.ts';

interface Media {
  schema: Schema;
}
export interface MediaClient {
  operations: Record<
    string,
    {
      build(input?: unknown): PreparedRequest<Responses>;
      parseResponse(response: ObservedResponse): ProtocolResult<Responses>;
    }
  >;
  RequestValidationError: typeof RequestValidationError;
}

const ref = (name: string): Schema => ({
  $ref: `#/components/schemas/${name}`,
});
const entries = (values: Record<string, Schema>): Record<string, Media> =>
  Object.fromEntries(
    Object.entries(values).map(([name, schema]) => [name, { schema }]),
  );
const representations = () =>
  entries({
    'application/vnd.zeta+json': { type: 'integer', enum: [2] },
    'text/plain': { type: 'string', enum: ['text'] },
    'application/json': ref('Envelope'),
    'application/vnd.alpha+json': { type: 'boolean', enum: [true] },
  });
const suffixes = () =>
  entries({
    'application/vnd.zeta+json': { type: 'integer', enum: [2] },
    'text/plain': { type: 'string', enum: ['text'] },
    'application/vnd.alpha+json': { type: 'string', enum: ['alpha'] },
  });
const operation = (
  operationId: string,
  content: Record<string, Media>,
  required = true,
) => ({
  operationId,
  requestBody: { required, content },
  responses: {
    200: {
      description: 'Synthetic media response',
      content: structuredClone(content),
    },
  },
});

export function mediaFixture(modern = true) {
  const errorContent = () =>
    entries({
      'application/problem+json': {
        type: 'object',
        required: ['detail'],
        properties: { detail: { type: 'string', enum: ['failure'] } },
      },
      'text/plain': ref('TextAlias'),
    });
  const preferred = operation('preferred', representations(), false);
  Object.assign(preferred.responses, {
    202: {
      description: 'A different representation for this status',
      content: entries({ 'text/plain': ref('TextAlias') }),
    },
    204: { description: 'No content' },
    400: {
      description: 'Declared error representations',
      content: errorContent(),
    },
  });
  const optional = operation(
    'optional',
    entries({ 'text/plain': ref('TextAlias') }),
    false,
  );
  const multipartFallback = operation(
    'multipartFallback',
    entries({ 'text/plain': ref('TextAlias') }),
  );
  for (const value of [optional, preferred, multipartFallback])
    value.requestBody.content['multipart/form-data'] = {
      schema: {
        type: 'object',
        properties: { file: { type: 'string', format: 'binary' } },
        required: ['file'],
      },
    };
  return {
    openapi: modern ? '3.1.2' : '3.0.4',
    info: {
      title: 'Synthetic request selection and response media dispatch',
      version: '1',
    },
    components: {
      schemas: {
        Envelope: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', enum: ['ok'] } },
        },
        Text: { type: 'string', enum: ['', 'hello', '{"ok":true}'] },
        Constrained: {
          type: 'string',
          minLength: 2,
          maxLength: 5,
          pattern: '^[a-z]+$',
        },
        TextAlias: ref('Text'),
        ConstrainedAlias: ref('Constrained'),
      } satisfies Record<string, Schema>,
    },
    paths: {
      '/suffix': {
        post: operation(
          'suffix',
          entries({ 'application/problem+json': ref('Envelope') }),
        ),
      },
      '/text': {
        post: operation('text', entries({ 'text/plain': ref('TextAlias') })),
      },
      '/optional': { post: optional },
      '/preferred': { post: preferred },
      '/sorted': { post: operation('sorted', suffixes()) },
      '/custom': {
        post: operation(
          'custom',
          entries({ 'text/example+json': { type: 'integer', enum: [7] } }),
        ),
      },
      '/vendor-type': {
        post: operation(
          'vendorType',
          entries({ 'x-example/item+json': { type: 'boolean' } }),
        ),
      },
      '/multipart-fallback': { post: multipartFallback },
      '/unicode-text': {
        post: operation(
          'unicodeText',
          entries({ 'text/plain': { type: 'string' } }),
        ),
      },
      '/read': {
        get: {
          operationId: 'read',
          responses: {
            200: {
              description: 'Text',
              content: entries({ 'text/plain': ref('ConstrainedAlias') }),
            },
          },
        },
      },
      '/representations': {
        get: {
          operationId: 'readRepresentations',
          responses: {
            200: {
              description: 'All declared representations',
              content: {
                ...representations(),
                'text/plain': { schema: ref('TextAlias') },
              },
            },
            202: {
              description: 'Text for another success status',
              content: entries({ 'text/plain': ref('TextAlias') }),
            },
            400: {
              description: 'Declared error representations',
              content: errorContent(),
            },
          },
        },
      },
    },
  };
}

export const mediaSelection = {
  clients: ['consumer'],
  executionClients: ['consumer'],
  surfaces: {
    consumer: [
      'suffix',
      'text',
      'optional',
      'preferred',
      'sorted',
      'custom',
      'vendorType',
      'multipartFallback',
      'unicodeText',
      'read',
      'readRepresentations',
    ],
  },
  queries: { consumer: ['read', 'readRepresentations'] },
} as const;

export function verifyMedia(client: MediaClient): void {
  for (const [name, body, media] of [
    ['suffix', { code: 'ok' }, 'application/problem+json'],
    ['preferred', { code: 'ok' }, 'application/json'],
    ['sorted', 'alpha', 'application/vnd.alpha+json'],
    ['custom', 7, 'text/example+json'],
    ['vendorType', true, 'x-example/item+json'],
  ] as const) {
    const operation = present(client.operations[name]);
    const request = operation.build({ body });
    assert.equal(request.bodyKind, 'json');
    if (request.bodyKind === 'json') {
      assert.equal(request.contentType, media);
      assert.deepEqual(request.body, body);
    }
    for (const contentType of [
      media,
      `${media.toUpperCase()}; charset=utf-8`,
      `${media}; profile="a;b"`,
      `${media};;`,
    ]) {
      const response = operation.parseResponse({
        status: 200,
        headers: { 'Content-Type': contentType },
        body: JSON.stringify(body),
      });
      assert.equal(response.kind, 'success', `${name}/${contentType}`);
      assert.deepEqual(response.data, body);
      assert.equal(response.contentType, media);
    }
    for (const contentType of [
      'text/plain',
      'application/other+json',
      ...(media === 'application/json' ? [] : ['application/json']),
    ])
      assert.equal(
        operation.parseResponse({
          status: 200,
          headers: { 'Content-Type': contentType },
          body: JSON.stringify(body),
        }).kind,
        'protocol',
        `${name}/${contentType}`,
      );
  }
  for (const [name, contentType, body, data] of [
    ['preferred', 'application/vnd.alpha+json', 'true', true],
    ['preferred', 'application/vnd.zeta+json', '2', 2],
    ['preferred', 'text/plain', 'text', 'text'],
    ['sorted', 'application/vnd.zeta+json', '2', 2],
    ['sorted', 'text/plain', 'text', 'text'],
    ['readRepresentations', 'text/plain', '{"ok":true}', '{"ok":true}'],
    ['readRepresentations', 'text/plain', '', ''],
  ] as const) {
    const response = present(client.operations[name]).parseResponse({
      status: 200,
      headers: { 'Content-Type': contentType },
      body,
    });
    assert.equal(response.kind, 'success');
    assert.deepEqual(response.data, data);
    assert.equal(response.contentType, contentType);
  }
  for (const [contentType, body, data] of [
    ['application/problem+json', '{"detail":"failure"}', { detail: 'failure' }],
    ['text/plain', 'hello', 'hello'],
  ] as const) {
    const response = present(client.operations.preferred).parseResponse({
      status: 400,
      headers: { 'Content-Type': contentType },
      body,
    });
    assert.equal(response.kind, 'error');
    assert.deepEqual(response.data, data);
    assert.equal(response.contentType, contentType);
  }
  const empty = present(client.operations.preferred).parseResponse({
    status: 204,
    headers: {},
    body: '',
  });
  assert.equal(empty.kind, 'success');
  assert.equal(empty.data, undefined);
  assert.ok(Object.hasOwn(empty, 'contentType'));
  assert.equal(empty.contentType, undefined);
  const text = present(client.operations.text);
  const accepted = present(client.operations.preferred).parseResponse({
    status: 202,
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(accepted.kind, 'success');
  assert.equal(accepted.data, 'hello');
  assert.equal(
    present(client.operations.preferred).parseResponse({
      status: 202,
      headers: { 'Content-Type': 'application/json' },
      body: '"hello"',
    }).kind,
    'protocol',
  );
  const optional = present(client.operations.optional);
  const unicode = present(client.operations.unicodeText);
  const unicodeRequest = unicode.build({ body: '😀' });
  assert.equal(unicodeRequest.bodyKind, 'text');
  if (unicodeRequest.bodyKind === 'text')
    assert.equal(unicodeRequest.body, '😀');
  for (const body of ['\ud800', '\udc00', 'a\ud800b'])
    assert.throws(() => unicode.build({ body }), client.RequestValidationError);
  assert.equal(
    present(client.operations.multipartFallback).build({ body: 'hello' })
      .bodyKind,
    'text',
  );
  for (const body of ['', 'hello', '{"ok":true}']) {
    const request = text.build({ body });
    assert.equal(request.bodyKind, 'text');
    if (request.bodyKind === 'text') {
      assert.equal(request.contentType, 'text/plain');
      assert.equal(request.body, body);
    }
    const response = text.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'text/plain;; charset=utf-8;' },
      body,
    });
    assert.equal(response.kind, 'success');
    assert.equal(response.data, body);
    assert.equal(optional.build({ body }).bodyKind, 'text');
  }
  for (const operation of [optional, present(client.operations.preferred)])
    for (const input of [undefined, {}, { body: undefined }]) {
      const request = operation.build(input);
      assert.equal(request.bodyKind, 'none');
      assert.equal(Object.hasOwn(request, 'body'), false);
      assert.equal(Object.hasOwn(request, 'contentType'), false);
    }
  for (const body of [null, 1, 'wrong'])
    assert.throws(
      () => optional.build({ body }),
      client.RequestValidationError,
    );
  assert.throws(() => text.build(), client.RequestValidationError);
  for (const body of ['"hello"', 'wrong'])
    assert.equal(
      text.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
        body,
      }).kind,
      'protocol',
    );
  assert.equal(
    text.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '"hello"',
    }).kind,
    'protocol',
  );
  const read = present(client.operations.read);
  assert.equal(
    read.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    }).kind,
    'success',
  );
  for (const body of ['', 'x', 'toolong', '123'])
    assert.equal(
      read.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
        body,
      }).kind,
      'protocol',
    );
  const suffix = present(client.operations.suffix);
  for (const contentType of [
    'application/problem+json; charset',
    'application/problem+json; charset=',
    'application/problem+json; charset="unfinished',
    'application/problem+json, application/json',
    'application/problem+json/other',
    'application/problem+json; charset=utf-8\n',
    '',
  ])
    assert.equal(
      suffix.parseResponse({
        status: 200,
        headers: { 'Content-Type': contentType },
        body: '{"code":"ok"}',
      }).kind,
      'protocol',
      contentType,
    );
  assert.equal(
    suffix.parseResponse({ status: 200, headers: {}, body: '{"code":"ok"}' })
      .kind,
    'protocol',
  );
}

export const mediaConsumer = `
import { operations, createClient } from './client.consumer.ts';
import type { Executor, PreparedRequest } from './client.consumer.ts';
import { createQueries } from './client.consumer.queries.ts';
operations.text.build({body:'hello'});
operations.optional.build();
operations.optional.build({body:''});
operations.preferred.build();
// @ts-expect-error An unused multipart alternative does not widen the selected JSON type.
operations.preferred.build({body:{file:'upload'}});
// @ts-expect-error Text request schemas retain literal types.
operations.text.build({body:'wrong'});
// @ts-expect-error Text bodies retain requiredness.
operations.text.build();
// @ts-expect-error Optional text does not accept null.
operations.optional.build({body:null});
operations.suffix.build({body:{code:'ok'}});
// @ts-expect-error JSON request types follow the selected representation.
operations.preferred.build({body:true});
operations.sorted.build({body:'alpha'});
// @ts-expect-error Nonpreferred representations do not widen selected types.
operations.sorted.build({body:2});
function inspect(request: PreparedRequest) {
  if (request.bodyKind === 'text') {
    const contentType:string=request.contentType;
    void contentType;
  }
  if (request.bodyKind === 'json') { const contentType:string=request.contentType; void contentType; }
}
const execute:Executor=async (request) => {
  inspect(request);
  return {status:200,headers:{'Content-Type':'text/plain'},body:'hello'};
};
export async function read() {
  const client=createClient({namespace:'media',execute});
  const result=await client.text.call({input:{body:'hello'},context:{}});
  const text:''|'hello'|'{"ok":true}'=result.data;
  const queries=createQueries({namespace:'media',execute});
  queries.read.body().options({context:{}});
  return text;
}
export const parsePreferred: typeof operations.preferred.parseResponse = operations.preferred.parseResponse;
export function inspectPreferred() {
  const result=parsePreferred({status:200,headers:{},body:''});
  if(result.kind==='protocol') return;
  if(result.status===204) {
    const absent:undefined=result.contentType;
    const data:undefined=result.data;
    void [absent,data];
  } else if(result.status===200) {
    const {contentType,data}=result;
    if(contentType==='application/json') {
      const code:'ok'=data.code;
      // @ts-expect-error MIME narrowing excludes the text representation.
      const text:string=data;
      void [code,text];
    } else if(contentType==='application/vnd.alpha+json') {
      const flag:true=data; void flag;
    } else if(contentType==='application/vnd.zeta+json') {
      const count:2=data; void count;
    } else {
      const text:'text'=data;
      // @ts-expect-error Text responses do not expose JSON fields.
      void data.code;
      void text;
    }
  } else if(result.kind==='error') {
    if(result.contentType==='application/problem+json') {
      const detail:'failure'=result.data.detail; void detail;
    } else { const text:''|'hello'|'{"ok":true}'=result.data; void text; }
  }
}
`;
