import type { CompileOptions } from '../dist/index.js';
import { ref, type Schema } from './schema-helpers.ts';

export function compositionGraphFixture(depth: number) {
  const schemas: Record<string, Schema> = {
    Leaf: { type: 'string', minLength: 1 },
    C0: {
      type: 'object',
      properties: {
        value: ref('Leaf'),
        read: { type: 'string', readOnly: true },
        write: { type: 'string', writeOnly: true },
      },
      required: ['value', 'read', 'write'],
    },
    Node: {
      type: 'object',
      properties: {
        value: { type: 'integer' },
        children: { type: 'object', additionalProperties: ref('Node') },
      },
      required: ['value'],
    },
    Nodes: {
      type: 'object',
      properties: {
        left: { allOf: [ref('Node'), { type: 'object' }] },
        right: { allOf: [ref('Node'), { type: 'object' }] },
      },
    },
  };
  for (let level = 1; level <= depth; level++)
    schemas[`C${level}`] = {
      type: 'object',
      properties: Object.fromEntries(
        ['left', 'right'].map((name) => [
          name,
          {
            allOf: [ref(`C${level - 1}`), { type: 'object', minProperties: 1 }],
          },
        ]),
      ),
    };
  const inline: Schema = {
    allOf: [
      ref(`C${depth}`),
      {
        type: 'object',
        properties: { stamp: { type: 'string' } },
        required: ['stamp'],
      },
    ],
  };
  const content = (schema: Schema) => ({ 'application/json': { schema } });
  const response = (schema: Schema) => ({
    description: 'Synthetic composed value',
    content: content(schema),
  });
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic shared composition graphs', version: '1' },
    components: { schemas },
    paths: {
      '/composed': {
        post: {
          operationId: 'save',
          requestBody: { required: true, content: content(inline) },
          responses: { 200: response(inline) },
        },
        get: {
          operationId: 'read',
          parameters: [
            { name: 'code', in: 'query', schema: { type: 'string' } },
          ],
          responses: { 200: response(inline) },
        },
      },
      '/recursive': {
        post: {
          operationId: 'nodes',
          requestBody: { required: true, content: content(ref('Nodes')) },
          responses: { 200: response(ref('Nodes')) },
        },
      },
    },
  };
}

export function compositionGraphSelection(
  depth: number,
  clients = false,
): CompileOptions {
  return {
    clients: clients ? ['first', 'second'] : [],
    surfaces: { first: ['save', 'read', 'nodes'], second: ['save'] },
    ...(clients
      ? {
          executionClients: ['first'],
          queries: { first: ['read'] },
        }
      : {}),
    standalone: {
      request: {
        schema: `#/components/schemas/C${depth}`,
        usage: 'request',
      },
      response: {
        schema: `#/components/schemas/C${depth}`,
        usage: 'response',
      },
    },
  };
}

// The schema graph branches twice per level. Runtime values deliberately use a
// linear chain and one shared child, so declaration growth is measured separately
// from the cost of validating an exponentially large value.
export function compositionGraphValue(
  depth: number,
  usage: 'request' | 'response',
  value: unknown = 'leaf',
): object {
  let child: object =
    usage === 'request'
      ? { value, write: 'request' }
      : { value, read: 'response' };
  for (let level = 1; level < depth; level++) child = { left: child };
  return depth === 0 ? child : { left: child, right: child };
}

export const compositionGraphConsumer = `
import {operations} from './generated/client.first.ts';
import {operations as second} from './generated/client.second.ts';
import {createQueries} from './generated/client.first.queries.ts';
import {schema as request} from './generated/standalone.request.ts';
import {schema as response} from './generated/standalone.response.ts';
import type {Output} from './generated/standalone.response.ts';

export function consume(raw: unknown) {
  const body = {...request.parse(raw), stamp: 'composed'};
  operations.save.build({body});
  second.save.build({body});
  const parsed = operations.save.parseResponse({status:200,headers:{'content-type':'application/json'},body:''});
  if (parsed.kind === 'success') {
    const output: Output = parsed.data;
    response.parse(output);
  }
  const queries = createQueries({namespace:'composed',execute:async()=>({status:200,headers:{'content-type':'application/json'},body:''})});
  queries.read.body().key({context:{},input:{query:{code:'value'}}});
  operations.nodes.build({body:{left:{value:1,children:{next:{value:2}}}}});
  // @ts-expect-error The operation-inline composition adds a required property.
  operations.save.build({body:request.parse(raw)});
  // @ts-expect-error Shared recursive maps retain their member types.
  operations.nodes.build({body:{left:{value:1,children:{next:2}}}});
  // @ts-expect-error Recursive member values remain numeric.
  operations.nodes.build({body:{left:{value:'wrong'}}});
  return body;
}
type Leaf<T> = T extends {left?: infer Child} ? Leaf<NonNullable<Child>> : T;
type InputLeaf = Leaf<ReturnType<typeof request.parse>>;
type OutputLeaf = Leaf<Output>;
export const inputLeaf: InputLeaf = {value:'leaf',write:'request'};
export const outputLeaf: OutputLeaf = {value:'leaf',read:'response'};
// @ts-expect-error Shared leaf aliases preserve forbidden request properties.
export const forbidden: InputLeaf = {value:'leaf',write:'request',read:'forbidden'};
// @ts-expect-error Shared leaf aliases preserve required response properties.
export const missing: OutputLeaf = {value:'leaf'};
`;
