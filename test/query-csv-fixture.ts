import assert from 'node:assert/strict';
import { present } from './assertions.ts';
import type { Parameter } from './helpers.ts';
import type { RuntimeClient } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

type Reference = { $ref: string };
type ParameterEntry = Parameter | Reference;
const ref = (name: string): Reference => ({
  $ref: `#/components/parameters/${name}`,
});
const csv = (name: string, items: Schema, required = false): Parameter => ({
  name,
  in: 'query',
  style: 'form',
  explode: false,
  required,
  schema: { type: 'array', items },
});
const response = { 204: { description: 'Synthetic query accepted' } };

export const queryCsvSelection = {
  clients: ['consumer'],
  surfaces: {
    consumer: ['search', 'requiredSearch', 'repeatedSearch'],
    internal: ['internalSearch'],
  },
} as const;

export function queryCsvFixture() {
  const parameters: Record<string, ParameterEntry> = {
    Tags: {
      name: 'tags',
      in: 'query',
      explode: false,
      schema: { $ref: '#/components/schemas/Tags' },
    },
    TagsAlias: ref('Tags'),
    RequiredTags: { ...csv('tags', { type: 'string' }, true) },
    RequiredAlias: ref('RequiredTags'),
  };
  const schemas: Record<string, Schema> = {
    Tag: { type: 'string' },
    Tags: {
      type: 'array',
      items: { $ref: '#/components/schemas/Tag' },
      maxItems: 16,
    },
  };
  return {
    openapi: '3.1.1',
    info: { title: 'Synthetic comma-separated queries', version: '1' },
    components: { parameters, schemas },
    paths: {
      '/search': {
        parameters: [ref('TagsAlias')] as ParameterEntry[],
        get: {
          operationId: 'search',
          parameters: [
            csv('flags', { type: 'boolean' }),
            csv('ids', { type: 'integer', minimum: 0, maximum: 100 }),
            csv('numbers', { type: 'number' }),
            {
              name: 'repeat',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
            },
            { name: 'q', in: 'query', schema: { type: 'string' } },
            csv('x y,&=+%', { type: 'string' }),
            { name: 'after', in: 'query', schema: { type: 'string' } },
            {
              name: 'tail',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
            },
          ] as ParameterEntry[],
          responses: response,
        },
      },
      '/required': {
        get: {
          operationId: 'requiredSearch',
          parameters: [ref('RequiredAlias')] as ParameterEntry[],
          responses: response,
        },
      },
      '/repeated': {
        get: {
          operationId: 'repeatedSearch',
          parameters: [
            {
              name: 'tag',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
            },
            { name: 'q space', in: 'query', schema: { type: 'string' } },
          ] as ParameterEntry[],
          responses: response,
        },
      },
      '/internal': {
        get: {
          operationId: 'internalSearch',
          parameters: [] as ParameterEntry[],
          responses: response,
        },
      },
    },
  };
}

export const queryCsvConsumer = `
import { operations } from './client.consumer.ts';
export const search: typeof operations.search.build = operations.search.build;
search();
search({query:{tags:['a,b','c'],flags:[false,true],ids:[0,1],numbers:[1.5]}});
operations.requiredSearch.build({query:{tags:['']}});
// @ts-expect-error Required CSV arrays still require query input.
operations.requiredSearch.build();
// @ts-expect-error Array elements keep their declared primitive types.
search({query:{tags:[1]}});
// @ts-expect-error Integer schemas still expose number arrays.
search({query:{ids:['1']}});
// @ts-expect-error Nullable array items remain unsupported.
search({query:{flags:[null]}});
`;

export function verifyQueryCsv(client: RuntimeClient): void {
  const search = present(client.operations.search);
  const tags = ['a,b', 'a b', 'a+b', 'a&b', '%2C', '', "!'()*~", '雪🙂'];
  const input = {
    query: {
      tags,
      flags: [false, true],
      ids: [0, 100],
      numbers: [-1.5, 1e21, -0],
      repeat: ['a,b', 'a b', '+'],
      q: 'a b+~*',
      'x y,&=+%': ['one,two', 'three'],
      after: 'p2,+',
      tail: ['a b', 'c,d'],
    },
  };
  const before = structuredClone(input);
  const built = search.build(input);
  assert.deepEqual(input, before);
  assert.equal(
    built.url,
    '/search?tags=a%2Cb,a%20b,a%2Bb,a%26b,%252C,,%21%27%28%29%2A~,%E9%9B%AA%F0%9F%99%82' +
      '&flags=false,true&ids=0,100&numbers=-1.5,1e%2B21,0' +
      '&repeat=a%2Cb&repeat=a+b&repeat=%2B&q=a+b%2B%7E*' +
      '&x%20y%2C%26%3D%2B%25=one%2Ctwo,three' +
      // Keep scalar and repeated-key parameters after the final CSV segment.
      '&after=p2%2C%2B&tail=a+b&tail=c%2Cd',
  );
  // Split the raw delimiters before decoding: an element comma is data.
  const rawTags = present(built.url.split('?')[1]).split('&')[0]?.slice(5);
  assert.deepEqual(present(rawTags).split(',').map(decodeURIComponent), tags);
  tags[0] = 'changed';
  assert.ok(built.url.includes('tags=a%2Cb,'));
  for (const input of [undefined, {}, { query: {} }, { query: { tags: [] } }])
    assert.equal(search.build(input).url, '/search');
  assert.equal(
    search.build({ query: { tags: [], repeat: ['x'], q: 'y', 'x y,&=+%': [] } })
      .url,
    '/search?repeat=x&q=y',
  );
  for (const [tags, expected] of [
    [[''], 'tags='],
    [['', ''], 'tags=,'],
    [['', 'a', ''], 'tags=,a,'],
    [['a,b'], 'tags=a%2Cb'],
    [['a', 'b'], 'tags=a,b'],
  ] as const)
    assert.equal(search.build({ query: { tags } }).url, `/search?${expected}`);
  for (const query of [
    { tags: null },
    { tags: 'a,b' },
    { tags: [null] },
    { tags: [1] },
    { tags: ['\ud800'] },
    { ids: [-1] },
    { ids: [1.5] },
    { ids: [101] },
    { numbers: [Infinity] },
    { flags: ['true'] },
    { tags: Array.from({ length: 17 }, () => 'x') },
  ])
    assert.throws(() => search.build({ query }), client.RequestValidationError);
  const required = present(client.operations.requiredSearch);
  for (const input of [undefined, {}, { query: {} }, { query: { tags: [] } }])
    assert.throws(() => required.build(input), client.RequestValidationError);
  assert.equal(
    required.build({ query: { tags: [''] } }).url,
    '/required?tags=',
  );
  const repeated = present(client.operations.repeatedSearch);
  assert.equal(
    repeated.build({
      query: { tag: ['a,b', 'a b', '+', '~*'], 'q space': '!~' },
    }).url,
    '/repeated?tag=a%2Cb&tag=a+b&tag=%2B&tag=%7E*&q+space=%21%7E',
  );
}
