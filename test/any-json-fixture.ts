import assert from 'node:assert/strict';
import type { CompileOptions } from '../dist/index.js';
import { entry } from './assertions.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const ref = (name: string): Schema => ({
  $ref: `#/components/schemas/${name}`,
});

export function anyJsonFixture(schema: Schema = {}) {
  const content = (name: string) => ({
    'application/json': { schema: ref(name) },
  });
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic arbitrary JSON contract', version: '1' },
    'x-pom-policy': { version: 3, surfaces: ['json'] },
    paths: {
      '/value': {
        post: {
          operationId: 'putValue',
          'x-pom': { surfaces: ['json'] },
          requestBody: { required: true, content: content('Alias') },
          responses: {
            200: { description: 'Value', content: content('Alias') },
          },
        },
        get: {
          operationId: 'getValue',
          'x-pom': { surfaces: ['json'] },
          responses: { 200: { description: 'Value', content: content('Any') } },
        },
      },
    },
    components: {
      schemas: {
        Any: schema,
        Alias: ref('Any'),
        List: { type: 'array', items: ref('Alias') },
        Bag: { type: 'object', additionalProperties: ref('Alias') },
        Nullable: { anyOf: [ref('Alias'), { type: 'null' }] },
        Record: {
          type: 'object',
          properties: {
            value: ref('Alias'),
            optional: ref('Alias'),
            server: { readOnly: true },
            secret: { writeOnly: true },
          },
          required: ['value', 'server', 'secret'],
        },
      } satisfies Record<string, Schema>,
    },
  };
}

export const anyJsonSelection: CompileOptions = {
  clients: ['json'],
  executionClients: ['json'],
  queries: { json: ['getValue'] },
  standalone: {
    input: { schema: '#/components/schemas/Alias', usage: 'request' },
    output: { schema: '#/components/schemas/Alias', usage: 'response' },
    list: { schema: '#/components/schemas/List', usage: 'response' },
    bag: { schema: '#/components/schemas/Bag', usage: 'request' },
    nullable: { schema: '#/components/schemas/Nullable', usage: 'response' },
    request: { schema: '#/components/schemas/Record', usage: 'request' },
    response: { schema: '#/components/schemas/Record', usage: 'response' },
  },
};

export const anyJsonSamples = [
  null,
  false,
  true,
  0,
  -1.5,
  '',
  'value',
  [],
  {},
  [null, { nested: [1, 'value'] }],
  { nested: { list: [false] } },
];

export function verifyAnyJson(
  client: RuntimeClient,
  input: StandaloneModule,
  output: StandaloneModule,
): void {
  const operation = entry(client.operations, 'putValue');
  for (const sample of anyJsonSamples) {
    assert.deepEqual(input.schema.parse(sample), sample);
    assert.deepEqual(output.schema.parse(sample), sample);
    assert.deepEqual(operation.build({ body: sample }).body, sample);
    const response = operation.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sample),
    });
    assert.equal(response.kind, 'success');
    if (response.kind === 'success') assert.deepEqual(response.data, sample);
  }
  for (const sample of [undefined, Infinity, { value: undefined }]) {
    assert.equal(input.schema.safeParse(sample).success, false);
    assert.throws(
      () => operation.build({ body: sample }),
      client.RequestValidationError,
    );
  }
}

export const anyJsonConsumer = `
import { operations } from './client.json.ts';
import type { Executor } from './client.json.ts';
import { createQueries } from './client.json.queries.ts';
import { schema } from './standalone.input.ts';
import type { Input, Output } from './standalone.input.ts';
import type { JsonValue } from './runtime.ts';
type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
const exactInput: Same<Input, JsonValue> = true;
const exactOutput: Same<Output, JsonValue> = true;
const value: Input = { nested: [null, true, 'text', 1, { item: false }] };
const parsed: JsonValue = schema.parse(value);
const unknownValue: unknown = value;
// @ts-expect-error An unconstrained schema accepts JSON, not unchecked unknown data.
const unknownInput: Input = unknownValue;
// @ts-expect-error Undefined is not JSON.
const missing: Input = undefined;
// @ts-expect-error Functions are not JSON.
const callable: Input = () => 1;
// @ts-expect-error Dates are not JSON data objects.
const date: Input = new Date();
operations.putValue.build({ body: value });
// @ts-expect-error Nested undefined is not JSON.
operations.putValue.build({ body: { nested: undefined } });
const execute: Executor = async (_request, execution) => {
  const result = execution.validateResponse({ status: 200, headers: {'Content-Type':'application/json'}, body: '{"item":1}' });
  if (result.kind === 'success' && result.data && typeof result.data === 'object') {
    // @ts-expect-error Scoped response data is readonly, including arbitrary JSON.
    result.data['item'] = 2;
  }
  return result;
};
const queries = createQueries({ namespace: 'json-types', execute });
queries.getValue.body().options({ context: {}, input: undefined });
void [exactInput, exactOutput, parsed, unknownInput, missing, callable, date];
`;
