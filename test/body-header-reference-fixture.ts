import assert from 'node:assert/strict';
import { present, record } from './assertions.ts';
import type { RuntimeClient } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

export interface Reference {
  [keyword: string]: unknown;
  $ref: string;
  summary?: string;
  description?: string;
}
export interface BodyDefinition {
  [keyword: string]: unknown;
  required?: boolean;
  content: Record<string, { schema: Schema }>;
}
export interface HeaderDefinition {
  [keyword: string]: unknown;
  required?: boolean;
  schema: Schema;
}
export type BodyEntry = BodyDefinition | Reference;
export type HeaderEntry = HeaderDefinition | Reference;
type Response = {
  [keyword: string]: unknown;
  description: string;
  headers: Record<string, HeaderEntry>;
  content?: Record<string, { schema: Schema }>;
};
type ResponseEntry = Response | Reference;

export const bodyRef = (name: string): Reference => ({
  $ref: `#/components/requestBodies/${name}`,
});
export const headerRef = (name: string): Reference => ({
  $ref: `#/components/headers/${name}`,
});
const responseRef = (name: string): Reference => ({
  $ref: `#/components/responses/${name}`,
});
const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (required?: boolean): BodyDefinition => ({
  ...(required === undefined ? {} : { required }),
  content: { 'application/json': { schema: schemaRef('Input') } },
});
const nullableBody = (): BodyDefinition => ({
  content: { 'application/json': { schema: { type: ['string', 'null'] } } },
});
const uploadBody = (): BodyDefinition => ({
  required: true,
  content: { 'multipart/form-data': { schema: schemaRef('Upload') } },
});
const trace = (): HeaderDefinition => ({
  required: true,
  style: 'simple',
  explode: false,
  schema: schemaRef('HeaderText'),
});
const mode = (): HeaderDefinition => ({
  schema: { type: 'string', const: 'full' },
});
const done = (inline = false): Response => ({
  description: 'Synthetic creation',
  headers: {
    'X-Trace': inline ? trace() : headerRef('TraceAlias'),
    'X-Trace-Again': inline ? trace() : headerRef('Trace'),
    'X-Mode': inline ? mode() : headerRef('Mode'),
  },
  content: { 'application/json': { schema: schemaRef('Result') } },
});
const empty = (inline = false): Response => ({
  description: 'Synthetic bodyless result',
  headers: { 'X-Trace': inline ? trace() : headerRef('TraceAlias') },
});

export const bodyHeaderReferenceSelection = {
  clients: ['browser', 'native'],
  targets: { browser: 'browser', native: 'native' },
  surfaces: {
    browser: ['create', 'maybeCreate', 'nullable', 'upload', 'inspect'],
    native: ['create', 'maybeCreate', 'nullable', 'upload', 'inspect'],
    internal: ['internalCreate'],
  },
} as const;

