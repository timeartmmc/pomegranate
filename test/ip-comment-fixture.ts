import assert from 'node:assert/strict';
import { present } from './assertions.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const ref = (name: string): Schema => ({
  $ref: `#/components/schemas/${name}`,
});

export const ipCommentSelection = {
  clients: ['consumer'],
  surfaces: { consumer: ['exchange'] },
  standalone: {
    ipv4: { schema: '#/components/schemas/Ipv4', usage: 'request' },
    ipv6: { schema: '#/components/schemas/Ipv6', usage: 'response' },
    nullable: { schema: '#/components/schemas/Nullable', usage: 'response' },
    narrow: { schema: '#/components/schemas/Narrow', usage: 'request' },
    data: { schema: '#/components/schemas/CommentData', usage: 'request' },
  },
} as const;

export function ipCommentFixture() {
  const schemas: Record<string, Schema> = {
    Ipv4: { type: 'string', format: 'ipv4' },
    Ipv6: { type: 'string', format: 'ipv6' },
    Pair: {
      type: 'object',
      properties: { v4: ref('Ipv4'), v6: ref('Ipv6') },
      required: ['v4', 'v6'],
    },
    Nullable: { type: ['string', 'null'], format: 'ipv4' },
    Narrow: { ...ref('Ipv6'), pattern: '^2001:', maxLength: 12 },
    CommentData: {
      type: 'object',
      properties: { $comment: { type: 'string' } },
      required: ['$comment'],
      example: { $comment: { opaque: true } },
      examples: [{ $comment: 42 }],
      default: { $comment: null },
    },
    Unused: { type: 'boolean' },
  };
  return {
    openapi: '3.1.1',
    info: { title: 'Synthetic IP formats and schema comments', version: '1' },
    components: { schemas },
    paths: {
      '/ip/{v4}': {
        post: {
          operationId: 'exchange',
          parameters: [
            { name: 'v4', in: 'path', required: true, schema: ref('Ipv4') },
            { name: 'v6', in: 'query', schema: ref('Ipv6') },
            { name: 'X-Peer', in: 'header', schema: ref('Ipv6') },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: ref('Pair') } },
          },
          responses: {
            200: {
              description: 'Validated addresses',
              headers: { 'X-Peer': { required: true, schema: ref('Ipv6') } },
              content: { 'application/json': { schema: ref('Pair') } },
            },
          },
        },
      },
    },
  };
}

export function ipCommentSchemaTargets(
  document: ReturnType<typeof ipCommentFixture>,
): Schema[] {
  const operation = document.paths['/ip/{v4}'].post;
  return [
    ...Object.values(document.components.schemas),
    ...Object.values(present(document.components.schemas.Pair).properties!),
    present(present(document.components.schemas.CommentData).properties)
      .$comment!,
    ...operation.parameters.map((parameter) => parameter.schema),
    operation.requestBody.content['application/json'].schema,
    operation.responses[200].content['application/json'].schema,
    operation.responses[200].headers['X-Peer'].schema,
  ];
}

export const ipCommentConsumer = `
import {operations} from './client.consumer.ts';
import {schema as ipv4} from './standalone.ipv4.ts';
const request = operations.exchange.build({
  path:{v4:'001.002.003.004'},
  query:{v6:'::1'},
  headers:{'X-Peer':'2001:DB8::1'},
  body:{v4:'192.0.2.1',v6:'::ffff:192.0.2.1'},
});
const address: string = ipv4.parse('192.0.2.1');
// @ts-expect-error IP formats preserve string input types.
operations.exchange.build({path:{v4:1},body:{v4:'192.0.2.1',v6:'::1'}});
// @ts-expect-error IP schemas retain required fields through references.
operations.exchange.build({path:{v4:'192.0.2.1'},body:{v4:'192.0.2.1'}});
const response = request.parseResponse({status:200,headers:{},body:''});
if(response.kind === 'success') {
  const value: string = response.data.v6;
  void value;
}
void address;
`;

export function verifyIpComment(
  client: RuntimeClient,
  ipv4?: StandaloneModule,
  ipv6?: StandaloneModule,
): void {
  const operation = present(client.operations.exchange);
  const input = {
    path: { v4: '001.002.003.004' },
    query: { v6: '2001:DB8::1' },
    headers: { 'X-Peer': '1:2:3:4:5:6:7::' },
    body: { v4: '192.0.2.1', v6: '::ffff:192.0.2.1' },
  };
  const request = operation.build(input);
  assert.equal(request.url, '/ip/001.002.003.004?v6=2001%3ADB8%3A%3A1');
  assert.equal(request.headers['X-Peer'], '1:2:3:4:5:6:7::');
  assert.deepEqual(request.body, input.body);
  assert.notEqual(request.body, input.body);
  for (const bad of [
    { ...input, path: { v4: '256.0.0.1' } },
    { ...input, query: { v6: '[::1]' } },
    { ...input, headers: { 'X-Peer': 'fe80::1%eth0' } },
    { ...input, body: { ...input.body, v4: '127.1' } },
    { ...input, body: { ...input.body, v6: '::ffff:01.2.3.4' } },
  ])
    assert.throws(() => operation.build(bad), client.RequestValidationError);
  const observed = {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Peer': '::1' },
    body: JSON.stringify(input.body),
  };
  const response = request.parseResponse(observed);
  assert.equal(response.kind, 'success');
  if (response.kind === 'success') {
    assert.deepEqual(response.data, input.body);
    assert.equal(response.validatedHeaders['x-peer'], '::1');
  }
  for (const bad of [
    { ...observed, headers: { ...observed.headers, 'X-Peer': '[::1]' } },
    { ...observed, body: JSON.stringify({ ...input.body, v4: '1.2.3' }) },
    { ...observed, body: JSON.stringify({ ...input.body, v6: '::1/128' }) },
  ])
    assert.equal(request.parseResponse(bad).kind, 'protocol');
  if (ipv4) {
    assert.equal(ipv4.schema.parse('001.002.003.004'), '001.002.003.004');
    assert.equal(ipv4.schema.safeParse('256.0.0.1').success, false);
  }
  if (ipv6) {
    assert.equal(ipv6.schema.parse('1:2:3:4:5:6:7::'), '1:2:3:4:5:6:7::');
    assert.equal(ipv6.schema.safeParse('::ffff:01.2.3.4').success, false);
  }
}
