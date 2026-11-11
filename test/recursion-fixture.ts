import assert from 'node:assert/strict';
import { entry, present, record } from './assertions.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import type { Validator } from '../src/runtime.ts';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const content = (name: string) => ({
  'application/json': { schema: ref(name) },
});
const response = (name: string) => ({
  200: { description: 'Synthetic recursive value', content: content(name) },
});

export function recursionFixture(openapi = '3.1.2') {
  return {
    openapi,
    info: { title: 'Synthetic recursive contracts', version: '1' },
    components: {
      schemas: {
        Tree: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1, readOnly: true },
            secret: { type: 'string', minLength: 1, writeOnly: true },
            value: { type: 'integer', minimum: 0 },
            payload: {},
            next: ref('TreeAlias'),
            children: { type: 'array', items: ref('TreeAlias') },
          },
          required: ['id', 'secret', 'value'],
        },
        TreeAlias: ref('Tree'),
        TreeSummary: {
          type: 'object',
          properties: { value: { type: 'integer' } },
          required: ['value'],
        },
        TreeOrSummary: { anyOf: [ref('TreeAlias'), ref('TreeSummary')] },
        MutualA: {
          type: 'object',
          properties: { name: { type: 'string' }, b: ref('MutualB') },
          required: ['name'],
        },
        MutualB: {
          type: 'object',
          properties: { enabled: { type: 'boolean' }, a: ref('MutualA') },
          required: ['enabled'],
        },
        RecursiveArray: { type: 'array', items: ref('RecursiveArray') },
        RecursiveMap: {
          type: 'object',
          additionalProperties: ref('RecursiveMap'),
        },
        NullableArray: {
          type: openapi.startsWith('3.0.') ? 'array' : ['array', 'null'],
          ...(openapi.startsWith('3.0.') ? { nullable: true } : {}),
          items: ref('NullableArray'),
        },
        Literal: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['literal'] },
            value: { type: 'integer' },
          },
          required: ['kind', 'value'],
        },
        Group: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['group'] },
            children: { type: 'array', items: ref('Expression') },
          },
          required: ['kind', 'children'],
        },
        Expression: {
          oneOf: [ref('Literal'), ref('Group')],
          discriminator: {
            propertyName: 'kind',
            mapping: {
              literal: '#/components/schemas/Literal',
              group: '#/components/schemas/Group',
            },
          },
        },
      },
    },
    paths: {
      '/tree': {
        post: {
          operationId: 'saveTree',
          requestBody: { required: true, content: content('TreeAlias') },
          responses: response('TreeAlias'),
        },
      },
      '/tree-or-summary': {
        post: {
          operationId: 'saveTreeOrSummary',
          requestBody: { required: true, content: content('TreeOrSummary') },
          responses: response('TreeOrSummary'),
        },
      },
      '/mutual': {
        get: { operationId: 'getMutual', responses: response('MutualA') },
      },
      '/array': {
        get: { operationId: 'getArray', responses: response('RecursiveArray') },
      },
      '/map': {
        get: { operationId: 'getMap', responses: response('RecursiveMap') },
      },
      '/nullable': {
        get: {
          operationId: 'getNullable',
          responses: response('NullableArray'),
        },
      },
      '/expression': {
        get: {
          operationId: 'getExpression',
          responses: response('Expression'),
        },
      },
    },
  };
}

export const recursionSelection = {
  clients: ['consumer'],
  surfaces: {
    consumer: [
      'saveTree',
      'saveTreeOrSummary',
      'getMutual',
      'getArray',
      'getMap',
      'getNullable',
      'getExpression',
    ],
  },
  standalone: {
    request: { schema: '#/components/schemas/TreeAlias', usage: 'request' },
    response: { schema: '#/components/schemas/TreeAlias', usage: 'response' },
    'union-request': {
      schema: '#/components/schemas/TreeOrSummary',
      usage: 'request',
    },
    'union-response': {
      schema: '#/components/schemas/TreeOrSummary',
      usage: 'response',
    },
    mutual: { schema: '#/components/schemas/MutualA', usage: 'request' },
    array: { schema: '#/components/schemas/RecursiveArray', usage: 'request' },
    map: { schema: '#/components/schemas/RecursiveMap', usage: 'request' },
    nullable: {
      schema: '#/components/schemas/NullableArray',
      usage: 'request',
    },
    expression: {
      schema: '#/components/schemas/Expression',
      usage: 'response',
    },
  },
} as const;