export function bodyHeaderReferenceFixture() {
  const requestBodies: Record<string, BodyEntry> = {
    Json: jsonBody(true),
    '9.json_v1': { ...bodyRef('Json'), description: 'Intermediate body docs' },
    JsonAlias: { ...bodyRef('9.json_v1'), summary: 'Body alias' },
    OtherJsonAlias: bodyRef('Json'),
    Optional: jsonBody(),
    OptionalAlias: bodyRef('Optional'),
    Nullable: nullableBody(),
    Multipart: uploadBody(),
    MultipartAlias: bodyRef('Multipart'),
    Internal: {
      content: { 'application/json': { schema: schemaRef('InternalInput') } },
    },
    Unused: {
      content: { 'application/json': { schema: schemaRef('UnusedInput') } },
    },
  };
  const headers: Record<string, HeaderEntry> = {
    Trace: trace(),
    '9.trace_v1': { ...headerRef('Trace'), summary: 'Header docs' },
    TraceAlias: { ...headerRef('9.trace_v1'), description: 'Alias docs' },
    OtherTraceAlias: headerRef('Trace'),
    Mode: mode(),
    Unused: { schema: schemaRef('UnusedHeader') },
  };
  const schemas: Record<string, Schema> = {
    Input: {
      type: 'object',
      required: ['label', 'secret', 'serverId'],
      properties: {
        label: { type: 'string', minLength: 1 },
        secret: { type: 'string', writeOnly: true, default: 'annotation' },
        serverId: { type: 'string', readOnly: true },
      },
    },
    Result: {
      type: 'object',
      required: ['id', 'label', 'secret'],
      properties: {
        id: { type: 'string', readOnly: true, minLength: 1 },
        label: { type: 'string', minLength: 1 },
        secret: { type: 'string', writeOnly: true, default: 'annotation' },
      },
    },
    Upload: {
      type: 'object',
      required: ['caption', 'file'],
      properties: {
        caption: { type: 'string', minLength: 1 },
        file: { type: 'string', format: 'binary' },
      },
    },
    HeaderText: { type: 'string', minLength: 1, maxLength: 16 },
    InternalInput: { type: 'boolean' },
    UnusedInput: { type: 'number' },
    UnusedHeader: { type: 'string' },
  };
  const operation = (operationId: string, body?: BodyEntry) => ({
    operationId,
    ...(body === undefined ? {} : { requestBody: body }),
    responses: { 200: responseRef('Done') } as Record<string, ResponseEntry>,
  });
  const create = operation('create', bodyRef('JsonAlias'));
  create.responses = { 201: responseRef('Done') };
  const inspect = operation('inspect');
  inspect.responses['304'] = responseRef('Empty');
  const internal = operation('internalCreate', bodyRef('Internal'));
  internal.responses = { 204: responseRef('Empty') };
  return {
    openapi: '3.1.1',
    info: { title: 'Synthetic reusable bodies and headers', version: '1' },
    components: {
      schemas,
      requestBodies,
      headers,
      responses: { Done: done(), Empty: empty() },
    },
    paths: {
      '/create': { post: create },
      '/maybe': { post: operation('maybeCreate', bodyRef('OptionalAlias')) },
      '/nullable': { post: operation('nullable', bodyRef('Nullable')) },
      '/upload': { post: operation('upload', bodyRef('MultipartAlias')) },
      '/inspect': { get: inspect },
      '/internal': { post: internal },
    },
  };
}

// Expand known declarations explicitly; this oracle does not resolve the alias
// graph or reuse the compiler's reference helper.
export function inlineBodyHeaderFixture() {
  const document = bodyHeaderReferenceFixture();
  document.paths['/create'].post.requestBody = jsonBody(true);
  document.paths['/maybe'].post.requestBody = jsonBody();
  document.paths['/nullable'].post.requestBody = nullableBody();
  document.paths['/upload'].post.requestBody = uploadBody();
  document.paths['/internal'].post.requestBody = {
    content: { 'application/json': { schema: schemaRef('InternalInput') } },
  };
  for (const item of Object.values(document.paths))
    for (const operation of Object.values(item))
      for (const status of Object.keys(operation.responses))
        operation.responses[status] =
          Number(status) === 204 || Number(status) === 304
            ? empty(true)
            : done(true);
  for (const key of ['requestBodies', 'headers', 'responses'])
    Reflect.deleteProperty(document.components, key);
  return document;
}

export const bodyHeaderReferenceConsumer = `
import { operations } from './client.browser.ts';
export const create: typeof operations.create.build = operations.create.build;
create({body:{label:'label',secret:'secret'}});
// @ts-expect-error Required bodies still require their input.
create();
// @ts-expect-error Request projection excludes read-only fields.
create({body:{label:'label',secret:'secret',serverId:'id'}});
// @ts-expect-error Referenced schemas retain required fields.
create({body:{label:'label'}});
const optional = operations.maybeCreate.build();
const omitted: 'none' | 'json' = optional.bodyKind;
operations.nullable.build({body:null});
// @ts-expect-error Nullable strings do not accept numbers.
operations.nullable.build({body:1});
operations.upload.build({body:{caption:'caption',file:new File(['x'],'sample.txt')}});
// @ts-expect-error Required multipart fields retain exact types.
operations.upload.build({body:{caption:'caption',file:'path'}});
const result = operations.create.parseResponse({status:201,headers:{},body:''});
if(result.kind==='success') {
  const id: string = result.data.id;
  // @ts-expect-error Response projection excludes write-only properties.
  void result.data.secret;
  void id;
}
void omitted;
`;

