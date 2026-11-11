import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import { identifier } from '../dist/code.js';
import { schemaRenderer } from '../dist/emit-schema.js';
import type { Schema as NormalizedSchema } from '../dist/model.js';
import { constraintRecord, schemaNode } from '../dist/schema-node.js';
import { parseSymbol, schemaType } from '../dist/schema-types.js';
import { entry } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

void test('container parser generation shares deep alias suffixes with linear table lookups', () => {
  const roots = [
    schemaNode({
      kind: 'array',
      items: schemaNode({ kind: 'string' }),
      maxItems: 4,
    }),
    schemaNode({
      kind: 'object',
      properties: new Map([['value', schemaNode({ kind: 'string' })]]),
      required: [],
      maxProperties: 4,
    }),
    schemaNode({
      kind: 'map',
      values: schemaNode({ kind: 'string' }),
      maxProperties: 4,
    }),
    schemaNode({ kind: 'map', values: true, maxProperties: 4 }),
  ];
  for (const root of roots) {
    function render(count: number): number {
      let lookups = 0;
      class CountedSchemas extends Map<string, NormalizedSchema> {
        override get(name: string) {
          lookups++;
          return super.get(name);
        }
      }
      const schemas = new CountedSchemas([['Root', root]]);
      let previous = 'Root';
      for (let index = 0; index < count; index++) {
        const name = `Alias${index}`;
        const limits =
          index % 4 === 0
            ? {}
            : root.kind === 'array'
              ? { minItems: 1, maxItems: 3 }
              : { minProperties: 1, maxProperties: 3 };
        const alias = schemaNode({
          kind: 'ref',
          name: previous,
          location: name,
          constraints: constraintRecord(limits),
        });
        // A normalized node may have several parser names. Sharing bounds must
        // not merge those bindings or rescan their already visited suffix.
        schemas.set(name, alias);
        schemas.set(`Twin${index}`, alias);
        previous = name;
      }
      const renderer = schemaRenderer(
        { request: schemas, response: schemas },
        (name, direction) => identifier(parseSymbol(name, direction)),
        (schema, direction) => schemaType(schema, direction),
      );
      for (const direction of ['request', 'response'] as const)
        // Encounter the deepest path first, then all shared prefixes and twins.
        for (const [name, schema] of [...schemas].reverse()) {
          const symbol = parseSymbol(name, direction);
          renderer.define(
            schema,
            direction,
            name,
            symbol,
            symbol,
            schemaType(schema, direction),
            false,
          );
        }
      assert.ok(renderer.takeDeclarations().length > 0);
      assert.ok(
        lookups <= 32 * schemas.size,
        `${root.kind} aliases used ${lookups} lookups for ${schemas.size} names`,
      );
      return lookups;
    }
    const small = render(128);
    const large = render(512);
    assert.ok(
      large <= small * 5,
      `${root.kind} alias lookup growth exceeded the declaration growth`,
    );
  }
});

const directionalValue: Schema = {
  type: 'object',
  properties: {
    id: { type: 'string', readOnly: true },
    secret: { type: 'string', writeOnly: true },
    label: { type: 'string' },
  },
  required: ['id', 'secret', 'label'],
};
const requestValue = () => ({ label: 'value', secret: 'request' });
const responseValue = () => ({
  label: 'value',
  id: 'response',
  secret: 'stripped',
});
const parsedValue = () => ({ label: 'value', id: 'response' });

type ContainerCase = Readonly<{
  name: string;
  schema: Schema;
  minimum: 'minItems' | 'minProperties';
  maximum: 'maxItems' | 'maxProperties';
  request: (count: number) => unknown;
  response: (count: number) => unknown;
  parsed: (count: number) => unknown;
  invalidRequest: unknown;
  invalidResponse: unknown;
}>;
const mapValues = (count: number, value: () => unknown) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`key${index}`, value()]),
  );
