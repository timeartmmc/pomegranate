import assert from 'node:assert/strict';
import { present } from './assertions.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const ref = (kind: string, name: string) => ({
  $ref: `#/components/${kind}/${name}`,
});
const schemaRef = (name: string): Schema => ref('schemas', name);
const sampleNames = [
  'Amount',
  'Step',
  'Mode',
  'StrictMode',
  'Text',
  'List',
  'Bag',
];

// The equivalent 3.1 input is explicit at each differing assertion. It is an
// output parity oracle, while the sample table below independently checks values.
export function openapi30Fixture(modern = false) {
  const nullable = (type: string): Schema =>
    modern ? { type: [type, 'null'] } : { type, nullable: true };
  const schemas: Record<string, Schema> = {
    Amount: {
      ...nullable('number'),
      ...(modern
        ? { exclusiveMinimum: 0, maximum: 10 }
        : {
            minimum: 0,
            exclusiveMinimum: true,
            maximum: 10,
            exclusiveMaximum: false,
          }),
      multipleOf: 0.5,
    },
    Step: {
      type: 'integer',
      ...(modern
        ? { minimum: 0, exclusiveMaximum: 4 }
        : {
            minimum: 0,
            exclusiveMinimum: false,
            maximum: 4,
            exclusiveMaximum: true,
          }),
    },
    Mode: { ...nullable('string'), enum: ['fast', null] },
    StrictMode: { ...nullable('string'), enum: ['fast'] },
    Text: { ...nullable('string'), minLength: 2 },
    List: {
      ...nullable('array'),
      items: schemaRef('Text'),
      minItems: 1,
      maxItems: 2,
    },
    Bag: {
      ...nullable('object'),
      additionalProperties: schemaRef('Amount'),
      minProperties: 1,
    },
    Record: {
      ...nullable('object'),
      properties: {
        label: schemaRef('Text'),
        amount: schemaRef('Amount'),
        id: { type: 'string', readOnly: true },
        secret: { type: 'string', writeOnly: true },
      },
      required: ['label', 'amount', 'id', 'secret'],
    },
    Alias: schemaRef('Record'),
  };
  const content = (name: string) => ({
    'application/json': { schema: schemaRef(name) },
  });
  const roundTrip = {
    operationId: 'roundTrip',
    parameters: [ref('parameters', 'SearchAlias'), ref('parameters', 'Trace')],
    requestBody: ref('requestBodies', 'BodyAlias'),
    responses: { 200: ref('responses', 'ReplyAlias') },
  };
  const samplePaths = Object.fromEntries(
    sampleNames.map((name) => [
      `/samples/${name}`,
      {
        post: {
          operationId: `check${name}`,
          requestBody: { required: true, content: content(name) },
          responses: { 200: { description: 'Sample', content: content(name) } },
        },
      },
    ]),
  );
  return {
    openapi: modern ? '3.1.2' : '3.0.4',
    info: { title: 'Synthetic OpenAPI dialect parity', version: '1' },
    security: [{ SessionAlias: [] }],
    components: {
      schemas,
      securitySchemes: {
        Session: { type: 'http', scheme: 'bearer' },
        SessionAlias: ref('securitySchemes', 'Session'),
      },
      examples: {
        Search: { value: 'fast' },
        SearchAlias: ref('examples', 'Search'),
      },
      parameters: {
        Search: {
          name: 'search',
          in: 'query',
          schema: nullable('string'),
          examples: { fast: ref('examples', 'SearchAlias') },
        },
        SearchAlias: ref('parameters', 'Search'),
        Trace: { name: 'X-Trace', in: 'header', schema: nullable('string') },
      },
      requestBodies: {
        Body: { required: true, content: content('Alias') },
        BodyAlias: ref('requestBodies', 'Body'),
      },
      headers: {
        Mode: { schema: { type: 'string', enum: ['full'] } },
        ModeAlias: ref('headers', 'Mode'),
      },
      responses: {
        Reply: {
          description: 'Round trip',
          content: content('Alias'),
          headers: { 'X-Mode': ref('headers', 'ModeAlias') },
        },
        ReplyAlias: ref('responses', 'Reply'),
      },
    },
    paths: { '/round-trip': { post: roundTrip }, ...samplePaths },
  };
}

