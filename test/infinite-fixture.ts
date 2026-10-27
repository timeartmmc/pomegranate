import { queryFixture, querySelection } from './query-fixture.ts';

export const infiniteSelection = {
  ...querySelection,
  queries: {
    ...querySelection.queries,
    consumer: [...querySelection.queries.consumer, 'listItems'],
  },
  infiniteQueries: {
    consumer: {
      listItems: {
        cursor: 'after',
        nextCursor: 'continuation',
        items: 'results',
      },
    },
  },
} as const;

export function infiniteFixture() {
  const document = queryFixture();
  const content = {
    'application/json': { schema: { $ref: '#/components/schemas/Page' } },
  };
  return {
    ...document,
    components: {
      ...document.components,
      schemas: {
        ...document.components.schemas,
        Page: {
          type: 'object',
          required: ['results', 'continuation'],
          properties: {
            results: {
              type: 'array',
              items: { $ref: '#/components/schemas/PageItem' },
            },
            continuation: { type: ['string', 'null'] },
          },
        },
        PageItem: {
          type: 'object',
          required: ['id', 'label'],
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            attributes: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
    paths: {
      ...document.paths,
      '/collections/{collection}/items': {
        get: {
          operationId: 'listItems',
          'x-pom': {
            auth: 'session',
            retry: 'never',
            timeout: 'interactive',
            surfaces: ['consumer'],
          },
          parameters: [
            {
              name: 'collection',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
            {
              name: 'after',
              in: 'query',
              schema: { type: 'string', maxLength: 64 },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100 },
            },
            {
              name: 'tags',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
            },
            { name: 'X-View', in: 'header', schema: { type: 'string' } },
            {
              name: 'X-Language',
              in: 'header',
              required: true,
              schema: { type: 'string', enum: ['en', 'fr'] },
            },
          ],
          responses: {
            200: { description: 'A page', content },
            206: { description: 'Another declared success', content },
            404: {
              description: 'Missing',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Problem' },
                },
              },
            },
            410: { description: 'Gone without a response body' },
          },
        },
      },
    },
  };
}
