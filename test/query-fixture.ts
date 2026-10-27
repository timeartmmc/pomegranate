export const querySelection = {
  clients: ['consumer', 'staff'],
  transportHeaders: ['X-Language'],
  queries: {
    consumer: ['readItem', 'readOutcome', 'readMap', 'health'],
    staff: ['readItem'],
  },
} as const;

export function queryFixture() {
  const policy = (surfaces: string[]) => ({
    auth: 'session',
    retry: 'never',
    timeout: 'interactive',
    surfaces,
  });
  const response = (name: string) => ({
    description: 'Synthetic response',
    content: {
      'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
    },
  });
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic query contracts', version: '1' },
    'x-pom-policy': {
      version: 2,
      auth: { public: { transport: 'none' }, session: { transport: 'bearer' } },
      retry: ['never'],
      timeout: ['interactive'],
      surfaces: ['consumer', 'staff'],
    },
    security: [{ Session: [] }],
    components: {
      securitySchemes: { Session: { type: 'http', scheme: 'bearer' } },
      schemas: {
        JsonMap: { type: 'object', additionalProperties: true },
        TextMap: { type: 'object', additionalProperties: { type: 'string' } },
        Item: {
          type: 'object',
          required: ['id', 'label'],
          properties: { id: { type: 'string' }, label: { type: 'string' } },
        },
        Ready: {
          type: 'object',
          required: ['state', 'value'],
          properties: {
            state: { type: 'string', const: 'ready' },
            value: { type: 'integer' },
          },
        },
        Pending: {
          type: 'object',
          required: ['state', 'reference'],
          properties: {
            state: { type: 'string', const: 'pending' },
            reference: { type: 'string' },
          },
        },
        Problem: {
          type: 'object',
          required: ['detail'],
          properties: { detail: { type: 'string' } },
        },
      },
    },
    paths: {
      '/map': {
        get: {
          operationId: 'readMap',
          'x-pom': policy(['consumer']),
          responses: { 200: response('JsonMap'), 202: response('TextMap') },
        },
      },
      '/items/{id}': {
        get: {
          operationId: 'readItem',
          'x-pom': policy(['consumer', 'staff']),
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
            {
              name: 'page',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 10 },
            },
            {
              name: 'filter',
              in: 'query',
              schema: { type: ['string', 'null'] },
            },
            {
              name: 'tags',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
            },
            { name: 'active', in: 'query', schema: { type: 'boolean' } },
            { name: 'count', in: 'query', schema: { type: 'number' } },
            {
              name: 'X-View',
              in: 'header',
              schema: { type: ['string', 'null'] },
            },
            {
              name: 'X-Language',
              in: 'header',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: response('Item'),
            404: response('Problem'),
            410: { description: 'Gone without a response body' },
          },
        },
      },
      '/outcome': {
        get: {
          operationId: 'readOutcome',
          'x-pom': policy(['consumer']),
          responses: {
            200: response('Ready'),
            202: {
              ...response('Pending'),
              headers: {
                'X-Request-ID': { required: true, schema: { type: 'string' } },
              },
            },
            409: response('Problem'),
          },
        },
      },
      '/health': {
        head: {
          operationId: 'health',
          security: [],
          'x-pom': { ...policy(['consumer']), auth: 'public' },
          responses: { 204: { description: 'Healthy' } },
        },
      },
    },
  };
}
