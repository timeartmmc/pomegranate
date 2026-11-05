import type { CompileOptions } from '../dist/index.js';
import type { Schema } from './schema-helpers.ts';

const ref = (name: string): Schema => ({
  $ref: `#/components/schemas/${name}`,
});

export function typeIdentityFixture() {
  const schemas: Record<string, Schema> = {
    Leaf: { type: 'string', const: 'leaf' },
    Private: {
      type: 'object',
      properties: { privateMarker: { type: 'string' } },
    },
  };
  for (let level = 1; level <= 63; level++) {
    schemas[`Node${level}`] = {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'node' },
        value: ref(level === 1 ? 'Leaf' : `Choice${level - 1}`),
      },
      required: ['kind', 'value'],
    };
    schemas[`End${level}`] = {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'end' },
        value: { type: 'integer' },
      },
      required: ['kind', 'value'],
    };
    schemas[`Choice${level}`] = {
      oneOf: [ref(`Node${level}`), ref(`End${level}`)],
      discriminator: {
        propertyName: 'kind',
        mapping: {
          node: `#/components/schemas/Node${level}`,
          end: `#/components/schemas/End${level}`,
        },
      },
    };
  }
  schemas.Root = {
    type: 'object',
    properties: { value: ref('Choice63') },
    required: ['value'],
  };
  const response = (schema: string) => ({
    description: 'Synthetic',
    content: { 'application/json': { schema: ref(schema) } },
  });
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic component type identities', version: '1' },
    components: { schemas },
    paths: {
      '/tree': {
        post: {
          operationId: 'save',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('Root') } },
          },
          responses: { 200: response('Root') },
        },
        get: { operationId: 'read', responses: { 200: response('Root') } },
      },
      '/leaf': {
        get: { operationId: 'leaf', responses: { 200: response('Leaf') } },
      },
      '/private': {
        get: {
          operationId: 'privateRead',
          responses: { 200: response('Private') },
        },
      },
    },
  };
}

export const typeIdentitySelection = {
  clients: ['consumer', 'staff'],
  surfaces: {
    consumer: ['save', 'read'],
    staff: ['leaf'],
    internal: ['privateRead'],
  },
  executionClients: ['consumer'],
  queries: { consumer: ['read'] },
  standalone: {
    request: { schema: '#/components/schemas/Root', usage: 'request' },
    response: { schema: '#/components/schemas/Root', usage: 'response' },
  },
} as const satisfies CompileOptions;

export function typeIdentityValue(): unknown {
  let value: unknown = 'leaf';
  for (let level = 0; level < 63; level++) value = { kind: 'node', value };
  return { value };
}

export const typeIdentityConsumer = `
import {QueryClient} from '@tanstack/query-core';
import {operations,createClient} from './type-identity-generated/client.consumer.ts';
import type {RequestTypes,ResponseTypes} from './type-identity-generated/client.consumer.ts';
import {createQueries} from './type-identity-generated/client.consumer.queries.ts';
import {schema} from './type-identity-generated/standalone.request.ts';
import type {Output} from './type-identity-generated/standalone.response.ts';

export async function consume(raw:unknown) {
  const body=schema.parse(raw);
  operations.save.build({body});
  const config={namespace:'type-identity',execute:async()=>({status:200,headers:{'Content-Type':'application/json'},body:JSON.stringify(raw)})};
  const result=await createClient(config).save.call({context:{},input:{body}});
  const request:RequestTypes['Root']=result.data;
  const response:ResponseTypes['Root']=body;
  operations.save.build({body:response});
  const cache=new QueryClient();
  try {
    const page:Output=await cache.fetchQuery(createQueries(config).read.body().options({context:{}}));
    operations.save.build({body:page});
  } finally {cache.clear();}
  return {request,response};
}
// @ts-expect-error Root requires its value property.
operations.save.build({body:{}});
// @ts-expect-error Tagged branches retain their required field.
operations.save.build({body:{value:{kind:'node'}}});
// @ts-expect-error End values remain numeric.
operations.save.build({body:{value:{kind:'end',value:'wrong'}}});
// @ts-expect-error Required body presence is preserved by executable clients.
createClient({namespace:'negative',execute:async()=>({status:200,headers:{},body:''})}).save.call({context:{}});
`;
