import assert from 'node:assert/strict';
import type { Parameter } from './helpers.ts';
import type { RuntimeClient } from './runtime-types.ts';

export const parameterReference = (name: string) => ({
  $ref: `#/components/parameters/${name}`,
});

export interface ParameterReference {
  $ref: string;
  summary?: string;
  description?: string;
}
type Entry = Parameter | ParameterReference;

export const parameterReferenceSelection = {
  clients: ['consumer', 'staff'],
  surfaces: {
    consumer: ['readEntries'],
    staff: ['writeEntry'],
    internal: ['internalReport'],
  },
};

export function parameterReferenceFixture() {
  const parameters: Record<string, Entry> = {
    EntryKey: {
      ...parameterReference('9.entry-key_v1'),
      description: 'Key alias',
    },
    '9.entry-key_v1': {
      name: 'entryId',
      in: 'path',
      required: true,
      schema: { $ref: '#/components/schemas/EntryId' },
    },
    BaseMode: {
      name: 'mode',
      in: 'query',
      schema: { type: 'string', enum: ['base'] },
    },
    ReadMode: {
      name: 'mode',
      in: 'query',
      required: true,
      schema: { type: 'string', enum: ['read'] },
    },
    ScopeAlias: {
      ...parameterReference('Scope'),
      summary: 'Ignored parameter summary',
    },
    Scope: {
      name: 'X-Scope',
      in: 'header',
      required: true,
      schema: { type: 'string', const: 'tenant' },
    },
    StaffScope: {
      name: 'X-Scope',
      in: 'header',
      required: true,
      schema: { type: 'string', const: 'staff' },
    },
    Tags: {
      name: 'tags',
      in: 'query',
      schema: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
    CursorAlias: parameterReference('Cursor'),
    OtherCursorAlias: parameterReference('Cursor'),
    Cursor: {
      name: 'after',
      in: 'query',
      schema: { type: ['string', 'null'], maxLength: 8, default: 'unused' },
    },
    SameNameQuery: {
      name: 'entryId',
      in: 'query',
      schema: { type: 'integer', minimum: 0 },
    },
    InternalKey: {
      name: 'secretId',
      in: 'path',
      required: true,
      schema: { $ref: '#/components/schemas/SecretId' },
    },
    Unused: {
      name: 'unused',
      in: 'query',
      schema: { $ref: '#/components/schemas/UnusedValue' },
    },
  };
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic reusable parameters', version: '1' },
    components: {
      parameters,
      schemas: {
        EntryId: { $ref: '#/components/schemas/Key', maxLength: 32 },
        Key: { type: 'string', minLength: 1 },
        SecretId: { type: 'string' },
        UnusedValue: { type: 'boolean' },
      },
    },
    paths: {
      '/entries/{entryId}': {
        parameters: [
          parameterReference('EntryKey'),
          parameterReference('BaseMode'),
          parameterReference('ScopeAlias'),
          parameterReference('Tags'),
          parameterReference('CursorAlias'),
        ] as Entry[],
        get: {
          operationId: 'readEntries',
          parameters: [
            parameterReference('ReadMode'),
            parameterReference('SameNameQuery'),
          ] as Entry[],
          responses: { 204: { description: 'Read' } },
        },
        post: {
          operationId: 'writeEntry',
          parameters: [parameterReference('StaffScope')] as Entry[],
          responses: { 204: { description: 'Written' } },
        },
      },
      '/internal/{secretId}': {
        parameters: [parameterReference('InternalKey')] as Entry[],
        get: {
          operationId: 'internalReport',
          responses: { 204: { description: 'Internal' } },
        },
      },
    },
  };
}

