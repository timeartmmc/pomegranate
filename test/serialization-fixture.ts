import assert from 'node:assert/strict';
import { present } from './assertions.ts';
import type { MediaClient } from './media-fixture.ts';
import type { Schema } from './schema-helpers.ts';
import { ref } from './schema-helpers.ts';

export function serializationFixture(modern = true) {
  const form: Schema = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 0 },
      enabled: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' }, minItems: 1 },
      csvTags: ref('Labels'),
      ids: { type: 'array', items: { type: 'integer' }, minItems: 1 },
      note: { type: 'string' },
    },
    required: ['name', 'count', 'enabled'],
  };
  const content = {
    'application/x-www-form-urlencoded': {
      schema: ref('Form'),
      encoding: {
        ids: { style: 'form', explode: false },
        csvTags: { explode: false },
      },
    },
  };
  const count: Schema = { type: 'integer', minimum: 0, maximum: 10 };
  const values: Schema = {
    type: 'array',
    items: { type: 'number', minimum: 0 },
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
  };
  const labels: Schema = {
    type: 'array',
    items: { type: 'string', minLength: 1 },
  };
  const nullable: Schema = modern
    ? { type: ['integer', 'null'] }
    : { type: 'integer', nullable: true };
  return {
    openapi: modern ? '3.1.2' : '3.0.4',
    info: { title: 'Synthetic wire serialization', version: '1' },
    components: {
      schemas: { Count: count, Values: values, Labels: labels, Form: form },
    },
    paths: {
      '/form': {
        post: {
          operationId: 'submit',
          requestBody: { required: true, content },
          responses: { 204: { description: 'Submitted' } },
        },
      },
      '/optional-form': {
        post: {
          operationId: 'optionalForm',
          requestBody: { content },
          responses: { 204: { description: 'Submitted' } },
        },
      },
      '/headers': {
        get: {
          operationId: 'headers',
          parameters: [
            {
              in: 'header',
              name: 'X-Count',
              required: true,
              schema: ref('Count'),
            },
            {
              in: 'header',
              name: 'X-Enabled',
              required: true,
              schema: { type: 'boolean' },
            },
            {
              in: 'header',
              name: 'X-Values',
              required: true,
              schema: ref('Values'),
            },
            {
              in: 'header',
              name: 'X-Labels',
              schema: ref('Labels'),
              style: 'simple',
              explode: true,
            },
            { in: 'header', name: 'X-Optional', schema: nullable },
            {
              in: 'header',
              name: 'X-Empty',
              schema: { type: 'array', items: { type: 'string' } },
            },
          ],
          responses: {
            200: {
              description: 'Checked headers',
              headers: {
                'X-Count': { required: true, schema: ref('Count') },
                'X-Enabled': { required: true, schema: { type: 'boolean' } },
                'X-Values': { required: true, schema: ref('Values') },
                'X-Labels': { schema: ref('Labels') },
                'X-Flags': {
                  schema: { type: 'array', items: { type: 'boolean' } },
                },
              },
            },
          },
        },
      },
    },
  };
}
export const serializationSelection = {
  clients: ['consumer'],
  executionClients: ['consumer'],
  surfaces: { consumer: ['headers', 'submit', 'optionalForm'] },
  standalone: { count: { schema: ref('Count').$ref, usage: 'response' } },
} as const;

