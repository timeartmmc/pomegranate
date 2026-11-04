import { infiniteFixture, infiniteSelection } from './infinite-fixture.ts';
import { offsetFixture, offsetSelection } from './offset-fixture.ts';

export const executionSelection = {
  ...infiniteSelection,
  executionClients: ['consumer', 'staff'],
  queries: {
    ...infiniteSelection.queries,
    consumer: [...infiniteSelection.queries.consumer, 'listRecords'],
  },
  infiniteQueries: {
    consumer: {
      ...infiniteSelection.infiniteQueries.consumer,
      ...offsetSelection.infiniteQueries.consumer,
    },
  },
} as const;

export function executionFixture() {
  const base = infiniteFixture();
  const offset = offsetFixture();
  const records = offset.paths['/records/{category}'].get;
  const json = (schema: unknown) => ({
    content: { 'application/json': { schema } },
  });
  const reference = (name: string) =>
    json({ $ref: `#/components/schemas/${name}` });
  const policy = {
    auth: 'session',
    retry: 'never',
    timeout: 'interactive',
    surfaces: ['consumer'],
  };
  const command = (operationId: string) => ({
    operationId,
    'x-pom': policy,
    parameters: [
      {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string', minLength: 1 },
      },
    ],
    requestBody: { required: true, ...reference('WriteInput') },
    responses: {
      201: {
        description: 'Created',
        ...reference('Item'),
        headers: {
          'X-Request-ID': { required: true, schema: { type: 'string' } },
        },
      },
      202: { description: 'Pending', ...reference('Pending') },
      403: { description: 'Denied without a body' },
      409: { description: 'Conflict', ...reference('Problem') },
    },
  });
  const optionalCommand = (operationId: string) => ({
    operationId,
    'x-pom': policy,
    requestBody: { required: false, ...reference('WriteInput') },
    responses: { 204: { description: 'Accepted' } },
  });
  return {
    ...base,
    components: {
      ...base.components,
      schemas: {
        ...base.components.schemas,
        Label: { type: 'string', minLength: 2, maxLength: 32 },
        WriteInput: {
          type: 'object',
          required: ['label', 'values'],
          properties: {
            label: { $ref: '#/components/schemas/Label', minLength: 3 },
            values: { type: 'array', items: { type: 'string' } },
            attributes: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
        },
        Record: offset.components.schemas.Record,
        OffsetPage: offset.components.schemas.Page,
        PartialOffsetPage: offset.components.schemas.PartialPage,
      },
    },
    paths: {
      ...base.paths,
      '/collections/{collection}/items': {
        get: {
          ...base.paths['/collections/{collection}/items'].get,
          responses: {
            ...base.paths['/collections/{collection}/items'].get.responses,
            206: {
              description: 'Alternate page item type',
              ...json({
                type: 'object',
                required: ['results', 'continuation'],
                properties: {
                  results: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['code'],
                      properties: { code: { type: 'integer' } },
                    },
                  },
                  continuation: { type: ['string', 'null'] },
                },
              }),
            },
          },
        },
      },
      '/records/{category}': {
        get: {
          ...records,
          security: [],
          responses: {
            ...records.responses,
            200: { description: 'A page', ...reference('OffsetPage') },
            206: {
              description: 'Partial page',
              ...reference('PartialOffsetPage'),
            },
          },
        },
      },
      '/commands': {
        post: command('createWidget'),
        put: command('replaceWidget'),
        patch: command('write_options'),
        options: {
          operationId: 'commandOptions',
          'x-pom': policy,
          responses: { 204: { description: 'Supported' } },
        },
      },
      '/commands/optional': {
        post: optionalCommand('maybeCreate'),
        put: {
          ...optionalCommand('maybeCreateNullable'),
          requestBody: json({
            anyOf: [
              { $ref: '#/components/schemas/WriteInput' },
              { type: 'null' },
            ],
          }),
        },
      },
      '/commands/optional/{id}': {
        patch: {
          ...optionalCommand('maybeUpdate'),
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
        },
      },
      '/commands/{id}': {
        delete: {
          operationId: 'removeWidget',
          'x-pom': policy,
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', minLength: 1 },
            },
          ],
          responses: {
            204: { description: 'Removed' },
            404: { description: 'Missing', ...reference('Problem') },
          },
        },
      },
    },
  };
}
