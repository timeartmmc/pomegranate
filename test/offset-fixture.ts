export const offsetSelection = {
  clients: ['consumer', 'staff'],
  transportHeaders: ['X-Language'],
  queries: { consumer: ['listRecords'] },
  infiniteQueries: {
    consumer: {
      listRecords: {
        offset: 'start',
        responseOffset: 'start',
        responseLimit: 'size',
        total: 'count',
        items: 'entries',
      },
    },
  },
} as const;

export function offsetFixture() {
  const properties = {
    entries: { type: 'array', items: { $ref: '#/components/schemas/Record' } },
    start: { type: 'integer' },
    size: { type: 'integer' },
    count: { type: 'integer' },
    next: { type: ['string', 'null'] },
  };
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic offset pagination', version: '1' },
    'x-pom-policy': {
      version: 3,
      auth: { public: { transport: 'none' } },
      fields: {
        retry: { type: 'string', enum: ['never'] },
        timeout: { type: 'string', enum: ['interactive'] },
      },
      required: ['auth', 'retry', 'timeout'],
      surfaces: ['consumer', 'staff'],
    },
    components: {
      schemas: {
        Record: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            attributes: { type: 'object', additionalProperties: true },
          },
        },
        Page: { type: 'object', required: Object.keys(properties), properties },
        PartialPage: {
          type: 'object',
          required: [...Object.keys(properties), 'segment'],
          properties: {
            ...properties,
            segment: { type: 'string', const: 'partial' },
          },
        },
      },
    },
    paths: {
      '/records/{category}': {
        get: {
          operationId: 'listRecords',
          'x-pom': {
            auth: 'public',
            retry: 'never',
            timeout: 'interactive',
            surfaces: ['consumer', 'staff'],
          },
          parameters: [
            {
              name: 'category',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
            {
              name: 'start',
              in: 'query',
              schema: { type: 'integer', minimum: 0, default: 0 },
            },
            {
              name: 'size',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 2 },
            },
            {
              name: 'labels',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
            },
            {
              name: 'filter',
              in: 'query',
              schema: { type: ['string', 'null'] },
            },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
            {
              name: 'X-Language',
              in: 'header',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            200: {
              description: 'A page',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Page' },
                },
              },
            },
            206: {
              description: 'An alternate success',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PartialPage' },
                },
              },
            },
            404: {
              description: 'Missing',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['detail'],
                    properties: { detail: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}
