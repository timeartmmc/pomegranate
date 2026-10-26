import assert from 'node:assert/strict';
import { entry, runtimeInput, record } from './assertions.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

type Operations = typeof import('./.generated/deep/client.deep.ts').operations;
type ValidationError =
  typeof import('./.generated/deep/client.deep.ts').RequestValidationError;

const nested = (depth: number, leaf: unknown) => {
  let value: { value: unknown } = { value: leaf };
  for (let index = 0; index < depth; index++) value = { value };
  return value;
};

export function deepFixture() {
  const schemas: Record<string, Schema> = {
    Layer0: {
      type: 'object',
      properties: { value: { type: 'string', const: 'leaf' } },
    },
  };
  for (let index = 1; index <= 64; index++)
    schemas[`Layer${index}`] = {
      type: 'object',
      properties: { value: ref(`Layer${index - 1}`) },
    };
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic deep components', version: '1' },
    'x-pom-policy': {
      version: 2,
      auth: { public: { transport: 'none' } },
      retry: ['never'],
      timeout: ['interactive'],
      surfaces: ['deep'],
    },
    components: { schemas },
    paths: Object.fromEntries(
      [32, 64].map((depth) => [
        `/depth/${depth}`,
        {
          post: {
            operationId: `depth${depth}`,
            'x-pom': {
              auth: 'public',
              retry: 'never',
              timeout: 'interactive',
              surfaces: ['deep'],
            },
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref(`Layer${depth}`) } },
            },
            responses: {
              200: {
                description: 'ok',
                content: {
                  'application/json': { schema: ref(`Layer${depth}`) },
                },
              },
            },
          },
        },
      ]),
    ),
  };
}

export function deepTypeConsumer() {
  return (
    `import { operations } from './deep-generated/client.deep.ts';\n` +
    [32, 64]
      .map((depth) => {
        const good = JSON.stringify(nested(depth, 'leaf'));
        const bad = JSON.stringify(nested(depth, 123));
        const path = '?.value'.repeat(depth + 1);
        return `
      const prepared${depth} = operations.depth${depth}.build({body:${good}});
      const leaf${depth}: 'leaf' | undefined = prepared${depth}.body${path};
      void leaf${depth};
      // @ts-expect-error The deepest optional literal must remain checked.
      operations.depth${depth}.build({body:${bad}});
      const result${depth} = prepared${depth}.parseResponse({status:200,headers:{},body:''});
      if (result${depth}.kind === 'success') {
        const output: 'leaf' | undefined = result${depth}.data${path};
        void output;
      }
    `;
      })
      .join('\n')
  );
}

export function verifyDeep(
  operations: Operations,
  RequestValidationError: ValidationError,
) {
  for (const depth of [32, 64]) {
    const operation = entry(operations, `depth${depth}`);
    const input = nested(depth, 'leaf');
    const built = runtimeInput(operation.build, { body: input });
    assert.deepEqual(built.body, input);
    let original: unknown = input;
    let copy: unknown = built.body;
    for (let index = 0; index <= depth; index++) {
      assert.notEqual(copy, original);
      original = record(original).value;
      copy = record(copy).value;
    }
    assert.throws(
      () => runtimeInput(operation.build, { body: nested(depth, 123) }),
      RequestValidationError,
    );
    const observe = (value: unknown) =>
      operation.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
    assert.equal(observe(input).kind, 'success');
    assert.equal(observe(nested(depth, 123)).kind, 'protocol');
    assert.deepEqual(operation.build({ body: {} }).body, {});
    assert.deepEqual(operation.build({ body: { value: undefined } }).body, {
      value: undefined,
    });
  }
}