export const recursionConsumer = `
import {operations} from './client.consumer.ts';
import type {RequestTypes, ResponseTypes} from './client.consumer.ts';
import {schema as request} from './standalone.request.ts';
import type {Input as ArrayInput} from './standalone.array.ts';
import type {Input as MapInput} from './standalone.map.ts';
import type {Input as NullableInput} from './standalone.nullable.ts';
const input: RequestTypes['TreeAlias'] = {secret:'root',value:1,next:{secret:'leaf',value:2}};
operations.saveTree.build({body:input});
const standalone: RequestTypes['TreeAlias'] = request.parse(input);
const output: ResponseTypes['TreeAlias'] = {id:'root',value:1,children:[{id:'leaf',value:2}]};
const nestedId: string | undefined = output.children?.[0]?.id;
const arrays: ArrayInput = [[],[[]]];
const map: MapInput = {branch:{leaf:{}}};
const nullable: NullableInput = [null,[],[null]];
function expression(value: ResponseTypes['Expression']): number {
  return value.kind === 'literal' ? value.value : value.children.length;
}
const mutual: ResponseTypes['MutualA'] = {name:'outer',b:{enabled:true,a:{name:'inner'}}};
// @ts-expect-error Directional projection forbids nested readOnly input fields.
operations.saveTree.build({body:{secret:'root',value:1,next:{id:'forbidden',secret:'leaf',value:2}}});
// @ts-expect-error Required fields remain required at recursive request positions.
const missing: RequestTypes['TreeAlias'] = {secret:'root',value:1,next:{value:2}};
// @ts-expect-error Recursive maps retain map-valued children.
const wrongMap: MapInput = {branch:1};
// @ts-expect-error Recursive arrays retain array-valued children.
const wrongArray: ArrayInput = [1];
// @ts-expect-error Recursive union tags still select their branch's data.
const wrongExpression: ResponseTypes['Expression'] = {kind:'literal',children:[]};
void [standalone,output,nestedId,arrays,map,nullable,expression,mutual,missing,wrongMap,wrongArray,wrongExpression];
`;

export interface RecursionSchemas {
  requestSchemas: Readonly<Record<string, Validator<unknown>>>;
  responseSchemas: Readonly<Record<string, Validator<unknown>>>;
}

export function verifyRecursion(
  client: RuntimeClient,
  schemas: RecursionSchemas,
  roots: Readonly<Record<string, StandaloneModule>>,
): void {
  verifyRecursiveUnionAborts(client, roots);
  const request = entry(roots, 'request').schema;
  const responseSchema = entry(roots, 'response').schema;
  assert.equal(
    entry(schemas.requestSchemas, 'TreeAlias'),
    entry(schemas.requestSchemas, 'Tree'),
  );
  assert.equal(
    entry(schemas.responseSchemas, 'TreeAlias'),
    entry(schemas.responseSchemas, 'Tree'),
  );
  const leaf = { secret: 'leaf', value: 2 };
  const input = { secret: 'root', value: 1, children: [leaf, leaf] };
  const operation = present(client.operations.saveTree);
  const prepared = operation.build({ body: input });
  assert.deepEqual(prepared.body, input);
  const children = record(prepared.body).children;
  assert.ok(Array.isArray(children));
  assert.notEqual(children, input.children);
  assert.notEqual(children[0], leaf);
  assert.notEqual(children[0], children[1]);
  const parsed = request.parse(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed, input);
  leaf.value = 10;
  assert.equal(record(children[0]).value, 2);
  assert.equal(
    request.safeParse({
      secret: 'root',
      value: 1,
      next: { secret: 'leaf', value: -1 },
    }).success,
    false,
  );
  assert.equal(
    request.safeParse({
      secret: 'root',
      value: 1,
      next: { id: 'forbidden', secret: 'leaf', value: 2 },
    }).success,
    false,
  );
  const observed = {
    id: 'root',
    secret: false,
    value: 1,
    next: { id: 'leaf', secret: false, value: 2, extra: true },
    extra: true,
  };
  const expected = { id: 'root', value: 1, next: { id: 'leaf', value: 2 } };
  assert.deepEqual(responseSchema.parse(observed), expected);
  const response = operation.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(observed),
  });
  assert.equal(response.kind, 'success');
  if (response.kind === 'success') assert.deepEqual(response.data, expected);

  const mutual = { name: 'outer', b: { enabled: true, a: { name: 'inner' } } };
  const arrays = [[], [[]]];
  const map = { branch: { leaf: {} } };
  const nullable = [null, [], [null]];
  const expression = {
    kind: 'group',
    children: [
      { kind: 'literal', value: 1 },
      { kind: 'group', children: [] },
    ],
  };
  for (const [name, id, value] of [
    ['mutual', 'getMutual', mutual],
    ['array', 'getArray', arrays],
    ['map', 'getMap', map],
    ['nullable', 'getNullable', nullable],
    ['expression', 'getExpression', expression],
  ] as const) {
    const schema = entry(roots, name).schema;
    const output = schema.parse(value);
    assert.deepEqual(output, value);
    assert.notEqual(output, value);
    const result = present(client.operations[id]).parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    assert.equal(result.kind, 'success');
    if (result.kind === 'success') assert.deepEqual(result.data, value);
  }
  assert.equal(
    entry(roots, 'map').schema.safeParse({ branch: 1 }).success,
    false,
  );
  assert.equal(entry(roots, 'array').schema.safeParse([1]).success, false);
  assert.equal(entry(roots, 'nullable').schema.parse(null), null);
  assert.equal(
    entry(roots, 'expression').schema.safeParse({
      kind: 'group',
      children: [{ kind: 'literal', value: 'bad' }],
    }).success,
    false,
  );
  const cyclic: Record<string, unknown> = { secret: 'root', value: 1 };
  cyclic.next = cyclic;
  const failure = request.safeParse(cyclic);
  assert.equal(failure.success, false);
  if (!failure.success) assert.match(failure.error.message, /cycl|circular/i);
  assert.throws(
    () => operation.build({ body: cyclic }),
    client.RequestValidationError,
  );
  assert.deepEqual(request.parse({ secret: 'after-failure', value: 1 }), {
    secret: 'after-failure',
    value: 1,
  });

  const child = { items: [1] };
  const withJson = {
    secret: 'json',
    value: 1,
    payload: { left: child, right: child },
  };
  const detached = record(record(request.parse(withJson)).payload);
  assert.deepEqual(detached, withJson.payload);
  assert.notEqual(detached.left, child);
  assert.notEqual(detached.left, detached.right);

  let deep: unknown = 0;
  for (let level = 0; level < 140; level++) deep = [deep];
  let shared: object = { value: 1 };
  for (let level = 0; level < 17; level++)
    shared = { left: shared, right: shared };
  for (const [payload, message] of [
    [deep, /depth exceeds 128/],
    [Array(100005).fill(0), /work exceeds 100000/],
    [shared, /work exceeds 100000/],
  ] as const) {
    const input = { secret: 'json', value: 1, payload };
    const output = { id: 'json', value: 1, payload };
    for (const [schema, value] of [
      [request, input],
      [responseSchema, output],
    ] as const) {
      const failure = schema.safeParse(value);
      assert.equal(failure.success, false);
      if (!failure.success) assert.match(failure.error.message, message);
    }
    assert.throws(
      () => operation.build({ body: input }),
      (error) => {
        assert.ok(error instanceof client.RequestValidationError);
        assert.match(error.message, message);
        return true;
      },
    );
    const observed = operation.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(output),
    });
    assert.equal(observed.kind, 'protocol');
    if (observed.kind === 'protocol')
      assert.ok(observed.issues.some((issue) => message.test(issue.message)));
    assert.deepEqual(request.parse(withJson), withJson);
  }
}