const fixedValue = (count: number, response: boolean) =>
  Object.fromEntries(
    (response
      ? ['label', 'secret', 'id', 'optional']
      : ['label', 'secret', 'optional', 'extra']
    )
      .slice(0, count)
      .map((key) => [key, key]),
  );
const cases: readonly ContainerCase[] = [
  {
    name: 'arrays',
    schema: { type: 'array', items: directionalValue, maxItems: 4 },
    minimum: 'minItems',
    maximum: 'maxItems',
    request: (count) => Array.from({ length: count }, requestValue),
    response: (count) => Array.from({ length: count }, responseValue),
    parsed: (count) => Array.from({ length: count }, parsedValue),
    invalidRequest: [{ label: 7, secret: 'request' }, requestValue()],
    invalidResponse: [{ label: 7, id: 'response' }, responseValue()],
  },
  {
    name: 'objects',
    schema: {
      type: 'object',
      properties: {
        ...directionalValue.properties,
        optional: { type: 'string' },
      },
      maxProperties: 4,
    },
    minimum: 'minProperties',
    maximum: 'maxProperties',
    request: (count) => fixedValue(count, false),
    response: (count) => fixedValue(count, true),
    parsed: (count) => {
      const value = fixedValue(count, true);
      delete value['secret'];
      return value;
    },
    invalidRequest: { label: 7, secret: 'request' },
    invalidResponse: { label: 7, id: 'response' },
  },
  {
    name: 'typedmaps',
    schema: {
      type: 'object',
      additionalProperties: directionalValue,
      maxProperties: 4,
    },
    minimum: 'minProperties',
    maximum: 'maxProperties',
    request: (count) => mapValues(count, requestValue),
    response: (count) => mapValues(count, responseValue),
    parsed: (count) => mapValues(count, parsedValue),
    invalidRequest: { key0: { label: 7 }, key1: requestValue() },
    invalidResponse: { key0: { label: 7 }, key1: responseValue() },
  },
  {
    name: 'jsonmaps',
    schema: {
      type: 'object',
      additionalProperties: true,
      maxProperties: 4,
    },
    minimum: 'minProperties',
    maximum: 'maxProperties',
    request: (count) => mapValues(count, () => ({ nested: [true, null] })),
    response: (count) => mapValues(count, () => ({ nested: [true, null] })),
    parsed: (count) => mapValues(count, () => ({ nested: [true, null] })),
    invalidRequest: { key0: { nested: undefined }, key1: null },
    invalidResponse: ['not', 'a map'],
  },
];

