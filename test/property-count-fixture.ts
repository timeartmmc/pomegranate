import assert from 'node:assert/strict';
import { json, present } from './assertions.ts';
import type { Validator } from '../src/runtime.ts';
import type { RuntimeClient } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const ref = (name: string): Schema => ({
  $ref: `#/components/schemas/${name}`,
});
const names = {
  fixed: 'Fixed',
  alias: 'Alias',
  map: 'CountedMap',
  anyMap: 'AnyMap',
  nullable: 'Nullable',
  directional: 'Directional',
  wide: 'Wide',
  empty: 'Empty',
  nested: 'Nested',
  onlyRead: 'OnlyRead',
  onlyWrite: 'OnlyWrite',
} as const;

export function propertyCountFixture() {
  const schemas: Record<string, Schema> = {
    Fixed: {
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        c: { type: 'string' },
      },
      minProperties: 1,
      maxProperties: 3,
    },
    Middle: { ...ref('Fixed'), minProperties: 2 },
    Alias: { ...ref('Middle'), maxProperties: 2 },
    CountedMap: {
      type: 'object',
      additionalProperties: { type: 'integer', minimum: 0 },
      minProperties: 1,
      maxProperties: 2,
    },
    AnyMap: { type: 'object', minProperties: 1, maxProperties: 2 },
    Nullable: {
      type: ['object', 'null'],
      additionalProperties: { type: 'string' },
      minProperties: 1,
      maxProperties: 2,
    },
    Directional: {
      type: 'object',
      properties: {
        visible: { type: 'string' },
        id: { type: 'string', readOnly: true },
        secret: { type: 'string', writeOnly: true },
      },
      required: ['visible', 'id', 'secret'],
      minProperties: 1,
      maxProperties: 2,
    },
    Wide: {
      type: 'object',
      properties: Object.fromEntries(
        Array.from({ length: 140 }, (_, index) => [
          `field${index}`,
          { type: 'integer' },
        ]),
      ),
      minProperties: 1,
      maxProperties: 2,
    },
    Empty: { type: 'object', additionalProperties: false, maxProperties: 0 },
    Nested: {
      type: 'object',
      properties: { child: ref('Alias'), entries: ref('CountedMap') },
      required: ['child', 'entries'],
      minProperties: 2,
      maxProperties: 2,
    },
    OnlyRead: {
      type: 'object',
      properties: { id: { type: 'string', readOnly: true } },
      required: ['id'],
      minProperties: 1,
    },
    OnlyWrite: {
      type: 'object',
      properties: { secret: { type: 'string', writeOnly: true } },
      required: ['secret'],
      minProperties: 1,
    },
  };
  return {
    openapi: '3.1.1',
    info: { title: 'Synthetic object property bounds', version: '1' },
    components: { schemas },
    paths: Object.fromEntries(
      Object.entries(names).map(([operationId, schema]) => [
        `/${operationId}`,
        {
          post: {
            operationId,
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref(schema) } },
            },
            responses: {
              200: {
                description: 'Synthetic bounded object',
                content: { 'application/json': { schema: ref(schema) } },
              },
            },
          },
        },
      ]),
    ),
  };
}

export const propertyCountSelection = {
  clients: ['consumer'],
  surfaces: { consumer: Object.keys(names) },
  standalone: {
    request: { schema: '#/components/schemas/Directional', usage: 'request' },
    response: { schema: '#/components/schemas/Directional', usage: 'response' },
  },
} as const;

export interface PropertyCountSchemas {
  requestSchemas: Record<string, Validator<unknown>>;
  responseSchemas: Record<string, Validator<unknown>>;
}

export const propertyCountConsumer = `
import { operations } from './client.consumer.ts';
import { requestSchemas, responseSchemas } from './client.consumer.schemas.ts';
export const build: typeof operations.alias.build = operations.alias.build;
build({body:{a:'a',b:'b'}});
// Property bounds are runtime assertions, like minItems: object types stay structural.
build({body:{a:'a'}});
// @ts-expect-error Existing property types remain checked.
build({body:{a:1,b:'b'}});
operations.map.build({body:{a:1,b:2}});
// @ts-expect-error Map value types are retained with property bounds.
operations.map.build({body:{a:'1'}});
operations.nullable.build({body:null});
operations.directional.build({body:{visible:'visible',secret:'secret'}});
// @ts-expect-error Request projection still excludes read-only fields.
operations.directional.build({body:{visible:'visible',secret:'secret',id:'id'}});
export const request: typeof requestSchemas.Alias = requestSchemas.Alias;
export const response: typeof responseSchemas.Alias = responseSchemas.Alias;
`;