export function verifyRecursiveUnionAborts(
  client: RuntimeClient,
  roots: Readonly<Record<string, StandaloneModule>>,
): void {
  const operation = present(client.operations.saveTreeOrSummary);
  for (const direction of ['request', 'response'] as const) {
    const schema = entry(roots, `union-${direction}`).schema;
    const leaf =
      direction === 'request'
        ? { secret: 'node', value: 1 }
        : { id: 'node', value: 1 };
    let deep: object = leaf;
    for (let level = 0; level < 70; level++)
      deep = { ...leaf, children: [deep] };
    const cyclic: Record<string, unknown> = { ...leaf };
    cyclic.children = [cyclic];
    const payload: Record<string, unknown> = {};
    payload.self = payload;
    const samples: readonly (readonly [object, RegExp])[] = [
      [deep, /depth exceeds 128/],
      [cyclic, /cyclic input/],
      [{ ...leaf, payload }, /cyclic input/],
      [{ ...leaf, payload: Array(100_005).fill(0) }, /work exceeds 100000/],
    ];
    for (const [value, cause] of samples) {
      const failure = schema.safeParse(value);
      assert.equal(failure.success, false);
      if (!failure.success) {
        assert.deepEqual(failure.error.issues[0]?.path, []);
        assert.match(present(failure.error.issues[0]).message, cause);
      }
      if (direction === 'request')
        assert.throws(
          () => operation.build({ body: value }),
          (error) => {
            assert.ok(error instanceof client.RequestValidationError);
            assert.deepEqual(error.issues[0]?.path, ['body']);
            assert.match(present(error.issues[0]).message, cause);
            return true;
          },
        );
      else if (
        value !== cyclic &&
        !('payload' in value && value.payload === payload)
      ) {
        const result = operation.parseResponse({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(value),
        });
        assert.equal(result.kind, 'protocol');
        if (result.kind === 'protocol')
          assert.match(present(result.issues[0]).message, cause);
      }
      assert.deepEqual(schema.parse(leaf), leaf);
    }
    // A proven shape mismatch can still select the summary. It must not be
    // confused with an aborted attempt whose preferred projection is unknown.
    assert.deepEqual(schema.parse({ value: 2 }), { value: 2 });
  }
  const responseSchema = entry(roots, 'union-response').schema;
  for (const payload of [new Date(0), 1n])
    assert.deepEqual(responseSchema.parse({ id: 'node', value: 1, payload }), {
      value: 1,
    });
  const ordinary = operation.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'node', value: 1, children: [{ value: -1 }] }),
  });
  assert.equal(ordinary.kind, 'success');
  if (ordinary.kind === 'success')
    assert.deepEqual(ordinary.data, { value: 1 });
}
