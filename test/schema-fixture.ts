import assert from 'node:assert/strict';
import type { ZodType } from 'zod';
import type { CompileOptions } from '../dist/index.js';
import {
  entry,
  json,
  member,
  present,
  presentObject,
  record,
  runtimeInput,
} from './assertions.ts';
import {
  nullableTypeCases,
  nullableTypeSchemas,
} from './nullable-type-fixture.ts';
import { ref, object, nullable } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

type Operations =
  typeof import('./.generated/schema/client.samples.ts').operations;
type ValidationError =
  typeof import('./.generated/schema/client.samples.ts').RequestValidationError;
type Scalars =
  import('./.generated/schema/client.samples.ts').RequestTypes['Scalars'];

export const standaloneSelection: NonNullable<CompileOptions['standalone']> = {
  message: { schema: '#/components/schemas/1.Shape', usage: 'response' },
  input: { schema: '#/components/schemas/Defaults', usage: 'request' },
};

const content = (schema: Schema) => ({ 'application/json': { schema } });

export function schemaFixture() {
  const schemas = {
    ...structuredClone(nullableTypeSchemas),
    Empty: { type: 'object', additionalProperties: false },
    EmptyContainers: object({
      child: ref('Empty'),
      inline: { type: 'object', properties: {} },
      array: { type: 'array', items: ref('Empty') },
      map: { type: 'object', additionalProperties: ref('Empty') },
    }),
    'A-B': { type: 'string', const: 'hyphen' },
    A_hB: { type: 'number', const: 7 },
    'A.B': { type: 'boolean', const: true },
    A_dB: { type: 'null' },
    A_B: { type: 'string', const: 'underscore' },
    A_uB: { type: 'integer', const: 3 },
    EscapedNames: object(
      Object.fromEntries(
        ['A-B', 'A_hB', 'A.B', 'A_dB', 'A_B', 'A_uB'].map((name) => [
          name,
          ref(name),
        ]),
      ),
    ),
    Label: { type: 'string', enum: ['red', 'blue', 'green'] },
    ShortLabel: { ...ref('Label'), maxLength: 4, pattern: '^(red|blue)$' },
    Circle: object({
      kind: { type: 'string', const: 'circle' },
      radius: {
        type: 'number',
        exclusiveMinimum: 0,
        exclusiveMaximum: 10,
        multipleOf: 0.25,
      },
    }),
    Rectangle: object({
      kind: { type: 'string', const: 'rectangle' },
      width: { type: 'integer', minimum: 1, maximum: 10 },
    }),
    'Shape-Circle': ref('Circle'),
    'Shape.Circle': ref('Rectangle'),
    Shape_Circle: { type: 'boolean' },
    NamedComponents: object({
      hyphen: ref('Shape-Circle'),
      period: ref('Shape.Circle'),
      underscore: ref('Shape_Circle'),
    }),
    Shape: {
      oneOf: [ref('Shape-Circle'), ref('Shape.Circle')],
      discriminator: {
        propertyName: 'kind',
        mapping: {
          circle: '#/components/schemas/Shape-Circle',
          rectangle: '#/components/schemas/Shape.Circle',
        },
      },
    },
    NullableShape: nullable(ref('Shape')),
    '1.Shape': ref('NullableShape'),
    ShapeMap: { type: 'object', additionalProperties: ref('NullableShape') },
    JsonMap: { type: 'object', additionalProperties: true },
    TinyMultiple: { type: 'number', multipleOf: 1e-309 },
    SmallMultiple: { type: 'number', multipleOf: 2.5e-10 },
    HugeMultiple: { type: 'number', multipleOf: 1e21 },
    DecimalMultiple: { type: 'number', multipleOf: 0.1 },
    Location: {
      type: 'array',
      items: {
        anyOf: [
          { type: 'string', minLength: 1 },
          { type: 'integer', minimum: 0 },
        ],
      },
    },
    ShortLocation: { ...ref('Location'), minItems: 1, maxItems: 2 },
    Scalars: object({
      date: { type: 'string', format: 'date' },
      instant: { type: 'string', format: 'date-time' },
      id: { type: 'string', format: 'uuid' },
      code: { type: 'string', pattern: '^.$', minLength: 1, maxLength: 1 },
      label: ref('ShortLabel'),
    }),
    QueryCursor: {
      type: 'string',
      minLength: 1,
      maxLength: 8,
      pattern: '^[a-z]+$',
    },
    QueryCount: { type: 'integer', minimum: 0, maximum: 10 },
    NullableQueryCount: { anyOf: [{ type: 'null' }, ref('QueryCount')] },
    QueryInstant: { type: 'string', format: 'date-time' },
    Defaults: object(
      {
        required: { type: 'boolean', default: true },
        count: { type: 'integer', default: 4 },
        selection: { ...nullable(ref('Shape')), default: null },
        nested: {
          ...object({ enabled: { type: 'boolean', default: true } }, []),
          default: {},
        },
      },
      ['required'],
    ),
    DefaultsResponse: object(
      { required: { type: 'boolean' }, count: { type: 'integer' } },
      ['required', 'count'],
    ),
  };
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic schema milestone', version: '1' },
    'x-pom-policy': {
      version: 2,
      auth: { public: { transport: 'none' } },
      retry: ['never'],
      timeout: ['interactive'],
      surfaces: ['samples'],
    },
    components: { schemas },
    paths: Object.fromEntries(
      [
        ...nullableTypeCases.map(({ name }) => name),
        'NamedComponents',
        'Empty',
        'EmptyContainers',
        'EscapedNames',
        'Shape',
        'NullableShape',
        'ShapeMap',
        'JsonMap',
        'TinyMultiple',
        'SmallMultiple',
        'HugeMultiple',
        'DecimalMultiple',
        'Location',
        'ShortLocation',
        'Scalars',
        'Defaults',
      ].map((name) => [
        `/samples/${name}`,
        {
          post: {
            operationId: `check${name}`,
            'x-pom': {
              auth: 'public',
              retry: 'never',
              timeout: 'interactive',
              surfaces: ['samples'],
            },
            parameters: [
              ...(name === 'Location'
                ? [
                    {
                      name: 'index',
                      in: 'query',
                      required: true,
                      schema: { type: 'array', items: { type: 'integer' } },
                    },
                  ]
                : []),
              {
                name: 'limit',
                in: 'query',
                schema: { type: 'integer', minimum: 1, default: 4 },
              },
              ...(name === 'Scalars'
                ? [
                    {
                      name: 'tags',
                      in: 'query',
                      schema: {
                        type: 'array',
                        maxItems: 4,
                        items: { type: 'string', minLength: 1 },
                      },
                    },
                    {
                      name: 'X-Note',
                      in: 'header',
                      schema: nullable({ type: 'string', minLength: 1 }),
                    },
                    {
                      name: 'X-Origin',
                      in: 'header',
                      required: true,
                      schema: { type: 'string', enum: ['desktop', 'native'] },
                    },
                    ...Object.entries({
                      q: nullable({ type: 'string' }),
                      cursor: nullable(ref('QueryCursor')),
                      count: { ...ref('NullableQueryCount'), default: 4 },
                      ratio: nullable({
                        type: 'number',
                        minimum: 0,
                        exclusiveMaximum: 1,
                        multipleOf: 0.25,
                      }),
                      active: nullable({ type: 'boolean' }),
                      date: nullable({ type: 'string', format: 'date' }),
                      instant: nullable(ref('QueryInstant')),
                      id: nullable({ type: 'string', format: 'uuid' }),
                    }).map(([name, schema]) => ({ name, in: 'query', schema })),
                  ]
                : []),
            ],
            requestBody: { required: true, content: content(ref(name)) },
            responses: {
              200: {
                description: 'Echo',
                content: content(
                  ref(name === 'Defaults' ? 'DefaultsResponse' : name),
                ),
              },
            },
          },
        },
      ]),
    ),
  };
}

