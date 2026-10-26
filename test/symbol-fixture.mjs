import assert from 'node:assert/strict';

export const symbolOperationIds = [
  'read',
  'read_options',
  'read_uoptions',
  'read__options',
  'read_options_options',
  'read_options_header_0',
  'read_header_0',
  'read_body',
  'read_response_200',
  'operation_read',
  'type_operation_read',
  '_',
  '__',
];

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

export function symbolFixture() {
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic identifier collisions', version: '1' },
    'x-pom-policy': {
      version: 2,
      auth: { public: { transport: 'none' } },
      retry: ['never'],
      timeout: ['interactive'],
      surfaces: ['symbols', 'other'],
    },
    paths: Object.fromEntries(
      symbolOperationIds.map((id) => {
        const payload = {
          type: 'object',
          required: ['tag', 'values'],
          properties: {
            tag: { type: 'string', const: id },
            values: {
              type: 'array',
              minItems: 1,
              items: nullable({ type: 'string', const: id }),
            },
          },
        };
        return [
          `/symbols/${id}/{entry}`,
          {
            post: {
              operationId: id,
              'x-pom': {
                auth: 'public',
                retry: 'never',
                timeout: 'interactive',
                surfaces: ['symbols', 'other'],
              },
              parameters: [
                {
                  in: 'path',
                  name: 'entry',
                  required: true,
                  schema: { type: 'string', const: id },
                },
                {
                  in: 'query',
                  name: 'query',
                  schema: nullable({ type: 'string', const: id }),
                },
                {
                  in: 'header',
                  name: 'X-Hint',
                  schema: nullable({ type: 'string', const: id }),
                },
                {
                  in: 'header',
                  name: 'X-Other',
                  schema: { type: ['string', 'null'], enum: [id, null] },
                },
              ],
              requestBody: {
                required: true,
                content: { 'application/json': { schema: payload } },
              },
              responses: {
                200: {
                  description: 'Synthetic result',
                  headers: {
                    'X-Result': {
                      required: true,
                      schema: { type: 'string', const: id },
                    },
                  },
                  content: { 'application/json': { schema: payload } },
                },
                400: {
                  description: 'Synthetic failure',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'array',
                        items: { type: 'string', const: `error:${id}` },
                      },
                    },
                  },
                },
              },
            },
          },
        ];
      }),
    ),
  };
}

export function verifySymbols(operations, RequestValidationError) {
  assert.deepEqual(
    Object.keys(operations).sort(),
    [...symbolOperationIds].sort(),
  );
  for (const id of symbolOperationIds) {
    const operation = operations[id];
    const body = { tag: id, values: [id, null] };
    const options = {
      path: { entry: id },
      query: { query: id },
      headers: { 'X-Hint': id, 'X-Other': id },
      body,
    };
    const request = operation.build(options);
    assert.equal(request.operationId, id);
    assert.equal(request.url, `/symbols/${id}/${id}?query=${id}`);
    assert.deepEqual(request.body, body);
    assert.notEqual(request.body.values, body.values);
    assert.equal(request.headers['X-Hint'], id);
    assert.equal(request.validateHeaders({ 'X-Hint': id })['x-hint'], id);
    const other = id === 'read' ? 'read_options' : 'read';
    for (const invalid of [
      { ...options, path: { entry: other } },
      { ...options, query: { query: other } },
      { ...options, headers: { 'X-Hint': other } },
      { ...options, headers: { 'X-Other': other } },
      { ...options, body: { tag: other, values: [id] } },
      { ...options, body: { tag: id, values: [other] } },
      { ...options, body: { tag: id, values: [] } },
      { ...options, body: { ...body, extra: true } },
    ])
      assert.throws(() => operation.build(invalid), RequestValidationError);
    assert.throws(
      () => request.validateHeaders({ 'X-Hint': other }),
      RequestValidationError,
    );
    assert.throws(
      () => request.validateHeaders({ 'X-Other': other }),
      RequestValidationError,
    );
    const omitted = operation.build({
      ...options,
      query: { query: null },
      headers: { 'X-Hint': null, 'X-Other': null },
    });
    assert.equal(omitted.url, `/symbols/${id}/${id}`);
    assert.equal(Object.hasOwn(omitted.headers, 'X-Hint'), false);
    assert.equal(Object.hasOwn(omitted.headers, 'X-Other'), false);
    const response = (value) =>
      request.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Result': id },
        body: JSON.stringify(value),
      });
    const accepted = response({ ...body, extra: true });
    assert.equal(accepted.kind, 'success');
    assert.deepEqual(accepted.data, body);
    assert.equal(accepted.headers['x-result'], id);
    assert.equal(response({ tag: other, values: [id] }).kind, 'protocol');
    assert.equal(response({ tag: id, values: [other] }).kind, 'protocol');
    assert.equal(
      request.parseResponse({
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([`error:${id}`]),
      }).kind,
      'error',
    );
    assert.equal(
      request.parseResponse({
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([id]),
      }).kind,
      'protocol',
    );
  }
}
