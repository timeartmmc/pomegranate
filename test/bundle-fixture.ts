// Unselected operations deliberately exercise nested schema, regex, header and
// aggregate initializers. A sparse query bundle must remove their construction,
// while a full client must keep every contract and its validation behavior.
export function addUnusedOperations<
  T extends { components: { schemas: object }; paths: object },
>(document: T, count: number): T {
  for (let index = 0; index < count; index++) {
    const name = `Unused${index}`;
    Object.assign(document.components.schemas, {
      [`${name}Text`]: {
        type: 'string',
        minLength: 1,
        maxLength: 64,
        pattern: `^unused-response-${index}$`,
      },
      [name]: {
        type: 'object',
        required: ['tag', 'attributes'],
        properties: {
          tag: { $ref: `#/components/schemas/${name}Text` },
          attributes: { type: 'object', additionalProperties: true },
          entries: {
            type: 'array',
            maxItems: 2,
            items: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
          },
        },
      },
      [`${name}Alias`]: { $ref: `#/components/schemas/${name}` },
    });
    Object.assign(document.paths, {
      [`/unused/${index}`]: {
        get: {
          operationId: `unused${index}`,
          'x-pom': {
            auth: 'session',
            retry: 'never',
            timeout: 'interactive',
            surfaces: ['consumer'],
          },
          parameters: [
            {
              name: 'X-Trace',
              in: 'header',
              schema: { $ref: `#/components/schemas/${name}Text` },
            },
          ],
          responses: {
            200: {
              description: 'An unselected operation',
              content: {
                'application/json': {
                  schema: { $ref: `#/components/schemas/${name}Alias` },
                },
              },
            },
          },
        },
      },
    });
  }
  return document;
}
