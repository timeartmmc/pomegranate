import type { CompileOptions } from '../dist/index.js';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

export function directionalTypeIdentityFixture(plain = false) {
  const schemas: Record<string, Schema> = {};
  for (let level = 1; level <= 62; level++)
    schemas[`End${level}`] = {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'end' },
        value: { type: 'integer' },
      },
      required: ['kind', 'value'],
    };
  for (const prefix of ['Tree', 'Wrong', 'Required']) {
    schemas[`${prefix}Leaf`] = {
      type: 'object',
      properties: {
        value:
          prefix === 'Wrong'
            ? { type: 'integer' }
            : { type: 'string', const: 'leaf' },
        secret: { type: 'string', writeOnly: true },
      },
      required: prefix === 'Required' ? ['value', 'secret'] : ['value'],
    };
    if (plain) {
      for (let level = 1; level <= 126; level++)
        schemas[`${prefix}Plain${level}`] = {
          type: 'object',
          properties: {
            value: ref(
              level === 1 ? `${prefix}Leaf` : `${prefix}Plain${level - 1}`,
            ),
            secret: { type: 'string', writeOnly: true },
          },
          required: ['value'],
        };
      schemas[prefix === 'Tree' ? 'Root' : `${prefix}Root`] = ref(
        `${prefix}Plain126`,
      );
      continue;
    }
    for (let level = 1; level <= 62; level++) {
      schemas[`${prefix}Node${level}`] = {
        type: 'object',
        properties: {
          kind: { type: 'string', const: 'node' },
          secret: { type: 'string', writeOnly: true },
          value: ref(
            level === 1 ? `${prefix}Leaf` : `${prefix}Choice${level - 1}`,
          ),
        },
        required: ['kind', 'value'],
      };
      schemas[`${prefix}Choice${level}`] = {
        oneOf: [ref(`${prefix}Node${level}`), ref(`End${level}`)],
        discriminator: {
          propertyName: 'kind',
          mapping: {
            node: ref(`${prefix}Node${level}`).$ref,
            end: ref(`End${level}`).$ref,
          },
        },
      };
    }
    schemas[`${prefix}Container`] = {
      type: 'object',
      properties: {
        value: ref(`${prefix}Choice62`),
        secret: { type: 'string', writeOnly: true },
      },
      required: ['value'],
    };
    // Two root objects, 62 union/object pairs and the leaf object/scalar
    // exercise exactly 128 structural levels in both directional projections.
    schemas[prefix === 'Tree' ? 'Root' : `${prefix}Root`] = {
      type: 'object',
      properties: {
        value: ref(`${prefix}Container`),
        secret: { type: 'string', writeOnly: true },
      },
      required: ['value'],
    };
  }
  const response = (name: string) => ({
    200: {
      description: 'Synthetic directional type identity',
      content: { 'application/json': { schema: ref(name) } },
    },
  });
  const save = (operationId: string, name: string) => ({
    operationId,
    requestBody: {
      required: true,
      content: { 'application/json': { schema: ref(name) } },
    },
    responses: response(name),
  });
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic directional type identities', version: '1' },
    components: { schemas },
    paths: {
      '/tree': { post: save('save', 'Root') },
      '/wrong': {
        get: { operationId: 'wrong', responses: response('WrongRoot') },
      },
      '/required': { post: save('required', 'RequiredRoot') },
    },
  };
}

export const directionalTypeIdentitySelection = {
  clients: ['consumer'],
  surfaces: { consumer: ['save', 'wrong', 'required'] },
  standalone: {
    request: { schema: ref('Root').$ref, usage: 'request' },
    response: { schema: ref('Root').$ref, usage: 'response' },
  },
} as const satisfies CompileOptions;

export function directionalTypeIdentityValue(
  leaf: unknown = { value: 'leaf' },
  plain = false,
): unknown {
  let value = leaf;
  if (plain) {
    for (let level = 0; level < 126; level++) value = { value };
    return value;
  }
  for (let level = 0; level < 62; level++) value = { kind: 'node', value };
  return { value: { value } };
}

export function directionalTypeIdentityConsumer(plain = false): string {
  return `
import {operations} from './generated/client.consumer.ts';
import type {RequestTypes,ResponseTypes} from './generated/client.consumer.ts';
import {schema as requestSchema} from './generated/standalone.request.ts';
import {schema as responseSchema} from './generated/standalone.response.ts';

export function consume(raw:unknown) {
  const response=responseSchema.parse(raw);
  const request:RequestTypes['Root']=response;
  operations.save.build({body:response});
  const source=requestSchema.parse(raw);
  const compatible:ResponseTypes['Root']=source;
  const prepared=operations.save.build({body:source});
  const observed=prepared.parseResponse({status:200,headers:{},body:''});
  if(observed.kind==='success') operations.save.build({body:observed.data});
  const leaf=response${plain ? '.value'.repeat(126) : '.value.value'};
  ${plain ? 'const exact: "leaf" = leaf.value; void exact;' : 'void leaf;'}
  return {request,compatible};
}

export function rejectIncompatible(wrong:ResponseTypes['WrongRoot'],required:ResponseTypes['RequiredRoot']) {
  // @ts-expect-error A different scalar at the deepest leaf remains incompatible.
  operations.save.build({body:wrong});
  // @ts-expect-error The response omits a write-only field required by the request.
  operations.required.build({body:required});
}
`;
}