export function verifySchemas(
  operations: Operations,
  RequestValidationError: ValidationError,
) {
  const response = (name: string, value: unknown) =>
    entry(operations, `check${name}`).parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  const data = (name: string, value: unknown) => {
    const result = response(name, value);
    assert.equal(result.kind, 'success');
    return result.data;
  };
  const check = (name: string, value: unknown, accepted: boolean) => {
    const build = () =>
      runtimeInput(entry(operations, `check${name}`).build, {
        body: value,
        ...(name === 'Location' ? { query: { index: [0] } } : {}),
      });
    if (accepted) assert.deepEqual(build().body, value);
    else assert.throws(build, RequestValidationError);
    assert.equal(
      response(name, value).kind,
      accepted ? 'success' : 'protocol',
      `${name}: ${JSON.stringify(value)}`,
    );
  };
  for (const { name, samples } of nullableTypeCases)
    for (const [value, accepted] of samples) check(name, value, accepted);
  check('Empty', {}, true);
  for (const value of [42, false, 'text', null, []])
    check('Empty', value, false);
  assert.throws(
    () => runtimeInput(operations.checkEmpty.build, { body: { extra: true } }),
    RequestValidationError,
  );
  assert.deepEqual(data('Empty', { extra: true }), {});
  check(
    'EmptyContainers',
    { child: {}, inline: {}, array: [{}], map: { first: {} } },
    true,
  );
  check(
    'EmptyContainers',
    { child: 42, inline: false, array: [1], map: { first: null } },
    false,
  );
  const escaped = {
    'A-B': 'hyphen',
    A_hB: 7,
    'A.B': true,
    A_dB: null,
    A_B: 'underscore',
    A_uB: 3,
  };
  check('EscapedNames', escaped, true);
  check('EscapedNames', { ...escaped, A_hB: 'hyphen' }, false);
  for (const value of [0, 1e-309, 2e-309, -1e-309])
    check('TinyMultiple', value, true);
  check('TinyMultiple', 5e-310, false);
  for (const value of [0, 2.5e-10, 5e-10, 1])
    check('SmallMultiple', value, true);
  check('SmallMultiple', 1e-10, false);
  for (const value of [0, 1e21, -2e21]) check('HugeMultiple', value, true);
  check('HugeMultiple', 1, false);
  check('DecimalMultiple', 0.3, true);
  check('DecimalMultiple', 0.30000000000000004, false);
  const named = {
    hyphen: { kind: 'circle', radius: 1 },
    period: { kind: 'rectangle', width: 2 },
    underscore: true,
  };
  check('NamedComponents', named, true);
  check('NamedComponents', { ...named, hyphen: named.period }, false);
  check('NamedComponents', { ...named, period: named.hyphen }, false);
  check('NamedComponents', { ...named, underscore: named.hyphen }, false);
  for (const value of [
    { kind: 'circle', radius: 0.25 },
    { kind: 'rectangle', width: 2 },
  ])
    check('Shape', value, true);
  class CircleInput {
    kind = 'circle';
    radius = 1;
  }
  for (const value of [
    new CircleInput(),
    Object.create({ kind: 'circle', radius: 1 }) as unknown,
  ]) {
    const built = runtimeInput(operations.checkShape.build, { body: value });
    assert.equal(Object.getPrototypeOf(built.body), Object.prototype);
    assert.deepEqual(built.body, { kind: 'circle', radius: 1 });
    record(value).radius = -1;
    assert.equal(built.body.radius, 1);
    assert.throws(
      () => runtimeInput(operations.checkShape.build, { body: value }),
      RequestValidationError,
    );
  }
  class MapInput {
    north = { kind: 'circle', radius: 1 };
  }
  assert.throws(
    () =>
      runtimeInput(operations.checkShapeMap.build, { body: new MapInput() }),
    RequestValidationError,
  );
  for (const value of [
    { kind: 'circle', radius: 0 },
    { kind: 'circle', radius: 10 },
    { kind: 'circle', radius: 0.3 },
    { kind: 'rectangle', width: 1.5 },
    { kind: 'triangle', radius: 1 },
    { radius: 1 },
    { kind: 'circle', width: 1 },
  ])
    check('Shape', value, false);
  assert.throws(
    () =>
      runtimeInput(operations.checkShape.build, {
        body: { kind: 'circle', radius: 1, extra: 1 },
      }),
    RequestValidationError,
  );
  assert.deepEqual(data('Shape', { kind: 'circle', radius: 1, extra: 1 }), {
    kind: 'circle',
    radius: 1,
  });
  check('NullableShape', null, true);
  check('NullableShape', { kind: 'rectangle', width: 1 }, true);
  check('NullableShape', false, false);
  // A union rejection must explain the failing field, including through a
  // nullable union and a map transform that converts Zod issues itself.
  for (const [name, value, path] of [
    ['Shape', { kind: 'circle', radius: 'wrong' }, ['radius']],
    ['NullableShape', { kind: 'circle', radius: 'wrong' }, ['radius']],
    [
      'ShapeMap',
      { north: { kind: 'circle', radius: 'wrong' } },
      ['north', 'radius'],
    ],
  ] satisfies [string, unknown, string[]][]) {
    assert.throws(
      () =>
        runtimeInput(entry(operations, `check${name}`).build, { body: value }),
      (error) =>
        error instanceof RequestValidationError &&
        error.issues.some(
          (issue) =>
            issue.path.join('.') === ['body', ...path].join('.') &&
            /number/.test(issue.message),
        ),
    );
    const rejected = response(name, value);
    assert.equal(rejected.kind, 'protocol');
    assert.ok(
      rejected.issues.some(
        (issue) =>
          issue.part === 'body' &&
          issue.path?.join('.') === path.join('.') &&
          /number/.test(issue.message),
      ),
    );
  }
  check(
    'ShapeMap',
    { north: { kind: 'circle', radius: 1 }, south: null },
    true,
  );
  check('ShapeMap', { north: { kind: 'circle', radius: -1 } }, false);
  // Every own JSON key survives, including the keys ordinary Zod records skip.
  const special = record(
    json(
      '{"__proto__":{"kind":"circle","radius":1},"constructor":null,"toString":null}',
    ),
  );
  check('ShapeMap', special, true);
  assert.deepEqual(data('ShapeMap', special), special);
  check('ShapeMap', json('{"__proto__":{"kind":"unknown"}}'), false);
  check(
    'JsonMap',
    { arbitrary: [null, 4, { enabled: true }], text: 'x' },
    true,
  );
  const jsonKeys = record(json('{"__proto__":{"nested":{"__proto__":2}}}'));
  check('JsonMap', jsonKeys, true);
  assert.deepEqual(data('JsonMap', jsonKeys), jsonKeys);
  const mutable = { nested: [{ enabled: true }] };
  const prepared = operations.checkJsonMap.build({ body: mutable });
  present(mutable.nested[0]).enabled = false;
  assert.deepEqual(prepared.body, { nested: [{ enabled: true }] });
  const shared = { nested: [1] };
  const sharedCopy = operations.checkJsonMap.build({
    body: { keys: [shared, shared] },
  }).body;
  assert.deepEqual(sharedCopy, { keys: [shared, shared] });
  assert.notEqual(
    member(member(sharedCopy, 'keys'), 0),
    member(member(sharedCopy, 'keys'), 1),
  );
  assert.notEqual(
    member(member(member(sharedCopy, 'keys'), 0), 'nested'),
    shared.nested,
  );
  // JSON.parse accepts this depth. Builders and parsers must neither recurse
  // on the JS call stack nor narrow additionalProperties:true to shallow JSON.
  for (const [open, close, key] of [
    ['[', ']', 0],
    ['{"child":', '}', 'child'],
  ] satisfies [string, string, string | number][]) {
    const wire =
      '{"value":' + open.repeat(10000) + '0' + close.repeat(10000) + '}';
    const input = record(json(wire));
    const built = runtimeInput(operations.checkJsonMap.build, { body: input });
    const parsed = operations.checkJsonMap.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: wire,
    });
    assert.equal(parsed.kind, 'success');
    let original = input.value;
    let copy: unknown = built.body.value;
    let decoded: unknown = parsed.data.value;
    for (let depth = 0; depth < 10000; depth++) {
      assert.notEqual(copy, original);
      original = member(original, key);
      copy = member(copy, key);
      decoded = member(decoded, key);
    }
    assert.equal(copy, 0);
    assert.equal(decoded, 0);
    let leaf = input.value;
    for (let depth = 1; depth < 10000; depth++) leaf = member(leaf, key);
    Reflect.set(presentObject(leaf), key, undefined);
    assert.throws(
      () => runtimeInput(operations.checkJsonMap.build, { body: input }),
      RequestValidationError,
    );
    Reflect.set(presentObject(leaf), key, input.value);
    assert.throws(
      () => runtimeInput(operations.checkJsonMap.build, { body: input }),
      RequestValidationError,
    );
  }
  for (const value of [
    { key: undefined },
    { key: Infinity },
    { key: () => 1 },
    { key: new Date() },
  ])
    assert.throws(
      () => runtimeInput(operations.checkJsonMap.build, { body: value }),
      RequestValidationError,
    );
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(
    () => runtimeInput(operations.checkJsonMap.build, { body: cycle }),
    RequestValidationError,
  );
  check('Location', ['body', 0, 'field'], true);
  assert.equal(
    operations.checkLocation.build({ body: [], query: { index: [1, 2] } }).url,
    '/samples/Location?index=1&index=2',
  );
  assert.throws(
    () => operations.checkLocation.build({ body: [], query: { index: [] } }),
    (error) =>
      error instanceof RequestValidationError &&
      error.issues.some((issue) => issue.path.join('.') === 'query.index'),
  );
  for (const value of [[''], [-1], [0.5], [true], [null]])
    check('Location', value, false);
  for (const value of [['field'], ['field', 1]])
    check('ShortLocation', value, true);
  for (const value of [[], [false], ['field', 1, 2]])
    check('ShortLocation', value, false);
  const oversizedBody = [false, false, false];
  assert.throws(
    () =>
      runtimeInput(operations.checkShortLocation.build, {
        body: oversizedBody,
      }),
    (error) =>
      error instanceof RequestValidationError &&
      error.issues.length === 1 &&
      present(error.issues[0]).path.join('.') === 'body',
  );
  const oversizedResponse = response('ShortLocation', oversizedBody);
  assert.equal(oversizedResponse.kind, 'protocol');
  assert.equal(oversizedResponse.issues.length, 1);
  assert.equal(present(oversizedResponse.issues[0]).part, 'body');
  assert.deepEqual(present(oversizedResponse.issues[0]).path, []);
  const scalars: Scalars = {
    date: '2024-02-29',
    instant: '2024-02-29T12:34:56.123+04:00',
    id: '12345678-1234-4234-9234-123456789012',
    code: '😀',
    label: 'red',
  };
  check('Scalars', scalars, true);
  const queryUrl = (query: unknown) =>
    runtimeInput(operations.checkScalars.build, { body: scalars, query }).url;
  for (const query of [
    undefined,
    {},
    {
      q: null,
      cursor: null,
      count: null,
      ratio: null,
      active: null,
      date: null,
      instant: null,
      id: null,
    },
    { q: undefined, cursor: undefined, count: undefined, active: undefined },
  ])
    assert.equal(queryUrl(query), '/samples/Scalars');
  assert.equal(
    queryUrl({ count: 0, ratio: 0, active: false }),
    '/samples/Scalars?count=0&ratio=0&active=false',
  );
  assert.equal(queryUrl({ q: '' }), '/samples/Scalars?q=');
  assert.equal(queryUrl({ q: 'null' }), '/samples/Scalars?q=null');
  assert.equal(
    queryUrl({ q: 'a+ b&😀' }),
    '/samples/Scalars?q=a%2B+b%26%F0%9F%98%80',
  );
  assert.equal(
    queryUrl({ cursor: 'next', count: null, ratio: 0.25, active: true }),
    '/samples/Scalars?cursor=next&ratio=0.25&active=true',
  );
  const formatted = {
    date: scalars.date,
    instant: scalars.instant,
    id: scalars.id,
  };
  assert.deepEqual(
    Object.fromEntries(
      new URL(queryUrl(formatted), 'https://example.invalid').searchParams,
    ),
    formatted,
  );
  for (const query of [
    null,
    { q: 1 },
    { q: '\ud800' },
    { cursor: '' },
    { cursor: 'UPPER' },
    { cursor: 'toolongvalue' },
    { count: -1 },
    { count: 11 },
    { count: 0.5 },
    { ratio: 0.3 },
    { ratio: 1 },
    { active: 'false' },
    { date: '2024-02-30' },
    { instant: '2024-02-29' },
    { id: 'not-a-uuid' },
    { limit: null },
    { tags: null },
    { unknown: null },
  ])
    assert.throws(() => queryUrl(query), RequestValidationError);
  const parameterRequest = runtimeInput(operations.checkScalars.build, {
    body: scalars,
    query: { tags: ['alpha', 'a,b', 'x y', '+'] },
    headers: { 'X-Note': null },
  });
  assert.equal(
    parameterRequest.url,
    '/samples/Scalars?tags=alpha&tags=a%2Cb&tags=x+y&tags=%2B',
  );
  assert.equal(Object.hasOwn(parameterRequest.headers, 'X-Note'), false);
  assert.equal(
    runtimeInput(operations.checkScalars.build, {
      body: scalars,
      query: { tags: [] },
    }).url,
    '/samples/Scalars',
  );
  for (const tags of [[''], ['\ud800'], [null], ['a', 'b', 'c', 'd', 'e']])
    assert.throws(
      () =>
        runtimeInput(operations.checkScalars.build, {
          body: scalars,
          query: { tags },
        }),
      RequestValidationError,
    );
  // A declared upper bound must reject before parsing even the first item.
  const oversizedTags = Array(5).fill('tag');
  Object.defineProperty(oversizedTags, '0', {
    get() {
      throw new Error('Oversized array item was read');
    },
  });
  assert.throws(
    () =>
      runtimeInput(operations.checkScalars.build, {
        body: scalars,
        query: { tags: oversizedTags },
      }),
    (error) =>
      error instanceof RequestValidationError &&
      error.issues.length === 1 &&
      present(error.issues[0]).path.join('.') === 'query.tags',
  );
  assert.throws(
    () =>
      runtimeInput(operations.checkScalars.build, {
        body: scalars,
        headers: { 'X-Origin': 'native' },
      }),
    RequestValidationError,
  );
  assert.throws(
    () => parameterRequest.validateHeaders({}),
    RequestValidationError,
  );
  assert.throws(
    () => parameterRequest.validateHeaders({ 'X-Origin': 'unknown' }),
    RequestValidationError,
  );
  assert.throws(
    () =>
      parameterRequest.validateHeaders({
        'X-Origin': 'native',
        'x-origin': 'desktop',
      }),
    RequestValidationError,
  );
  assert.throws(
    () =>
      parameterRequest.validateHeaders({ 'X-Origin': 'native', 'X-Note': '' }),
    RequestValidationError,
  );
  assert.throws(
    () =>
      parameterRequest.validateHeaders({
        'X-Origin': 'native',
        'X-Extra': 'bad\r\n',
      }),
    RequestValidationError,
  );
  assert.equal(
    parameterRequest.validateHeaders({
      'X-Origin': 'native',
      Authorization: 'Bearer test',
      'X-Extra': 'allowed',
    })['x-origin'],
    'native',
  );
  for (const id of [
    'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
    'ffFFFFff-ffFF-ffff-FFFF-ffffffffffff',
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-000000000001',
    '12345678-abCD-f234-1234-123456789012',
    '12345678-1234-4234-f234-123456789012',
  ])
    check('Scalars', { ...scalars, id }, true);
  for (const id of [
    '12345678-1234-4234-9234-12345678901',
    '12345678-1234-4234-9234-1234567890123',
    '12345678-1234-4234-9234-12345678901g',
    '{12345678-1234-4234-9234-123456789012}',
    'urn:uuid:12345678-1234-4234-9234-123456789012',
  ])
    check('Scalars', { ...scalars, id }, false);
  check('Scalars', { ...scalars, instant: '2024-02-29t12:34:56z' }, true);
  for (const [key, value] of [
    ['date', '2023-02-29'],
    ['instant', '2024-02-29T12:34:56'],
    ['instant', '2024-02-29T12:34Z'],
    ['instant', '2016-12-31T23:59:60Z'],
    ['instant', '2024-02-29T12:34:56+24:00'],
    ['id', 'not-a-uuid'],
    ['code', 'ab'],
    ['code', 'x\n'],
    ['label', 'green'],
  ] satisfies [string, string][])
    check('Scalars', { ...scalars, [key]: value }, false);
  const defaults = operations.checkDefaults;
  assert.deepEqual(defaults.build({ body: { required: false } }).body, {
    required: false,
  });
  assert.deepEqual(
    defaults.build({ body: { required: true, nested: {} } }).body,
    { required: true, nested: {} },
  );
  assert.deepEqual(
    defaults.build({
      body: { required: true, selection: null, count: undefined },
    }).body,
    { required: true, selection: null, count: undefined },
  );
  assert.equal(
    defaults.build({ body: { required: true }, query: {} }).url,
    '/samples/Defaults',
  );
  assert.throws(
    () => runtimeInput(defaults.build, { body: {} }),
    RequestValidationError,
  );
  assert.throws(
    () => runtimeInput(defaults.build, { body: { required: undefined } }),
    RequestValidationError,
  );
  assert.equal(response('Defaults', { required: true }).kind, 'protocol');
}

export function verifyStandalone(message: ZodType, input: ZodType) {
  assert.deepEqual(message.parse({ kind: 'circle', radius: 1, extra: true }), {
    kind: 'circle',
    radius: 1,
  });
  assert.equal(message.parse(null), null);
  assert.equal(
    message.safeParse({ kind: 'circle', radius: -1 }).success,
    false,
  );
  assert.equal(message.safeParse({ kind: 'other', radius: 1 }).success, false);
  assert.equal(input.safeParse({}).success, false);
  assert.deepEqual(input.parse({ required: false }), { required: false });
  assert.equal(
    input.safeParse({ required: false, extra: true }).success,
    false,
  );
}
