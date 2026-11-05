import assert from 'node:assert/strict';
import { present } from './assertions.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

export function toleranceFixture(modern = true) {
  const value: Schema = {
    type: 'integer',
    format: 'int64',
    default: 0,
    'x-vendor': { note: 'Retained only in the source contract' },
  };
  const nullable: Schema = modern
    ? { type: ['integer', 'null'], format: 'int64' }
    : { type: 'integer', nullable: true, format: 'int64' };
  const schemas: Record<string, Schema> = {
    Value: value,
    Payload: {
      type: 'object',
      required: ['value'],
      properties: {
        value: { $ref: '#/components/schemas/Value' },
        nullable,
        encoded: { type: 'string', format: 'byte' },
        password: {
          type: 'string',
          format: 'password',
          minLength: 2,
          default: 'Server documentation',
          'x-vendor': true,
        },
      },
    },
  };
  const content = (name: string) => ({
    'application/json': { schema: { $ref: `#/components/schemas/${name}` } },
  });
  return {
    openapi: modern ? '3.1.2' : '3.0.4',
    info: {
      title: 'Synthetic defaults, explicit extensions and safe int64',
      version: '1',
    },
    'x-vendor': { schema: { allOf: [], nullable: true } },
    components: { schemas },
    paths: {
      '/values': {
        post: {
          'x-vendor': { nullable: true, format: 'private' },
          requestBody: { required: true, content: content('Payload') },
          responses: {
            200: { description: 'Value', content: content('Payload') },
          },
        },
      },
      '/value': {
        get: {
          parameters: [
            {
              name: 'amount',
              in: 'query',
              schema: { $ref: '#/components/schemas/Value' },
            },
          ],
          responses: {
            200: { description: 'Integer', content: content('Value') },
          },
        },
      },
    },
  };
}

export const toleranceSelection = {
  ignoreExtensions: ['x-vendor'],
  clients: ['consumer'],
  surfaces: { consumer: ['POST /values', 'GET /value'] },
  standalone: {
    int64: { schema: '#/components/schemas/Value', usage: 'response' },
  },
} as const;

export function verifyTolerance(
  client: RuntimeClient,
  standalone: StandaloneModule,
): void {
  const post = present(client.operations['POST /values']);
  const get = present(client.operations['GET /value']);
  for (const value of [
    Number.MIN_SAFE_INTEGER,
    -1,
    0,
    1,
    Number.MAX_SAFE_INTEGER,
  ]) {
    assert.equal(standalone.schema.parse(value), value);
    const input = { value, nullable: null, password: 'ok', encoded: 'Zg==' };
    const request = post.build({ body: input });
    assert.deepEqual(request.body, input);
    input.value = 7;
    assert.deepEqual(request.body, {
      value,
      nullable: null,
      password: 'ok',
      encoded: 'Zg==',
    });
    const response = get.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: String(value),
    });
    assert.equal(response.kind, 'success');
    assert.equal(response.data, value);
    assert.equal(
      get.build({ query: { amount: value } }).url,
      `/value?amount=${value}`,
    );
  }
  for (const value of [
    Number.MIN_SAFE_INTEGER - 1,
    Number.MAX_SAFE_INTEGER + 1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    1n,
    '1',
    null,
    undefined,
  ]) {
    assert.equal(
      standalone.schema.safeParse(value).success,
      false,
      String(value),
    );
    assert.throws(
      () => post.build({ body: { value } }),
      client.RequestValidationError,
    );
  }
  for (const value of [
    Number.MIN_SAFE_INTEGER - 1,
    Number.MAX_SAFE_INTEGER + 1,
    0.5,
    '1',
  ])
    assert.throws(
      () => get.build({ query: { amount: value } }),
      client.RequestValidationError,
    );
  for (const body of ['9007199254740993', '-9007199254740993', '1.5', '"1"'])
    assert.equal(
      get.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body,
      }).kind,
      'protocol',
      body,
    );
  assert.deepEqual(post.build({ body: { value: 1 } }).body, { value: 1 });
  assert.throws(() => post.build({ body: {} }), client.RequestValidationError);
  assert.throws(
    () => post.build({ body: { value: 1, password: 'x' } }),
    client.RequestValidationError,
  );
  assert.throws(
    () => post.build({ body: { value: 1, encoded: 'not base64' } }),
    client.RequestValidationError,
  );
  assert.equal(
    post.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 1, encoded: 'not base64' }),
    }).kind,
    'protocol',
  );
  const response = post.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: '{"value":1}',
  });
  assert.equal(response.kind, 'success');
  assert.deepEqual(response.data, { value: 1 });
  assert.equal(
    post.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).kind,
    'protocol',
  );
  for (const value of [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER])
    assert.deepEqual(post.build({ body: { value: 1, nullable: value } }).body, {
      value: 1,
      nullable: value,
    });
  assert.throws(
    () =>
      post.build({ body: { value: 1, nullable: Number.MAX_SAFE_INTEGER + 1 } }),
    client.RequestValidationError,
  );
}

export const toleranceConsumer = `
import { operations } from './client.consumer.ts';
import { schema } from './standalone.int64.ts';
operations['POST /values'].build({body:{value:9007199254740991,nullable:null,password:'ok',encoded:'Zg=='}});
operations['GET /value'].build({query:{amount:-9007199254740991}});
// @ts-expect-error Numeric int64 retains number inputs.
operations['POST /values'].build({body:{value:'1'}});
// @ts-expect-error Numeric int64 does not expose bigint inputs.
operations['POST /values'].build({body:{value:1n}});
// @ts-expect-error Nullable int64 retains its numeric non-null branch.
operations['POST /values'].build({body:{value:1,nullable:'1'}});
// @ts-expect-error String constraints retain the base string type.
operations['POST /values'].build({body:{value:1,password:1}});
// @ts-expect-error Base64 values remain strings.
operations['POST /values'].build({body:{value:1,encoded:1}});
// @ts-expect-error Defaults do not make required properties optional.
operations['POST /values'].build({body:{}});
const parsed:number=schema.parse(1); void parsed;
const response=operations['POST /values'].parseResponse({status:200,headers:{},body:''});
if(response.kind==='success') {
  const value:number=response.data.value;
  const password:string|undefined=response.data.password;
  void [value,password];
}
`;
