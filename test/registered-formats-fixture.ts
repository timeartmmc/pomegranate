import assert from 'node:assert/strict';
import { present } from './assertions.ts';
import type { MediaClient } from './media-fixture.ts';
import type { StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const ref = (name: string): Schema => ({
  $ref: `#/components/schemas/${name}`,
});
export const registeredFormats = {
  slug: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
  unused: { type: 'string', pattern: '^private-unused-[0-9]+$' },
} as const;

export function registeredFormatsFixture(modern = true) {
  const slug = (): Schema => ({ type: 'string', format: 'slug' });
  const schemas: Record<string, Schema> = {
    Slug: slug(),
    SlugAlias: ref('Slug'),
    Constrained: {
      ...slug(),
      pattern: '-[0-9]+$',
      minLength: 3,
      maxLength: 12,
    },
    Nullable: modern
      ? { type: ['string', 'null'], format: 'slug' }
      : { ...slug(), nullable: true },
    Enum: { ...slug(), enum: ['ready', 'draft-1'] },
    NullOnly: modern
      ? { type: ['string', 'null'], format: 'slug', enum: [null] }
      : { ...slug(), nullable: true, enum: [null] },
    Payload: {
      type: 'object',
      required: ['value', 'id', 'secret'],
      properties: {
        value: ref('SlugAlias'),
        optional: ref('Constrained'),
        id: { ...slug(), readOnly: true },
        secret: { ...slug(), writeOnly: true },
      },
    },
    Unused: { type: 'string', format: 'unused' },
  };
  const operation = (
    operationId: string,
    name: string,
    media = 'application/json',
  ) => ({
    operationId,
    requestBody: {
      required: true,
      content: { [media]: { schema: ref(name) } },
    },
    responses: {
      200: {
        description: 'Registered format',
        content: { [media]: { schema: ref(name) } },
      },
    },
  });
  return {
    openapi: modern ? '3.1.2' : '3.0.4',
    info: { title: 'Synthetic explicit format registration', version: '1' },
    components: { schemas },
    paths: {
      '/slug': { post: operation('roundTrip', 'Payload') },
      '/text': { post: operation('text', 'Constrained', 'text/plain') },
      '/nullable': { post: operation('nullable', 'Nullable') },
      '/enum': { post: operation('enum', 'Enum') },
    },
  };
}

export const registeredFormatsSelection = {
  clients: ['consumer'],
  formats: registeredFormats,
  surfaces: { consumer: ['roundTrip', 'text', 'nullable', 'enum'] },
  standalone: {
    slug: { schema: '#/components/schemas/SlugAlias', usage: 'response' },
    input: { schema: '#/components/schemas/Payload', usage: 'request' },
    output: { schema: '#/components/schemas/Payload', usage: 'response' },
    nullonly: { schema: '#/components/schemas/NullOnly', usage: 'response' },
  },
} as const;

export function verifyRegisteredFormats(
  client: MediaClient,
  slug: StandaloneModule,
  input: StandaloneModule,
  output: StandaloneModule,
): void {
  for (const value of ['ready', 'draft-1', 'a', 'x-9'])
    assert.equal(slug.schema.parse(value), value);
  for (const value of ['Bad', '9bad', 'under_score', '', null, 1])
    assert.equal(slug.schema.safeParse(value).success, false, String(value));
  const roundTrip = present(client.operations.roundTrip);
  const body = { value: 'ready', optional: 'a-1', secret: 'secret' };
  const request = roundTrip.build({ body });
  assert.equal(request.bodyKind, 'json');
  if (request.bodyKind === 'json') {
    assert.deepEqual(request.body, body);
    assert.notEqual(request.body, body);
  }
  assert.deepEqual(input.schema.parse(body), body);
  assert.throws(
    () => roundTrip.build({ body: { ...body, value: 'Bad' } }),
    client.RequestValidationError,
  );
  assert.throws(
    () => roundTrip.build({ body: { ...body, id: 'server' } }),
    client.RequestValidationError,
  );
  const responseBody = {
    value: 'ready',
    optional: 'a-1',
    id: 'server',
    secret: 'INVALID',
  };
  const expected = { value: 'ready', optional: 'a-1', id: 'server' };
  assert.deepEqual(output.schema.parse(responseBody), expected);
  const response = roundTrip.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(responseBody),
  });
  assert.equal(response.kind, 'success');
  assert.deepEqual(response.data, expected);
  assert.equal(
    roundTrip.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...responseBody, id: 'INVALID' }),
    }).kind,
    'protocol',
  );
  const text = present(client.operations.text);
  for (const value of ['a-1', 'ready-12']) {
    const request = text.build({ body: value });
    assert.equal(request.bodyKind, 'text');
    assert.equal(
      text.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
        body: value,
      }).kind,
      'success',
    );
  }
  // Each rejected value passes exactly one of the two regex assertions.
  for (const value of ['ready', '9bad-1']) {
    assert.throws(
      () => text.build({ body: value }),
      client.RequestValidationError,
    );
    assert.equal(
      text.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
        body: value,
      }).kind,
      'protocol',
    );
  }
  const nullable = present(client.operations.nullable);
  for (const value of [null, 'ready']) {
    assert.doesNotThrow(() => nullable.build({ body: value }));
    assert.equal(
      nullable.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      }).kind,
      'success',
    );
  }
  assert.throws(
    () => nullable.build({ body: 'Bad' }),
    client.RequestValidationError,
  );
  const enumeration = present(client.operations.enum);
  for (const value of ['ready', 'draft-1'])
    assert.doesNotThrow(() => enumeration.build({ body: value }));
  assert.throws(
    () => enumeration.build({ body: 'other' }),
    client.RequestValidationError,
  );
}

export const registeredFormatsConsumer = `
import { operations } from './client.consumer.ts';
import { schema } from './standalone.slug.ts';
operations.roundTrip.build({body:{value:'ready',secret:'secret',optional:'a-1'}});
operations.text.build({body:'a-1'});
operations.nullable.build({body:null});
operations.enum.build({body:'ready'});
// @ts-expect-error Registered formats preserve the base string type.
operations.text.build({body:1});
// @ts-expect-error A runtime regex does not erase enum membership.
operations.enum.build({body:'other'});
// @ts-expect-error Nullable registered strings retain their non-null type.
operations.nullable.build({body:1});
// @ts-expect-error Directional request projection excludes read-only properties.
operations.roundTrip.build({body:{value:'ready',secret:'secret',id:'server'}});
const parsed:string=schema.parse('ready'); void parsed;
const response=operations.roundTrip.parseResponse({status:200,headers:{},body:''});
if(response.kind==='success') {
  const id:string=response.data.id;
  // @ts-expect-error Response projection excludes write-only properties.
  void response.data.secret;
  void id;
}
`;
