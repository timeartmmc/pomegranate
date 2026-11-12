import assert from 'node:assert/strict';
import { present } from './assertions.ts';
import type { MediaClient } from './media-fixture.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

const textTypes = ['text/html', 'text/csv', 'application/yaml'] as const;
export function interoperabilityFixture(openapi = '3.0.4') {
  const shared = {
    properties: { id: { type: 'integer', format: 'uint32' } },
    required: ['id'],
  };
  const cat: Schema = {
    type: 'object',
    additionalProperties: true,
    properties: {
      kind: { type: 'string', enum: ['Cat'] },
      amount: { type: 'number', format: 'decimal', multipleOf: 0.1 },
      metadata: {
        properties: { label: { type: 'string' } },
        additionalProperties: {},
      },
    },
    required: ['kind', 'amount'],
  };
  const schemas: Record<string, Schema> = {
    Cat: cat,
    Dog: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['Dog'] } },
      required: ['kind'],
    },
    Animal: {
      type: 'object',
      ...shared,
      oneOf: [ref('Cat'), ref('Dog')],
      discriminator: { propertyName: 'kind' },
    },
    Value: { type: 'object', required: ['id'], anyOf: [ref('Animal')] },
    Single: { type: 'object', ...shared, oneOf: [ref('Cat')] },
  };
  const content = { 'text/json; charset=UTF-8': { schema: ref('Value') } };
  return {
    openapi,
    info: { title: 'Synthetic interoperability example', version: '1' },
    components: {
      schemas,
      links: {
        Next: {
          operationId: 'text0',
          parameters: { id: '$response.body#/id' },
        },
        Alias: { $ref: '#/components/links/Next' },
      },
    },
    paths: {
      '/records/{id}.json': {
        delete: {
          operationId: 'remove',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          requestBody: {
            required: true,
            content: { 'text/json; charset=UTF-8': { schema: ref('Single') } },
          },
          responses: {
            200: {
              description: 'Removed',
              content,
              links: { next: { $ref: '#/components/links/Alias' } },
            },
          },
        },
      },
      ...Object.fromEntries(
        textTypes.map((type, index) => {
          const text = { [type]: { schema: { type: 'string', minLength: 2 } } };
          return [
            `/text${index}`,
            {
              options: {
                operationId: `text${index}`,
                requestBody: { required: true, content: text },
                responses: { 200: { description: 'Text', content: text } },
              },
            },
          ];
        }),
      ),
    },
  };
}

export const interoperabilitySelection = {
  clients: ['consumer'],
  surfaces: { consumer: ['remove', 'text0', 'text1', 'text2'] },
  formats: {
    uint32: { type: 'integer', minimum: 0, maximum: 4_294_967_295 },
    decimal: { type: 'number', multipleOf: 0.25 },
  },
  standalone: { value: { schema: ref('Value').$ref, usage: 'request' } },
} as const;

export function verifyInteroperability(
  client: MediaClient,
  standalone: StandaloneModule,
): void {
  const operation = present(client.operations.remove);
  const body = {
    kind: 'Cat',
    id: 4_294_967_295,
    amount: 0.5,
    metadata: { label: 'declared' },
  };
  const request = operation.build({ path: { id: 'a/b' }, body });
  assert.equal(request.method, 'DELETE');
  assert.equal(request.url, '/records/a%2Fb.json');
  assert.equal(request.bodyKind, 'json');
  if (request.bodyKind === 'json')
    assert.equal(request.contentType, 'text/json; charset=utf-8');
  assert.deepEqual(request.body, body);
  assert.deepEqual(standalone.schema.parse(body), body);
  assert.deepEqual(standalone.schema.parse({ kind: 'Dog', id: 0 }), {
    kind: 'Dog',
    id: 0,
  });
  assert.equal(standalone.schema.safeParse({ kind: 'Dog' }).success, false);
  for (const invalid of [
    { ...body, id: -1 },
    { ...body, amount: 0.1 },
    { ...body, amount: 0.25 },
    { ...body, kind: 'cat' },
    { ...body, extra: true },
    { ...body, metadata: { ...body.metadata, extra: true } },
  ]) {
    assert.throws(
      () => operation.build({ path: { id: 'x' }, body: invalid }),
      client.RequestValidationError,
    );
    assert.equal(standalone.schema.safeParse(invalid).success, false);
  }
  const result = operation.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'text/json; charset=utf-8' },
    body: JSON.stringify({
      ...body,
      extra: true,
      metadata: { ...body.metadata, extra: true },
    }),
  });
  assert.equal(result.kind, 'success');
  assert.equal(result.contentType, 'text/json');
  assert.deepEqual(result.data, body);
  textTypes.forEach((type, index) => {
    const operation = present(client.operations[`text${index}`]);
    const request = operation.build({ body: 'example\ntext' });
    assert.equal(request.method, 'OPTIONS');
    assert.equal(request.bodyKind, 'text');
    assert.equal(request.body, 'example\ntext');
    const result = operation.parseResponse({
      status: 200,
      headers: { 'Content-Type': type },
      body: 'example\ntext',
    });
    assert.equal(result.kind, 'success');
    assert.equal(result.data, 'example\ntext');
  });
}

export const interoperabilityConsumer = `
import { operations } from './client.consumer.ts';
import { schema } from './standalone.value.ts';
const body = { kind: 'Cat', id: 1, amount: 0.5 } as const;
operations.remove.build({ path: { id: 'demo' }, body });
// @ts-expect-error Shared fields remain required in the generated request type.
operations.remove.build({ path: { id: 'demo' }, body: { kind: 'Cat', amount: 0.5 } });
operations.text0.build({ body: '<p>example</p>' });
// @ts-expect-error Registered numeric formats retain the numeric TypeScript type.
operations.remove.build({ path: { id: 'demo' }, body: { ...body, id: '1' } });
// @ts-expect-error Arbitrary extra declarations do not add a request index signature.
operations.remove.build({ path: { id: 'demo' }, body: { ...body, extra: true } });
// @ts-expect-error Textual media require strings.
operations.text1.build({ body: { csv: 'example' } });
const parsed = schema.parse(body);
if (parsed.kind === 'Cat') { const amount: number = parsed.amount; void amount; }
const response = operations.remove.parseResponse({ status: 200, headers: {}, body: '' });
if (response.kind === 'success') {
  const type: 'text/json' = response.contentType;
  if (response.data.kind === 'Cat') { const id: number = response.data.id; void id; }
  // @ts-expect-error Undeclared response fields are stripped and excluded from types.
  void response.data.extra;
  void type;
}
`;
