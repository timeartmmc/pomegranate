import assert from 'node:assert/strict';
import { present, record } from './assertions.ts';
import type { RuntimeClient } from './runtime-types.ts';

export const extensionSelection = {
  clients: ['consumer', 'staff'],
  standalone: {
    tagged: { schema: '#/components/schemas/Tagged', usage: 'response' },
  },
} as const;

const payload = () => ({
  'x-note': { 'x-note': 'payload', type: 'not a schema' },
});
const docs = () => ({ url: './synthetic-docs' });
const schemaRef = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const examples = () => ({
  'x-note': { value: payload() },
  alias: { $ref: '#/components/examples/x-note', description: 'Alias' },
});

// The same name is both an ignored keyword and legal data at many boundaries.
// Keep those declarations explicit so tests cannot share the filter's grammar.
export function extensionFixture() {
  const responsePayload = {
    type: 'object',
    required: ['x-note'],
    properties: {
      'x-note': { type: 'string', enum: ['kept'] },
      bag: { type: 'object', additionalProperties: true },
    },
    example: payload(),
    examples: [payload(), { type: 'unknown', 'x-note': ['kept'] }],
    externalDocs: docs(),
  };
  return {
    openapi: '3.1.1',
    info: {
      title: 'Synthetic extension boundaries',
      version: '1',
      contact: { name: 'Synthetic', email: 'synthetic@example.invalid' },
      license: { name: 'Synthetic license', identifier: 'MIT' },
    },
    externalDocs: docs(),
    tags: [{ name: 'synthetic', externalDocs: docs() }],
    servers: [
      {
        url: 'https://{x-note}.example.invalid',
        variables: { 'x-note': { default: 'demo', enum: ['demo'] } },
      },
    ],
    'x-pom-policy': {
      version: 3,
      surfaces: ['consumer', 'staff'],
      auth: { session: { transport: 'bearer' }, public: { transport: 'none' } },
      fields: { 'x-note': { type: 'string', enum: ['kept'] } },
    },
    security: [{ 'x-note': [] }],
    components: {
      schemas: {
        Identifier: { type: 'string', minLength: 1 },
        'x-note': responsePayload,
        RequestPayload: {
          ...structuredClone(responsePayload),
          default: payload(),
        },
        Nullable: { anyOf: [schemaRef('x-note'), { type: 'null' }] },
        TaggedNote: {
          type: 'object',
          required: ['kind'],
          properties: { kind: { type: 'string', const: 'x-note' } },
        },
        TaggedOther: {
          type: 'object',
          required: ['kind'],
          properties: { kind: { type: 'string', const: 'other' } },
        },
        Tagged: {
          oneOf: [schemaRef('TaggedNote'), schemaRef('TaggedOther')],
          discriminator: {
            propertyName: 'kind',
            mapping: {
              'x-note': '#/components/schemas/TaggedNote',
              other: '#/components/schemas/TaggedOther',
            },
          },
        },
        Array: { type: 'array', items: schemaRef('x-note') },
        Map: { type: 'object', additionalProperties: schemaRef('x-note') },
      },
      examples: examples(),
      securitySchemes: {
        'x-note': { type: 'http', scheme: 'bearer', description: 'Token' },
        alias: {
          $ref: '#/components/securitySchemes/x-note',
          summary: 'Alias',
        },
      },
      parameters: {
        Id: {
          name: 'id',
          in: 'path',
          required: true,
          schema: schemaRef('Identifier'),
          examples: examples(),
        },
        IdAlias: { $ref: '#/components/parameters/Id', description: 'Path' },
        'x-note': {
          name: 'x-note',
          in: 'header',
          schema: { type: 'string' },
          examples: examples(),
        },
      },
    },
    paths: {
      '/echo/{id}': {
        parameters: [
          { $ref: '#/components/parameters/IdAlias' },
          { $ref: '#/components/parameters/x-note' },
        ],
        post: {
          operationId: 'echo',
          'x-pom': {
            auth: 'session',
            surfaces: ['consumer'],
            'x-note': 'kept',
          },
          externalDocs: docs(),
          parameters: [
            {
              name: 'x-note',
              in: 'query',
              schema: { type: 'string', const: 'query' },
              examples: examples(),
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: schemaRef('RequestPayload'),
                examples: examples(),
              },
            },
          },
          responses: {
            200: {
              description: 'Echo',
              content: {
                'application/json': {
                  schema: schemaRef('x-note'),
                  examples: examples(),
                },
              },
              headers: {
                'x-note': {
                  required: true,
                  schema: { type: 'string', const: 'response' },
                  examples: examples(),
                },
              },
            },
          },
        },
      },
      '/staff': {
        get: {
          operationId: 'staffRead',
          security: [],
          'x-pom': { auth: 'public', surfaces: ['staff'] },
          responses: { 204: { description: 'Staff' } },
        },
      },
    },
  };
}