export function verifyBodyHeaderReferences(
  browser: RuntimeClient,
  native?: RuntimeClient,
): void {
  for (const client of [browser, ...(native ? [native] : [])]) {
    const create = present(client.operations.create);
    const body = { label: 'label', secret: 'secret' };
    const built = create.build({ body });
    assert.equal(built.bodyKind, 'json');
    assert.deepEqual(built.body, body);
    assert.notEqual(built.body, body);
    for (const input of [
      undefined,
      {},
      { body: null },
      { body: { label: '' } },
      { body: { ...body, serverId: 'server' } },
    ])
      assert.throws(() => create.build(input), client.RequestValidationError);
    const optional = present(client.operations.maybeCreate);
    for (const input of [undefined, {}, { body: undefined }])
      assert.equal(optional.build(input).bodyKind, 'none');
    assert.deepEqual(optional.build({ body }).body, body);
    assert.throws(
      () => optional.build({ body: { label: 'label' } }),
      client.RequestValidationError,
    );
    const nullable = present(client.operations.nullable);
    assert.equal(nullable.build().bodyKind, 'none');
    assert.equal(nullable.build({ body: null }).body, null);
    assert.equal(nullable.build({ body: '' }).body, '');
    assert.throws(
      () => nullable.build({ body: 0 }),
      client.RequestValidationError,
    );
    const headers = {
      'Content-Type': 'application/json',
      'X-Trace': 'trace',
      'X-Trace-Again': 'again',
      'X-Mode': 'full',
    };
    const response = { id: 'id', label: 'label', secret: 3 };
    const parsed = create.parseResponse({
      status: 201,
      headers,
      body: JSON.stringify(response),
    });
    assert.equal(parsed.kind, 'success');
    assert.deepEqual(parsed.data, { id: 'id', label: 'label' });
    assert.equal(parsed.validatedHeaders['x-trace'], 'trace');
    assert.equal(parsed.validatedHeaders['x-trace-again'], 'again');
    for (const bad of [
      { ...headers, 'X-Trace': '' },
      { ...headers, 'X-Trace-Again': '' },
      { ...headers, 'X-Mode': 'wrong' },
    ])
      assert.equal(
        create.parseResponse({
          status: 201,
          headers: bad,
          body: JSON.stringify(response),
        }).kind,
        'protocol',
      );
    assert.equal(
      present(client.operations.inspect).parseResponse({
        status: 304,
        headers: { 'X-Trace': 'trace' },
        body: '',
      }).kind,
      'error',
    );
  }
  for (const [client, file] of [
    [browser, new File(['synthetic'], 'synthetic.txt', { type: 'text/plain' })],
    ...(native
      ? ([
          [
            native,
            {
              uri: 'file:///synthetic/upload.txt',
              name: 'upload.txt',
              mediaType: 'text/plain',
            },
          ],
        ] as const)
      : []),
  ] as const) {
    const upload = present(client.operations.upload);
    const body = { caption: 'caption', file };
    const request = upload.build({ body });
    assert.equal(request.bodyKind, 'multipart');
    assert.deepEqual(request.body, body);
    assert.notEqual(request.body, body);
    assert.deepEqual(record(request)['multipart'], [
      { name: 'caption', kind: 'text', multiple: false, required: true },
      { name: 'file', kind: 'file', multiple: false, required: true },
    ]);
    for (const bad of [
      undefined,
      {},
      { body: { file } },
      { body: { caption: '', file } },
    ])
      assert.throws(() => upload.build(bad), client.RequestValidationError);
  }
}