void test('container alias bounds retain directional and value validation at generated boundaries', async (t) => {
  const schemas: Record<string, Schema> = {};
  const selections: {
    id: string;
    schema: Schema;
    source: ContainerCase;
    minimum: number;
    maximum: number;
  }[] = [];
  const standalone: Record<
    string,
    { schema: string; usage: 'request' | 'response' }
  > = {};
  for (const source of cases) {
    const name = source.name;
    const base = `${name}Base`;
    const inner = `${name}Inner`;
    const outer = `${name}Outer`;
    const pure = `${name}Pure`;
    schemas[base] = source.schema;
    schemas[inner] = { ...ref(base), [source.minimum]: 2 };
    const shared = { ...ref(inner), [source.maximum]: 3 };
    schemas[outer] = shared;
    schemas[`${name}Twin`] = shared;
    schemas[pure] = ref(outer);
    schemas[`${name}Narrow`] = { ...ref(pure), [source.maximum]: 2 };
    schemas[`${name}Wide`] = { ...ref(pure), [source.minimum]: 3 };
    schemas[`${name}Zero`] = { ...ref(base), [source.maximum]: 0 };
    for (const [suffix, prefix, minimum, maximum] of [
      ['Narrow', 'a', 2, 2],
      ['Outer', 'z', 2, 3],
      ['Pure', 'b', 2, 3],
      ['Wide', 'm', 3, 3],
      ['Zero', 'c', 0, 0],
      ['Twin', 'd', 2, 3],
    ] as const) {
      const id = `${prefix}_${name}_${suffix.toLowerCase()}`;
      const root = `${name}${suffix}`;
      selections.push({ id, schema: ref(root), source, minimum, maximum });
      for (const usage of ['request', 'response'] as const)
        standalone[`${id}_${usage}`] = {
          schema: ref(root).$ref,
          usage,
        };
    }
  }
  const document = {
    openapi: '3.1.2',
    info: { title: 'Synthetic container alias boundaries', version: '1' },
    components: { schemas },
    paths: Object.fromEntries(
      selections.map(({ id, schema }) => [
        `/${id}`,
        {
          post: {
            operationId: id,
            requestBody: {
              required: true,
              content: { 'application/json': { schema } },
            },
            responses: {
              200: {
                description: 'Synthetic value',
                content: { 'application/json': { schema } },
              },
            },
          },
        },
      ]),
    ),
  };
  const options = {
    clients: ['consumer'],
    surfaces: { consumer: selections.map(({ id }) => id) },
    standalone,
  };
  const files = await compile(document, options);
  // Sharing source nodes is an input optimization, never a different contract.
  const copied: unknown = JSON.parse(JSON.stringify(document));
  assert.deepEqual(files, await compile(copied, options));
  const root = await generatedTestWorkspace(t, files);
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  for (const { id, source, minimum, maximum } of selections) {
    const operation = entry(client.operations, id);
    const request = await importGenerated<StandaloneModule>(
      root,
      `standalone.${id}_request.ts`,
    );
    const response = await importGenerated<StandaloneModule>(
      root,
      `standalone.${id}_response.ts`,
    );
    for (const count of [0, 1, 2, 3, 4]) {
      const accepted = count >= minimum && count <= maximum;
      const input = source.request(count);
      assert.equal(request.schema.safeParse(input).success, accepted, id);
      const observed = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(source.response(count)),
      };
      const parsed = operation.parseResponse(observed);
      assert.equal(parsed.kind, accepted ? 'success' : 'protocol', id);
      assert.equal(
        response.schema.safeParse(source.response(count)).success,
        accepted,
        id,
      );
      if (accepted) {
        const body = operation.build({ body: input }).body;
        assert.deepEqual(body, input, id);
        assert.notEqual(body, input, id);
        assert.ok(parsed.kind === 'success');
        assert.deepEqual(parsed.data, source.parsed(count), id);
        assert.deepEqual(
          response.schema.parse(source.response(count)),
          source.parsed(count),
        );
      } else
        assert.throws(
          () => operation.build({ body: input }),
          client.RequestValidationError,
        );
    }
    if (minimum === 2 && maximum === 3) {
      assert.equal(
        request.schema.safeParse(source.invalidRequest).success,
        false,
        id,
      );
      assert.throws(
        () => operation.build({ body: source.invalidRequest }),
        client.RequestValidationError,
      );
      assert.equal(
        response.schema.safeParse(source.invalidResponse).success,
        false,
        id,
      );
      assert.equal(
        operation.parseResponse({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(source.invalidResponse),
        }).kind,
        'protocol',
        id,
      );
    }
  }
  // Fixed response objects count the original payload before stripping the
  // write-only field; the parsed object may therefore have fewer members.
  const fixed = entry(client.operations, 'z_objects_outer');
  assert.deepEqual(
    fixed.build({ body: { label: 'value', secret: 'request' } }).body,
    {
      label: 'value',
      secret: 'request',
    },
  );
  assert.throws(
    () =>
      fixed.build({
        body: { label: 'value', secret: 'request', id: 'forbidden' },
      }),
    client.RequestValidationError,
  );
  const jsonMap = entry(client.operations, 'z_jsonmaps_outer');
  const input = { key0: { nested: [true, null] }, key1: { nested: [false] } };
  const snapshot = jsonMap.build({ body: input }).body;
  input.key0.nested[0] = false;
  assert.deepEqual(snapshot, {
    key0: { nested: [true, null] },
    key1: { nested: [false] },
  });
});