export function extensionKeywordTargets(
  document: ReturnType<typeof extensionFixture>,
) {
  const body = document.paths['/echo/{id}'].post;
  const media = body.requestBody.content['application/json'];
  const response = body.responses[200];
  const schema = document.components.schemas['x-note'];
  const targets: [string, object][] = [
    ['OpenAPI', document],
    ['info', document.info],
    ['info.contact', document.info.contact],
    ['info.license', document.info.license],
    ['OpenAPI.externalDocs', document.externalDocs],
    ['tags[0]', document.tags[0]!],
    ['tags[0].externalDocs', document.tags[0]!.externalDocs],
    ['servers[0]', document.servers[0]!],
    ['servers[0].variables.x-note', document.servers[0]!.variables['x-note']],
    ['components', document.components],
    ['components.schemas.x-note', schema],
    [
      'components.schemas.x-note.properties.x-note',
      schema.properties['x-note'],
    ],
    ['components.schemas.x-note.externalDocs', schema.externalDocs],
    ['components.schemas.Nullable', document.components.schemas.Nullable],
    [
      'components.schemas.Nullable.anyOf[0]',
      document.components.schemas.Nullable.anyOf[0]!,
    ],
    [
      'components.schemas.Nullable.anyOf[1]',
      document.components.schemas.Nullable.anyOf[1]!,
    ],
    ['components.schemas.Tagged', document.components.schemas.Tagged],
    [
      'components.schemas.Tagged.oneOf[0]',
      document.components.schemas.Tagged.oneOf[0]!,
    ],
    [
      'components.schemas.Tagged.discriminator',
      document.components.schemas.Tagged.discriminator,
    ],
    ['components.schemas.Array.items', document.components.schemas.Array.items],
    [
      'components.schemas.Map.additionalProperties',
      document.components.schemas.Map.additionalProperties,
    ],
    ['components.parameters.Id', document.components.parameters.Id],
    [
      'components.parameters.Id.schema',
      document.components.parameters.Id.schema,
    ],
    ['components.parameters.IdAlias', document.components.parameters.IdAlias],
    ['components.parameters.x-note', document.components.parameters['x-note']],
    ['components.examples.x-note', document.components.examples['x-note']],
    ['components.examples.alias', document.components.examples.alias],
    [
      'components.securitySchemes.x-note',
      document.components.securitySchemes['x-note'],
    ],
    [
      'components.securitySchemes.alias',
      document.components.securitySchemes.alias,
    ],
    ['paths', document.paths],
    ['paths./echo/{id}', document.paths['/echo/{id}']],
    [
      'paths./echo/{id}.parameters[0]',
      document.paths['/echo/{id}'].parameters[0]!,
    ],
    ['paths./echo/{id}.post', body],
    ['paths./echo/{id}.post.externalDocs', body.externalDocs],
    ['paths./echo/{id}.post.parameters[0]', body.parameters[0]!],
    ['paths./echo/{id}.post.parameters[0].schema', body.parameters[0]!.schema],
    ['paths./echo/{id}.post.requestBody', body.requestBody],
    ['paths./echo/{id}.post.requestBody.content', body.requestBody.content],
    ['paths./echo/{id}.post.requestBody.content.application/json', media],
    [
      'paths./echo/{id}.post.requestBody.content.application/json.schema',
      media.schema,
    ],
    [
      'paths./echo/{id}.post.requestBody.content.application/json.examples.x-note',
      media.examples['x-note'],
    ],
    ['paths./echo/{id}.post.responses', body.responses],
    ['paths./echo/{id}.post.responses.200', response],
    ['paths./echo/{id}.post.responses.200.content', response.content],
    [
      'paths./echo/{id}.post.responses.200.content.application/json',
      response.content['application/json'],
    ],
    [
      'paths./echo/{id}.post.responses.200.headers.x-note',
      response.headers['x-note'],
    ],
    [
      'paths./echo/{id}.post.responses.200.headers.x-note.schema',
      response.headers['x-note'].schema,
    ],
  ];
  return targets.map(([location, value]) => ({
    location,
    value: record(value),
  }));
}

export function verifyExtensionData(client: RuntimeClient): void {
  const echo = present(client.operations.echo);
  const input = {
    path: { id: 'a/b' },
    query: { 'x-note': 'query' },
    headers: { 'x-note': 'request' },
    body: { 'x-note': 'kept', bag: { 'x-note': { 'x-note': 'payload' } } },
  };
  const request = echo.build(input);
  assert.equal(request.url, '/echo/a%2Fb?x-note=query');
  assert.equal(request.headers['x-note'], 'request');
  assert.deepEqual(request.body, input.body);
  assert.equal(request.policy['x-note'], 'kept');
  assert.deepEqual(
    { ...request.security },
    { transport: 'bearer', scheme: 'x-note' },
  );
  const result = request.parseResponse({
    status: 200,
    headers: { 'content-type': 'application/json', 'x-note': 'response' },
    body: JSON.stringify(input.body),
  });
  assert.equal(result.kind, 'success');
  assert.deepEqual(result.data, input.body);
  assert.equal(result.validatedHeaders['x-note'], 'response');
  assert.throws(
    () => echo.build({ ...input, body: { bag: {} } }),
    client.RequestValidationError,
  );
}