export const openapi30Selection = {
  clients: ['consumer'],
  surfaces: {
    consumer: ['roundTrip', ...sampleNames.map((name) => `check${name}`)],
  },
  standalone: {
    request: { schema: '#/components/schemas/Alias', usage: 'request' },
    response: { schema: '#/components/schemas/Alias', usage: 'response' },
  },
} as const;

export function verifyOpenapi30(
  client: RuntimeClient,
  standaloneRequest: StandaloneModule,
  standaloneResponse: StandaloneModule,
): void {
  const cases: [string, unknown[], unknown[]][] = [
    ['Amount', [null, 0.5, 10], [0, -1, 10.5, 0.3, '1']],
    ['Step', [0, 1, 3], [null, -1, 4, 0.5]],
    ['Mode', [null, 'fast'], ['slow', 0]],
    ['StrictMode', ['fast'], [null, 'slow']],
    ['Text', [null, 'ok'], ['', 'x', 1]],
    [
      'List',
      [null, [null], ['ok', null]],
      [[], ['x'], [1], [null, null, null]],
    ],
    ['Bag', [null, { value: 0.5 }, { value: null }], [{}, { value: 0 }]],
  ];
  for (const [name, valid, invalid] of cases) {
    const operation = present(client.operations[`check${name}`]);
    for (const input of valid) {
      assert.deepEqual(operation.build({ body: input }).body, input, name);
      const response = operation.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      assert.equal(response.kind, 'success', name);
      assert.deepEqual(response.data, input, name);
    }
    for (const input of invalid) {
      assert.throws(
        () => operation.build({ body: input }),
        client.RequestValidationError,
        name,
      );
      assert.equal(
        operation.parseResponse({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }).kind,
        'protocol',
        name,
      );
    }
  }
  const operation = present(client.operations.roundTrip);
  const input = { label: null, amount: 0.5, secret: 'secret' };
  const request = operation.build({
    body: input,
    query: { search: null },
    headers: { 'X-Trace': null },
  });
  assert.equal(request.url, '/round-trip');
  assert.deepEqual(Object.keys(request.headers), []);
  assert.deepEqual(request.security, {
    transport: 'bearer',
    scheme: 'SessionAlias',
  });
  assert.deepEqual(request.body, input);
  assert.notEqual(request.body, input);
  assert.deepEqual(standaloneRequest.schema.parse(input), input);
  assert.equal(standaloneRequest.schema.parse(null), null);
  assert.throws(() => operation.build({ body: { ...input, id: 'server' } }));
  assert.throws(() =>
    standaloneRequest.schema.parse({ label: null, amount: 1 }),
  );
  const body = { label: 'ok', amount: null, id: 'server', secret: 12 };
  const expected = { label: 'ok', amount: null, id: 'server' };
  assert.deepEqual(standaloneResponse.schema.parse(body), expected);
  assert.equal(standaloneResponse.schema.parse(null), null);
  const response = operation.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Mode': 'full' },
    body: JSON.stringify(body),
  });
  assert.equal(response.kind, 'success');
  assert.deepEqual(response.data, expected);
  assert.equal(response.validatedHeaders['x-mode'], 'full');
}

export const openapi30Consumer = `
import { operations } from './client.consumer.ts';
import { schema as request } from './standalone.request.ts';
import { schema as response } from './standalone.response.ts';
operations.roundTrip.build({body:null,query:{search:null},headers:{'X-Trace':null}});
operations.roundTrip.build({body:{label:null,amount:1,secret:'secret'}});
// @ts-expect-error Request projection removes read-only fields.
operations.roundTrip.build({body:{label:null,amount:1,secret:'secret',id:'server'}});
operations.checkMode.build({body:null});
operations.checkStrictMode.build({body:'fast'});
// @ts-expect-error nullable does not override an enum that excludes null.
operations.checkStrictMode.build({body:null});
operations.checkList.build({body:[null,'ok']});
// @ts-expect-error Nullable strings retain their non-null type.
operations.checkText.build({body:1});
const input = request.parse(null);
if (input !== null) { const secret: string = input.secret; void secret; }
const output = response.parse(null);
if (output !== null) {
  const id: string = output.id;
  // @ts-expect-error Response projection removes write-only fields.
  void output.secret;
  void id;
}
`;