export function verifyPropertyCounts(
  client: RuntimeClient,
  schemas: PropertyCountSchemas,
): void {
  const valid: Record<string, unknown> = {
    fixed: { a: 'a' },
    alias: { a: 'a', b: 'b' },
    map: { one: 1, two: 2 },
    anyMap: { value: { nested: ['kept'] } },
    nullable: { one: 'one' },
    directional: { visible: 'visible', secret: 'secret' },
    wide: { field0: 0, field139: 139 },
    empty: {},
    nested: { child: { a: 'a', b: 'b' }, entries: { one: 1 } },
    onlyWrite: { secret: 'secret' },
  };
  for (const [name, body] of Object.entries(valid)) {
    const request = present(client.operations[name]).build({ body });
    assert.deepEqual(request.body, body);
    assert.notEqual(request.body, body);
  }
  for (const [name, bodies] of [
    [
      'fixed',
      [{}, { a: undefined }, { a: 'a', b: 'b', c: 'c', extra: 'extra' }],
    ],
    ['alias', [{ a: 'a' }, { a: 'a', b: 'b', c: 'c' }]],
    ['map', [{}, { one: 1, two: 2, three: 3 }, { one: -1 }]],
    ['anyMap', [{}, { one: 1, two: 2, three: 3 }]],
    ['nullable', [{}, { one: 'one', two: 'two', three: 'three' }]],
    ['wide', [{}, { field0: 0, field64: 64, field139: 139 }]],
    ['empty', [{ extra: 'extra' }]],
    ['onlyRead', [{}]],
    ['nested', [{ child: { a: 'a' }, entries: { one: 1 } }]],
  ] as const)
    for (const body of bodies)
      assert.throws(
        () => present(client.operations[name]).build({ body }),
        client.RequestValidationError,
        name,
      );
  assert.equal(
    present(client.operations.nullable).build({ body: null }).body,
    null,
  );
  const omitted = present(client.operations.alias).build({
    body: { a: undefined, b: 'b', c: 'c' },
  });
  const wire = json(JSON.stringify(omitted.body));
  assert.deepEqual(wire, { b: 'b', c: 'c' });
  assert.deepEqual(present(schemas.requestSchemas.Alias).parse(wire), wire);
  const observed = (name: string, body: unknown) =>
    present(client.operations[name]).parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const data = (name: string, body: unknown) => {
    const result = observed(name, body);
    assert.equal(result.kind, 'success');
    return result.data;
  };
  assert.equal(observed('alias', { unknown: 1, other: 2 }).kind, 'success');
  assert.deepEqual(data('alias', { unknown: 1, other: 2 }), {});
  assert.equal(observed('alias', { a: 'a' }).kind, 'protocol');
  assert.equal(
    observed('alias', { a: 'a', b: 'b', extra: 3 }).kind,
    'protocol',
  );
  assert.deepEqual(data('wide', { field139: 1 }), { field139: 1 });
  assert.equal(
    observed('wide', { field139: 1, extra: 2, third: 3 }).kind,
    'protocol',
  );
  assert.deepEqual(data('directional', { visible: 'visible', id: 'id' }), {
    visible: 'visible',
    id: 'id',
  });
  assert.equal(
    observed('directional', { visible: 'visible', id: 'id', secret: 7 }).kind,
    'protocol',
  );
  assert.equal(observed('onlyWrite', {}).kind, 'protocol');
  assert.deepEqual(data('onlyWrite', { secret: 7 }), {});
  const map = present(schemas.requestSchemas.CountedMap);
  const source = json('{"__proto__":1,"constructor":2}');
  const parsed = map.parse(source);
  assert.deepEqual(parsed, source);
  assert.notEqual(parsed, source);
  assert.equal(
    present(schemas.responseSchemas.AnyMap).safeParse({}).success,
    false,
  );
}