export function verifySerialization(client: MediaClient): void {
  const operation = present(client.operations.headers);
  const input = {
    headers: {
      'X-Count': 2,
      'X-Enabled': false,
      'X-Values': [0.5, 1],
      'X-Labels': ['a', 'b'],
      'X-Optional': null,
      'X-Empty': [],
    },
  };
  const before = structuredClone(input);
  const request = operation.build(input);
  assert.deepEqual(
    { ...request.headers },
    {
      'X-Count': '2',
      'X-Enabled': 'false',
      'X-Values': '0.5,1',
      'X-Labels': 'a,b',
      'X-Empty': '',
    },
  );
  assert.deepEqual(input, before);
  assert.equal(request.validateHeaders(request.headers)['x-count'], '2');
  for (const headers of [
    { ...input.headers, 'X-Count': '2' },
    { ...input.headers, 'X-Count': 2.5 },
    { ...input.headers, 'X-Values': [1, 1] },
    { ...input.headers, 'X-Labels': ['a,b'] },
    { ...input.headers, 'X-Labels': [' a'] },
    { ...input.headers, 'X-Empty': [''] },
  ])
    assert.throws(
      () => operation.build({ headers }),
      client.RequestValidationError,
    );
  for (const raw of ['0x2', 'NaN', 'Infinity', '2x', '2.5', '', '11'])
    assert.throws(
      () => request.validateHeaders({ ...request.headers, 'X-Count': raw }),
      client.RequestValidationError,
    );
  const observed = {
    'X-Count': '2',
    'X-Enabled': 'false',
    'X-Values': '0.5, 1',
    'X-Labels': 'a, b',
    'X-Flags': 'true,false',
  };
  const result = operation.parseResponse({
    status: 200,
    headers: observed,
    body: '',
  });
  assert.equal(result.kind, 'success');
  assert.equal(result.validatedHeaders['x-count'], '2');
  assert.equal(result.validatedHeaders['x-values'], '0.5, 1');
  for (const change of [
    { 'X-Count': '2.5' },
    { 'X-Count': '' },
    { 'X-Enabled': 'False' },
    { 'X-Values': '1,1' },
    { 'X-Values': '1,,2' },
    { 'X-Flags': 'true,yes' },
  ])
    assert.equal(
      operation.parseResponse({
        status: 200,
        headers: { ...observed, ...change },
        body: '',
      }).kind,
      'protocol',
    );
}

export function verifyFormSerialization(client: MediaClient): void {
  const submit = present(client.operations.submit);
  const body = {
    name: 'demo + 🌱',
    count: 0,
    enabled: false,
    tags: ['a,b', '', 'c d'],
    ids: [1, 2],
    csvTags: ['alpha,beta', 'c d'],
    note: 'a\nb',
  };
  const before = structuredClone(body);
  const form = submit.build({ body });
  assert.equal(form.bodyKind, 'form');
  if (form.bodyKind === 'form') {
    assert.equal(form.contentType, 'application/x-www-form-urlencoded');
    const fields = new URLSearchParams(form.body);
    assert.equal(fields.get('name'), body.name);
    assert.equal(fields.get('count'), '0');
    assert.equal(fields.get('enabled'), 'false');
    assert.deepEqual(fields.getAll('tags'), body.tags);
    assert.equal(fields.get('ids'), '1,2');
    assert.ok(form.body.split('&').includes('ids=1,2'));
    assert.ok(form.body.split('&').includes('csvTags=alpha%2Cbeta,c%20d'));
    assert.equal(fields.get('note'), 'a\nb');
    assert.ok(form.body.includes('name=demo+%2B+%F0%9F%8C%B1'));
  }
  assert.deepEqual(body, before);
  for (const invalid of [
    { ...body, count: '0' },
    { ...body, tags: [] },
    { ...body, note: '\ud800' },
    { ...body, ids: ['1'] },
    { ...body, extra: 1 },
  ])
    assert.throws(
      () => submit.build({ body: invalid }),
      client.RequestValidationError,
    );
  const optional = present(client.operations.optionalForm);
  assert.equal(optional.build().bodyKind, 'none');
  assert.equal(optional.build({ body: undefined }).bodyKind, 'none');
  assert.equal(optional.build({ body }).bodyKind, 'form');
}

export const serializationConsumer = `
import { operations } from './client.consumer.ts';
const headers = { 'X-Count': 2, 'X-Enabled': true, 'X-Values': [0.5, 1] };
operations.headers.build({ headers });
// @ts-expect-error Header schemas retain their numeric input type.
operations.headers.build({ headers: { ...headers, 'X-Count': '2' } });
// @ts-expect-error Array item types remain checked.
operations.headers.build({ headers: { ...headers, 'X-Values': ['1'] } });
const result = operations.headers.parseResponse({ status: 200, headers: {}, body: '' });
const raw: string | undefined = result.validatedHeaders['x-count']; void raw;
const form = operations.submit.build({ body: { name: 'demo', count: 0, enabled: false, tags: ['a'] } });
const encoded: string = form.body; void encoded;
operations.optionalForm.build();
const maybe = operations.optionalForm.build({ body: { name: 'demo', count: 0, enabled: false } });
if (maybe.bodyKind === 'form') { const value: string = maybe.body; void value; }
// @ts-expect-error Form body inputs keep their declared field types.
operations.submit.build({ body: { name: 'demo', count: '0', enabled: false } });
`;
