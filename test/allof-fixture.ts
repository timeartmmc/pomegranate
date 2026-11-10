import assert from 'node:assert/strict';
import { present, record } from './assertions.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';

export const allOfSelection = {
  clients: ['consumer'],
  surfaces: { consumer: ['compose'] },
  standalone: {
    input: { schema: '#/components/schemas/Alias', usage: 'request' },
    output: { schema: '#/components/schemas/Alias', usage: 'response' },
    closed: { schema: '#/components/schemas/Closed', usage: 'request' },
    scalar: { schema: '#/components/schemas/Scalar', usage: 'request' },
  },
} as const;

export function allOfFixture() {
  return {
    openapi: '3.1.1',
    info: { title: 'Synthetic object composition', version: '1' },
    components: {
      schemas: {
        Identifier: { type: 'string', pattern: '^W-' },
        Base: {
          type: 'object',
          required: ['id', 'count', 'details', 'serverOnly', 'clientOnly'],
          properties: {
            id: { $ref: '#/components/schemas/Identifier' },
            count: { type: 'integer', minimum: 0, multipleOf: 2 },
            details: {
              type: 'object',
              required: ['label'],
              properties: { label: { type: 'string' } },
            },
            serverOnly: { type: 'string', readOnly: true },
            clientOnly: { type: 'string', writeOnly: true },
          },
        },
        Composed: {
          required: ['tag'],
          properties: { tag: { type: 'string', enum: ['widget'] } },
          allOf: [
            { $ref: '#/components/schemas/Base' },
            {
              type: 'object',
              properties: {
                id: { type: 'string', pattern: '^[A-Z0-9-]+$' },
                count: { type: 'number', maximum: 24, multipleOf: 3 },
                details: {
                  type: 'object',
                  required: ['active'],
                  properties: { active: { type: 'boolean' } },
                },
              },
            },
          ],
        },
        Alias: { allOf: [{ $ref: '#/components/schemas/Composed' }] },
        Scalar: {
          allOf: [
            { type: 'string', pattern: '^W-' },
            { type: 'string', pattern: '^[A-Z0-9-]+$', minLength: 4 },
            { type: 'string', enum: ['W-10', 'W-20'] },
            { type: 'string', enum: ['W-20', 'W-30'] },
          ],
        },
        Closed: {
          allOf: [
            {
              type: 'object',
              required: ['flag'],
              properties: { flag: { type: 'boolean' } },
              additionalProperties: false,
            },
            { type: 'object', properties: { flag: { type: 'boolean' } } },
          ],
        },
      },
    },
    paths: {
      '/compose': {
        post: {
          operationId: 'compose',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Alias' },
              },
            },
          },
          responses: {
            200: {
              description: 'Synthetic composed result',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Alias' },
                },
              },
            },
          },
        },
      },
    },
  };
}

export const allOfConsumer = `
import { operations } from './client.consumer.ts';
import type { RequestTypes, ResponseTypes } from './client.consumer.ts';
import { schema as scalar } from './standalone.scalar.ts';
export const build: typeof operations.compose.build = operations.compose.build;
export const input: RequestTypes['Alias'] = {
  id:'W-10', count:6, details:{label:'synthetic',active:true}, tag:'widget',clientOnly:'input',
};
build({body:input});
export const output: ResponseTypes['Alias'] = {
  id:'W-10', count:6, details:{label:'synthetic',active:true}, tag:'widget',serverOnly:'output',
};
const tag:'widget'=output.tag;
const label:string=output.details.label;
const active:boolean=output.details.active;
void [tag,label,active];
const parsedScalar:'W-20'=scalar.parse('W-20');
type ScalarValue=ReturnType<typeof scalar.parse>;
// @ts-expect-error A member of only the first enum is excluded by the intersection.
const firstOnly:ScalarValue='W-10';
// @ts-expect-error A member of only the second enum is excluded by the intersection.
const secondOnly:ScalarValue='W-30';
void [firstOnly,secondOnly];
// @ts-expect-error Scalar intersections retain their primitive type.
const numericScalar:number=parsedScalar;
void numericScalar;
// @ts-expect-error Composition retains required fields from both branches.
build({body:{id:'W-10',count:6,details:{label:'synthetic',active:true},clientOnly:'input'}});
// @ts-expect-error Nested overlapping objects retain both required fields.
build({body:{...input,details:{active:true}}});
// @ts-expect-error Directional projection excludes readOnly request fields.
build({body:{...input,serverOnly:'output'}});
// @ts-expect-error Composed scalar kinds remain precise.
build({body:{...input,count:'6'}});
`;

export function verifyAllOf(
  client: RuntimeClient,
  inputSchema: StandaloneModule,
  outputSchema: StandaloneModule,
  closedSchema: StandaloneModule,
  scalarSchema: StandaloneModule,
): void {
  const operation = present(client.operations.compose);
  const input = {
    id: 'W-10',
    count: 6,
    details: { label: 'synthetic', active: true },
    tag: 'widget',
    clientOnly: 'input',
  };
  const request = operation.build({ body: input });
  assert.deepEqual(request.body, input);
  assert.notEqual(request.body, input);
  assert.notEqual(record(request.body).details, input.details);
  const parsed = inputSchema.schema.parse(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  for (const changed of [
    { ...input, id: 'OTHER' },
    { ...input, id: 'W-lowercase' },
    { ...input, count: 2 },
    { ...input, count: 3 },
    { ...input, count: 30 },
    { ...input, details: { label: 'synthetic' } },
    { ...input, details: { active: true } },
    { ...input, tag: undefined },
    { ...input, extra: true },
    { ...input, serverOnly: 'output' },
  ]) {
    assert.throws(
      () => operation.build({ body: changed }),
      client.RequestValidationError,
    );
    assert.equal(inputSchema.schema.safeParse(changed).success, false);
  }
  const response = {
    id: input.id,
    count: input.count,
    details: { ...input.details, additive: true },
    tag: input.tag,
    serverOnly: 'output',
    clientOnly: 'stripped',
    additive: true,
  };
  const expected = {
    id: input.id,
    count: input.count,
    details: { ...input.details },
    tag: input.tag,
    serverOnly: 'output',
  };
  const output = outputSchema.schema.parse(response);
  assert.deepEqual(output, expected);
  assert.notEqual(record(output).details, response.details);
  const result = operation.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(response),
  });
  assert.equal(result.kind, 'success');
  if (result.kind === 'success') assert.deepEqual(result.data, expected);
  for (const count of [2, 3, 30])
    assert.equal(
      outputSchema.schema.safeParse({ ...response, count }).success,
      false,
    );
  input.details.label = 'changed';
  assert.equal(record(record(request.body).details).label, 'synthetic');
  assert.deepEqual(closedSchema.schema.parse({ flag: true }), { flag: true });
  assert.equal(
    closedSchema.schema.safeParse({ flag: true, extra: true }).success,
    false,
  );
  assert.equal(scalarSchema.schema.parse('W-20'), 'W-20');
  for (const value of ['W-10', 'W-30', 'OTHER', 'W-lowercase', 'W-', 10])
    assert.equal(scalarSchema.schema.safeParse(value).success, false);
}
