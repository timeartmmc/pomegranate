import type { CompileOptions } from '../dist/index.js';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

export function directionalTypeIdentityFixture(
  plain = false,
  directional = true,
) {
  const schemas: Record<string, Schema> = {};
  const secret = {
    type: 'string',
    ...(directional ? { writeOnly: true } : {}),
  };
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
        secret,
      },
      required: prefix === 'Required' ? ['value', 'secret'] : ['value'],
    };
    const root = prefix === 'Tree' ? 'Root' : `${prefix}Root`;
    const shallow = prefix === 'Tree' ? 'ShallowRoot' : `${prefix}ShallowRoot`;
    if (plain) {
      for (let level = 1; level <= 126; level++)
        schemas[`${prefix}Plain${level}`] = {
          type: 'object',
          properties: {
            value: ref(
              level === 1 ? `${prefix}Leaf` : `${prefix}Plain${level - 1}`,
            ),
            secret,
          },
          required: ['value'],
        };
      schemas[root] = ref(`${prefix}Plain126`);
      schemas[shallow] = ref(`${prefix}Plain28`);
      continue;
    }
    for (let level = 1; level <= 62; level++) {
      schemas[`${prefix}Node${level}`] = {
        type: 'object',
        properties: {
          kind: { type: 'string', const: 'node' },
          secret,
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
    for (const [name, levels] of [
      [root, 62],
      [shallow, 13],
    ] as const) {
      const container = `${name}Container`;
      schemas[container] = {
        type: 'object',
        properties: { value: ref(`${prefix}Choice${levels}`), secret },
        required: ['value'],
      };
      // Two root objects plus the union/object pairs and leaf reach either
      // 128 structural levels or 30 levels for ordinary directional composition.
      schemas[name] = {
        type: 'object',
        properties: { value: ref(container), secret },
        required: ['value'],
      };
    }
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
      '/shallow': { post: save('shallow', 'ShallowRoot') },
      '/shallow-wrong': {
        get: {
          operationId: 'shallowWrong',
          responses: response('WrongShallowRoot'),
        },
      },
      '/shallow-required': {
        post: save('shallowRequired', 'RequiredShallowRoot'),
      },
    },
  };
}

export const directionalTypeIdentitySelection = {
  clients: ['consumer'],
  surfaces: {
    consumer: [
      'save',
      'wrong',
      'required',
      'shallow',
      'shallowWrong',
      'shallowRequired',
    ],
  },
  standalone: {
    request: { schema: ref('Root').$ref, usage: 'request' },
    response: { schema: ref('Root').$ref, usage: 'response' },
  },
} as const satisfies CompileOptions;

export function directionalTypeIdentityValue(
  leaf: unknown = { value: 'leaf' },
  plain = false,
  levels = plain ? 126 : 62,
): unknown {
  let value = leaf;
  if (plain) {
    for (let level = 0; level < levels; level++) value = { value };
    return value;
  }
  for (let level = 0; level < levels; level++) value = { kind: 'node', value };
  return { value: { value } };
}

export function directionalTypeIdentityConsumer(
  plain = false,
  directional = true,
): string {
  const deepLeaf = plain
    ? `const leaf=response${'.value'.repeat(126)};`
    : `const node62=response.value.value;\n${Array.from(
        { length: 62 },
        (_, index) => {
          const level = 62 - index;
          return `if(node${level}.kind==='end') return undefined;\n${level === 1 ? 'const leaf=node1.value;' : `const node${level - 1}=node${level}.value;`}`;
        },
      ).join('\n')}`;
  return `
import {operations} from './generated/client.consumer.ts';
import type {RequestTypes,ResponseTypes} from './generated/client.consumer.ts';
import {schema as requestSchema} from './generated/standalone.request.ts';
import {schema as responseSchema} from './generated/standalone.response.ts';

export function consume(raw:unknown) {
  const source=requestSchema.parse(raw);
  const request:RequestTypes['Root']=source;
  const parsed=responseSchema.parse(raw);
  const response:ResponseTypes['Root']=parsed;
  const prepared=operations.save.build({body:request});
  const observed=prepared.parseResponse({status:200,headers:{},body:''});
  if(observed.kind==='success') {
    const output:ResponseTypes['Root']=observed.data;
    void output;
    ${directional ? '' : 'operations.save.build({body:observed.data});'}
  }
  ${
    directional
      ? ''
      : `const compatible:ResponseTypes['Root']=source;
  operations.save.build({body:response});
  void compatible;`
  }
  return {request,response};
}

export function compose(input:RequestTypes['ShallowRoot'],output:ResponseTypes['ShallowRoot']) {
  operations.shallow.build({body:output});
  const compatible:ResponseTypes['ShallowRoot']=input;
  return compatible;
}

export function exactDeep(response:ResponseTypes['Root']) {
  ${deepLeaf}
  const exact:'leaf'=leaf.value;
  // @ts-expect-error The deepest literal remains a string literal.
  const wrong:number=leaf.value;
  ${directional ? '// @ts-expect-error The response leaf omits its write-only field.\n  void leaf.secret;' : ''}
  void wrong;
  return exact;
}

export function requiredLeaf(input:RequestTypes['RequiredLeaf']) {
  const secret:string=input.secret;
  // @ts-expect-error A required field cannot disappear from request types.
  const missing:RequestTypes['RequiredLeaf']={value:'leaf'};
  void missing;
  return secret;
}

export function rejectIncompatible(wrong:ResponseTypes['WrongShallowRoot'],required:ResponseTypes['RequiredShallowRoot']) {
  // @ts-expect-error An incompatible scalar remains rejected in ordinary composition.
  operations.shallow.build({body:wrong});
  ${directional ? '// @ts-expect-error The response omits a write-only field required by the request.' : ''}
  operations.shallowRequired.build({body:required});
}
`;
}
