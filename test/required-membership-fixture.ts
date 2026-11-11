import assert from 'node:assert/strict';
import { entry, record } from './assertions.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

export function requiredMembershipFixture() {
  const children = { type: 'array', items: ref('Versioned') };
  const fields = { children, text: { type: 'string' } };
  const wide: Schema = {
    type: 'object',
    properties: {
      children: { type: 'array', items: { type: 'string' } },
      ...Object.fromEntries(
        Array.from({ length: 129 }, (_, index) => [
          `optional${index}`,
          { type: 'integer' },
        ]),
      ),
      revision: { type: 'integer' },
    },
    required: ['children', 'revision'],
  };
  const content = { 'application/json': { schema: ref('Versioned') } };
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic required membership', version: '1' },
    components: {
      schemas: {
        V2: {
          type: 'object',
          properties: { ...fields, revision: { type: 'integer' } },
          required: ['children', 'revision'],
        },
        V1: { type: 'object', properties: fields, required: ['children'] },
        Versioned: { anyOf: [ref('V2'), ref('V1')] },
        Wide: wide,
      },
    },
    paths: {
      '/versioned': {
        post: {
          operationId: 'save',
          requestBody: { required: true, content },
          responses: { 200: { description: 'Synthetic value', content } },
        },
      },
      '/ordered': {
        get: {
          operationId: 'ordered',
          parameters: ['2', '1'].map((name) => ({
            in: 'query',
            name,
            required: true,
            schema: { type: 'string' },
          })),
          responses: { 204: { description: 'Synthetic empty response' } },
        },
      },
    },
  };
}

export const requiredMembershipSelection = {
  clients: ['consumer'],
  surfaces: { consumer: ['save', 'ordered'] },
  standalone: {
    request: { schema: '#/components/schemas/Versioned', usage: 'request' },
    response: { schema: '#/components/schemas/Versioned', usage: 'response' },
    'wide-request': { schema: '#/components/schemas/Wide', usage: 'request' },
    'wide-response': { schema: '#/components/schemas/Wide', usage: 'response' },
  },
} as const;

export const requiredMembershipConsumer = `
import {operations} from './client.consumer.ts';
import {schema as request} from './standalone.request.ts';
import {schema as response} from './standalone.response.ts';
const body = request.parse({children:[]});
operations.save.build({body});
response.parse(body);
operations.ordered.build({query:{'2':'first','1':'second'}});
`;

export function verifyRequiredMembership(
  client: RuntimeClient,
  roots: Readonly<Record<string, StandaloneModule>>,
): void {
  assert.throws(
    () =>
      entry(client.operations, 'ordered').build({
        query: { '2': false, nmae: 'hint' },
      }),
    (error) => {
      assert.ok(error instanceof client.RequestValidationError);
      assert.equal(error.issues.length, 3);
      assert.ok(
        error.issues.some((issue) => issue.path.join('.') === 'query.2'),
      );
      assert.ok(
        error.issues.some((issue) => issue.path.join('.') === 'query.1'),
      );
      assert.ok(error.issues.some((issue) => issue.message.includes('nmae')));
      return true;
    },
  );
  const operation = entry(client.operations, 'save');
  let expected: object = { children: [], text: 'leaf' };
  for (let level = 0; level < 14; level++) expected = { children: [expected] };
  for (const direction of ['request', 'response']) {
    let reads = 0;
    let input: object = {
      children: [],
      get text() {
        reads++;
        return 'leaf';
      },
    };
    for (let level = 0; level < 14; level++) input = { children: [input] };
    const output = entry(roots, direction).schema.parse(input);
    assert.equal(reads, 1, 'missing V2 keys must prevent child retries');
    assert.deepEqual(output, expected);
    assert.notEqual(record(output).children, record(input).children);
    assert.deepEqual(entry(roots, direction).schema.parse({ children: [] }), {
      children: [],
    });
    if (direction === 'request') {
      reads = 0;
      assert.deepEqual(operation.build({ body: input }).body, expected);
      assert.equal(reads, 1);
    }
  }
  const response = operation.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(expected),
  });
  assert.equal(response.kind, 'success');
  if (response.kind === 'success') assert.deepEqual(response.data, expected);

  // An eligible earlier branch retains its projection and constraints.
  for (const direction of ['request', 'response']) {
    const schema = entry(roots, direction).schema;
    const value = { children: [], revision: 2 };
    assert.deepEqual(schema.parse(value), value);
    const invalidRevision = { children: [], revision: null };
    if (direction === 'request')
      assert.equal(schema.safeParse(invalidRevision).success, false);
    else assert.deepEqual(schema.parse(invalidRevision), { children: [] });
  }
}