// Independent explicit declarations establish that references only change input
// spelling; inheritance, schema constraints and output projection stay identical.
export function inlineParameterFixture() {
  const document = parameterReferenceFixture();
  const item = document.paths['/entries/{entryId}'];
  item.parameters = [
    {
      name: 'entryId',
      in: 'path',
      required: true,
      schema: { $ref: '#/components/schemas/EntryId' },
    },
    { name: 'mode', in: 'query', schema: { type: 'string', enum: ['base'] } },
    {
      name: 'X-Scope',
      in: 'header',
      required: true,
      schema: { type: 'string', const: 'tenant' },
    },
    {
      name: 'tags',
      in: 'query',
      schema: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
    {
      name: 'after',
      in: 'query',
      schema: { type: ['string', 'null'], maxLength: 8, default: 'unused' },
    },
  ];
  item.get.parameters = [
    {
      name: 'mode',
      in: 'query',
      required: true,
      schema: { type: 'string', enum: ['read'] },
    },
    { name: 'entryId', in: 'query', schema: { type: 'integer', minimum: 0 } },
  ];
  item.post.parameters = [
    {
      name: 'X-Scope',
      in: 'header',
      required: true,
      schema: { type: 'string', const: 'staff' },
    },
  ];
  document.paths['/internal/{secretId}'].parameters = [
    {
      name: 'secretId',
      in: 'path',
      required: true,
      schema: { $ref: '#/components/schemas/SecretId' },
    },
  ];
  Reflect.deleteProperty(document.components, 'parameters');
  return document;
}

export const parameterReferenceConsumer = `
import { operations } from './client.consumer.ts';
import { operations as staff } from './client.staff.ts';
export const read: typeof operations.readEntries.build = operations.readEntries.build;
read({ path: { entryId: 'a/b' }, query: { mode: 'read', after: null, tags: ['one'], entryId: 1 }, headers: { 'X-Scope': 'tenant' } });
// @ts-expect-error Referenced path parameters remain required.
read({ query: { mode: 'read' }, headers: { 'X-Scope': 'tenant' } });
// @ts-expect-error Referenced header requirements survive aliases.
read({ path: { entryId: 'id' }, query: { mode: 'read' } });
// @ts-expect-error Whole-parameter override replaces the inherited literal.
read({ path: { entryId: 'id' }, query: { mode: 'base' }, headers: { 'X-Scope': 'tenant' } });
// @ts-expect-error A same-name query parameter keeps its own integer type.
read({ path: { entryId: 'id' }, query: { mode: 'read', entryId: 'text' }, headers: { 'X-Scope': 'tenant' } });
// @ts-expect-error Nullable cursors remain strings when non-null.
read({ path: { entryId: 'id' }, query: { mode: 'read', after: 1 }, headers: { 'X-Scope': 'tenant' } });
staff.writeEntry.build({ path: { entryId: 'id' }, headers: { 'X-Scope': 'staff' } });
// @ts-expect-error The write header overrides the inherited tenant literal.
staff.writeEntry.build({ path: { entryId: 'id' }, headers: { 'X-Scope': 'tenant' } });
`;

export function verifyParameterReferences(
  client: RuntimeClient,
  staff: RuntimeClient,
): void {
  const read = client.operations.readEntries;
  assert.ok(read);
  const write = staff.operations.writeEntry;
  assert.ok(write);
  const input = {
    path: { entryId: 'a/b' },
    query: { mode: 'read', tags: ['one', 'two'], after: null, entryId: 3 },
    headers: { 'X-Scope': 'tenant' },
  };
  const request = read.build(input);
  assert.equal(
    request.url,
    '/entries/a%2Fb?mode=read&tags=one&tags=two&entryId=3',
  );
  assert.equal(request.headers['X-Scope'], 'tenant');
  assert.equal(
    read.build({ ...input, query: { mode: 'read', after: 'a/?&' } }).url,
    '/entries/a%2Fb?mode=read&after=a%2F%3F%26',
  );
  assert.equal(
    read.build({ ...input, query: { mode: 'read', after: '' } }).url,
    '/entries/a%2Fb?mode=read&after=',
  );
  for (const invalid of [
    { ...input, path: {} },
    { ...input, path: { entryId: '' } },
    { ...input, path: { entryId: 'x'.repeat(33) } },
    { ...input, query: {} },
    { ...input, query: { mode: 'base' } },
    { ...input, query: { mode: 'read', tags: [''] } },
    { ...input, query: { mode: 'read', after: 'x'.repeat(9) } },
    { ...input, query: { mode: 'read', entryId: -1 } },
    { ...input, query: { mode: 'read', entryId: '3' } },
    { ...input, headers: {} },
    { ...input, headers: { 'X-Scope': 'staff' } },
  ])
    assert.throws(() => read.build(invalid), client.RequestValidationError);
  assert.equal(
    write.build({ path: { entryId: 'id' }, headers: { 'X-Scope': 'staff' } })
      .url,
    '/entries/id',
  );
  assert.equal(
    write.build({
      path: { entryId: 'id' },
      query: { mode: 'base' },
      headers: { 'X-Scope': 'staff' },
    }).url,
    '/entries/id?mode=base',
  );
  assert.throws(
    () =>
      write.build({
        path: { entryId: 'id' },
        query: { mode: 'read' },
        headers: { 'X-Scope': 'staff' },
      }),
    staff.RequestValidationError,
  );
  assert.throws(
    () =>
      write.build({
        path: { entryId: 'id' },
        headers: { 'X-Scope': 'tenant' },
      }),
    staff.RequestValidationError,
  );
  assert.deepEqual(input.query.tags, ['one', 'two']);
}
