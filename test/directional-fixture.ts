import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/query-core';
import type { FetchQueryOptions } from '@tanstack/query-core';
import type { ClientConfig } from '../src/execution-runtime.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';

export function directionalFixture() {
  const response = {
    description: 'Synthetic shared record',
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/Shared' } },
    },
  };
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic directional contracts', version: '1' },
    components: {
      schemas: {
        Id: { type: 'string', minLength: 1, readOnly: true },
        IdAlias: { $ref: '#/components/schemas/Id', readOnly: false },
        Secret: {
          type: 'string',
          minLength: 1,
          writeOnly: true,
          default: 'annotation',
        },
        SecretAlias: { $ref: '#/components/schemas/Secret', writeOnly: false },
        Shared: {
          type: 'object',
          properties: {
            id: { $ref: '#/components/schemas/IdAlias' },
            secret: { $ref: '#/components/schemas/SecretAlias' },
            label: { type: 'string', minLength: 1 },
            nested: {
              type: 'object',
              properties: {
                id: { type: 'string', readOnly: true },
                password: { type: 'string', writeOnly: true },
                label: { type: 'string' },
              },
              required: ['id', 'password', 'label'],
            },
          },
          required: ['id', 'secret', 'label', 'nested'],
        },
        OnlyRead: {
          type: 'object',
          properties: { id: { $ref: '#/components/schemas/Id' } },
          required: ['id'],
        },
        OnlyWrite: {
          type: 'object',
          properties: { secret: { $ref: '#/components/schemas/Secret' } },
          required: ['secret'],
        },
      },
    },
    paths: {
      '/records': {
        post: {
          operationId: 'save',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Shared' },
              },
            },
          },
          responses: { 200: response },
        },
      },
      '/records/current': {
        get: { operationId: 'read', responses: { 200: response } },
      },
    },
  };
}
export const directionalSelection = {
  clients: ['consumer'],
  surfaces: { consumer: ['save', 'read'] },
  executionClients: ['consumer'],
  queries: { consumer: ['read'] },
  standalone: {
    request: { schema: '#/components/schemas/Shared', usage: 'request' },
    response: { schema: '#/components/schemas/Shared', usage: 'response' },
    'empty-request': {
      schema: '#/components/schemas/OnlyRead',
      usage: 'request',
    },
    'empty-response': {
      schema: '#/components/schemas/OnlyWrite',
      usage: 'response',
    },
  },
} as const;

type Calls = {
  save: {
    call(args: {
      context: Record<string, string>;
      input: unknown;
    }): Promise<{ data: unknown }>;
  };
};
type Family = {
  options(args: {
    context: Record<string, string>;
  }): FetchQueryOptions<unknown>;
};
export interface DirectionalClient extends RuntimeClient {
  createClient(config: ClientConfig): Calls;
}
export interface DirectionalQueries {
  createQueries(config: ClientConfig): { read: Family & { body(): Family } };
}
export async function verifyDirectional(
  client: DirectionalClient,
  queries: DirectionalQueries,
  request: StandaloneModule,
  response: StandaloneModule,
  emptyRequest: StandaloneModule,
  emptyResponse: StandaloneModule,
): Promise<void> {
  const input = {
    label: 'visible',
    secret: 'private',
    nested: { label: 'nested', password: 'private' },
  };
  const observed = {
    id: 'record-id',
    label: 'visible',
    secret: { invalid: true },
    nested: { id: 'nested-id', label: 'nested', password: { invalid: true } },
    extra: 'strip',
  };
  const expected = {
    id: 'record-id',
    label: 'visible',
    nested: { id: 'nested-id', label: 'nested' },
  };
  assert.deepEqual(request.schema.parse(input), input);
  assert.equal(
    request.schema.safeParse({ ...input, id: undefined }).success,
    false,
  );
  assert.equal(
    request.schema.safeParse({ label: 'visible', nested: input.nested })
      .success,
    false,
  );
  assert.deepEqual(response.schema.parse(observed), expected);
  assert.equal(
    response.schema.safeParse({ label: 'visible', nested: observed.nested })
      .success,
    false,
  );
  assert.deepEqual(emptyRequest.schema.parse({}), {});
  assert.equal(
    emptyRequest.schema.safeParse({ id: 'forbidden' }).success,
    false,
  );
  const unread = Object.defineProperty({}, 'secret', {
    get() {
      throw new Error('Stripped value must not be read');
    },
    enumerable: true,
  });
  assert.deepEqual(emptyResponse.schema.parse(unread), {});
  const save = client.operations.save;
  assert.ok(save);
  const built = save.build({ body: input });
  assert.deepEqual(built.body, input);
  assert.throws(
    () => save.build({ body: { ...input, id: 'forbidden' } }),
    client.RequestValidationError,
  );
  const raw = {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(observed),
  };
  const parsed = built.parseResponse(raw);
  assert.equal(parsed.kind, 'success');
  assert.ok('data' in parsed);
  assert.deepEqual(parsed.data, expected);
  for (const scoped of [false, true]) {
    const config: ClientConfig = {
      namespace: `direction-${scoped}`,
      execute: async (_prepared, execution) =>
        scoped ? execution.validateResponse(raw) : raw,
    };
    const api = client.createClient(config);
    assert.deepEqual(
      (
        await api.save.call({
          context: { revision: 'synthetic' },
          input: { body: input },
        })
      ).data,
      expected,
    );
    const family = queries.createQueries(config).read;
    const cache = new QueryClient();
    try {
      const envelope = await cache.fetchQuery(
        family.options({ context: { revision: 'synthetic' } }),
      );
      assert.ok(
        envelope !== null && typeof envelope === 'object' && 'data' in envelope,
      );
      assert.deepEqual(envelope.data, expected);
      assert.deepEqual(
        await cache.fetchQuery(
          family.body().options({ context: { revision: 'synthetic' } }),
        ),
        expected,
      );
    } finally {
      cache.clear();
    }
  }
}

export function directionalTypeConsumer(): string {
  return `
  import {operations, createClient} from './directional-generated/client.consumer.ts';
  import type {RequestTypes, ResponseTypes} from './directional-generated/client.consumer.ts';
  import {schema as request} from './directional-generated/standalone.request.ts';
  import {schema as response} from './directional-generated/standalone.response.ts';
  export type Request = RequestTypes['Shared'];
  export type Response = ResponseTypes['Shared'];
  export const build: typeof operations.save.build = operations.save.build;
  export const parseRequest: typeof request.parse = request.parse;
  export const parseResponse: typeof response.parse = response.parse;
  const input: Request = {label:'visible',secret:'private',nested:{label:'nested',password:'private'}};
  const output: Response = {id:'id',label:'visible',nested:{id:'nested',label:'nested'}};
  build({body:input});
  // @ts-expect-error Read-only fields are absent from input.
  input.id;
  // @ts-expect-error Write-only fields are absent from output.
  output.secret;
  // @ts-expect-error Nested write-only fields are absent from output.
  output.nested.password;
  // @ts-expect-error Required write-only input is still required.
  const missingInput: Request = {label:'visible',nested:input.nested};
  // @ts-expect-error Required read-only output is still required.
  const missingOutput: Response = {label:'visible',nested:output.nested};
  void [missingInput,missingOutput];
  export const api: ReturnType<typeof createClient> = createClient({namespace:'types',execute:async()=>({status:200,headers:{'Content-Type':'application/json'},body:'{}'})});
  `;
}
