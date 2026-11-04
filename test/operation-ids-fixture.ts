export const operationIds = [
  'repos/get',
  'get-stations',
  'repos_get',
  'get_stations',
  'repos_x2f_get',
  'café',
  'cafe\u0301',
  '😀',
  '"quote"`\\\n',
  'toString',
  '$list',
  '9list',
  '\ud800',
  'a.1',
  'a\u02e1',
] as const;

export const operationIdsSelection = {
  clients: ['consumer'],
  surfaces: { consumer: operationIds },
  executionClients: ['consumer'],
  queries: { consumer: operationIds },
  infiniteQueries: {
    consumer: {
      'repos/get': { cursor: 'after', nextCursor: 'next', items: 'items' },
      'get-stations': {
        offset: 'start',
        responseOffset: 'start',
        responseLimit: 'size',
        total: 'count',
        items: 'items',
      },
    },
  },
} as const;

export function operationIdsFixture() {
  return {
    openapi: '3.1.1',
    info: { title: 'Synthetic operation strings', version: '1' },
    paths: Object.fromEntries(
      operationIds.map((id, index) => [
        `/items/${index}`,
        {
          get: {
            operationId: id,
            parameters: [
              { name: 'after', in: 'query', schema: { type: 'string' } },
              {
                name: 'start',
                in: 'query',
                schema: { type: 'integer', minimum: 0 },
              },
            ],
            responses: {
              200: {
                description: 'Page',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: [
                        'tag',
                        'items',
                        'next',
                        'start',
                        'size',
                        'count',
                      ],
                      properties: {
                        tag: { type: 'string', const: id },
                        items: { type: 'array', items: { type: 'string' } },
                        next: { type: ['string', 'null'] },
                        start: { type: 'integer' },
                        size: { type: 'integer' },
                        count: { type: 'integer' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ]),
    ),
  };
}

export function operationIdsTypeConsumer() {
  return `
    import {createClient, operations} from './operation-ids-generated/client.consumer.ts';
    import {createQueries, createInfiniteQueries} from './operation-ids-generated/client.consumer.queries.ts';
    import type {Executor} from './operation-ids-generated/client.consumer.ts';
    export function createApi(execute: Executor) {
      return createClient({namespace:'ids', execute});
    }
    export async function read(execute: Executor): Promise<'repos/get'> {
      return (await createApi(execute)['repos/get'].call({context:{}})).data.tag;
    }
    export function key(execute: Executor) { return createQueries({namespace:'ids',execute})['get-stations'].key({context:{}}); }
    export function pages(execute: Executor) { return createInfiniteQueries({namespace:'ids',execute})['repos/get'].options({context:{}}); }
    const request = operations['repos/get'].build();
    const response = request.parseResponse({status:200,headers:{},body:''});
    if(response.kind === 'success') {
      const exact:'repos/get'=response.data.tag; void exact;
      // @ts-expect-error Punctuation and underscore IDs retain distinct response types.
      const wrong:'repos_get'=response.data.tag; void wrong;
    }
  `;
}
