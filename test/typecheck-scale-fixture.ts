export function typecheckScaleFixture(count: number) {
  const ids = Array.from(
    { length: count },
    (_, index) => `write${String(index).padStart(5, '0')}`,
  );
  const name = (index: number) => `Model${String(index).padStart(5, '0')}`;
  return {
    document: {
      openapi: '3.1.2',
      info: { title: 'Synthetic distinct parser graphs', version: '1' },
      components: {
        schemas: Object.fromEntries(
          ids.map((_, index) => [
            name(index),
            {
              type: 'object',
              required: ['kind', 'score', 'tags', `field${index % 32}`],
              properties: {
                kind: { type: 'string', enum: [`kind${index}`] },
                [`field${index % 32}`]: {
                  type: 'string',
                  minLength: (index % 32) + 1,
                },
                score: { type: 'integer', minimum: 0 },
                tags: { type: 'array', items: { type: 'string' } },
              },
            },
          ]),
        ),
      },
      paths: Object.fromEntries(
        ids.map((operationId, index) => {
          const content = {
            'application/json': {
              schema: { $ref: `#/components/schemas/${name(index)}` },
            },
          };
          return [
            `/items/${index}`,
            {
              post: {
                operationId,
                requestBody: { required: true, content },
                responses: {
                  200: { description: 'Synthetic success', content },
                },
              },
            },
          ];
        }),
      ),
    },
    options: {
      clients: ['consumer'],
      surfaces: { consumer: ids },
      executionClients: ['consumer'],
    },
  };
}

export const scaleCompilerOptions = {
  target: 'ES2022',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  types: [],
  noEmit: true,
  allowImportingTsExtensions: true,
  skipLibCheck: false,
} as const;
