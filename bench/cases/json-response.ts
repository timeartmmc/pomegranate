import assert from 'node:assert/strict';

export const jsonResponseCase = Object.freeze({
  id: 'json-response',
  version: 1,
});

export function jsonResponseWorkload() {
  return {
    options: { clients: ['consumer'] },
    document: {
      openapi: '3.1.0',
      info: { title: 'Synthetic benchmark records', version: '1' },
      'x-pom-policy': { version: 3, surfaces: ['consumer'] },
      paths: {
        '/records': {
          get: {
            operationId: 'listRecords',
            'x-pom': { surfaces: ['consumer'] },
            responses: {
              '200': {
                description: 'A page of synthetic records',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/RecordList' },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Record: {
            type: 'object',
            required: ['id', 'label', 'details', 'secret'],
            properties: {
              id: { type: 'integer', minimum: 1 },
              label: { type: 'string', minLength: 1, maxLength: 32 },
              note: { type: 'string', maxLength: 64 },
              secret: { type: 'string', writeOnly: true },
              details: {
                type: 'object',
                required: ['active', 'tags'],
                properties: {
                  active: { type: 'boolean' },
                  tags: {
                    type: 'array',
                    maxItems: 8,
                    items: { type: 'string', minLength: 1 },
                  },
                },
              },
            },
          },
          RecordList: {
            type: 'object',
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                maxItems: 128,
                items: { $ref: '#/components/schemas/Record' },
              },
              nextCursor: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    },
  };
}

export function jsonResponseInput() {
  return {
    items: [
      {
        id: 1,
        label: 'Alpha',
        note: 'First record',
        details: { active: true, tags: ['new', 'featured'] },
        secret: { deliberatelyWrongType: true },
        serverOnly: 'strip this too',
      },
      {
        id: 2,
        label: 'Beta',
        details: { active: false, tags: [] },
        secret: 'private',
      },
    ] satisfies [object, object],
    nextCursor: 'page-2',
    serverOnly: { trace: 'synthetic' },
  };
}

// These are hand expectations, not a projection computed from the contract or
// from generated output. Changing the work requires reviewing the case version.
export function jsonResponseExpected() {
  return {
    items: [
      {
        id: 1,
        label: 'Alpha',
        note: 'First record',
        details: { active: true, tags: ['new', 'featured'] },
      },
      { id: 2, label: 'Beta', details: { active: false, tags: [] } },
    ],
    nextCursor: 'page-2',
  };
}

export interface JsonResponseSubject {
  build(): unknown;
  validate(input: unknown): unknown;
  parseResponse(input: unknown): unknown;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value as unknown[];
}

function callable(value: unknown): (input?: unknown) => unknown {
  assert.equal(typeof value, 'function');
  // The generated module is a runtime boundary. Keep its result unknown rather
  // than assuming a successful parse or borrowing the candidate's output types.
  return value as (input?: unknown) => unknown;
}

export function jsonResponseSubject(
  clientModule: unknown,
  schemaModule: unknown,
): JsonResponseSubject {
  const operations = record(record(clientModule).operations);
  assert.deepEqual(Object.keys(operations), ['listRecords']);
  const operation = record(operations.listRecords);
  const validator = record(
    record(record(schemaModule).responseSchemas).RecordList,
  );
  return {
    build: callable(operation.build),
    validate: callable(validator.safeParse),
    parseResponse: callable(operation.parseResponse),
  };
}

function containers(value: unknown, result = new Set<object>()): Set<object> {
  if (value !== null && typeof value === 'object' && !result.has(value)) {
    result.add(value);
    for (const child of Object.values(value as Record<string, unknown>))
      containers(child, result);
  }
  return result;
}

function verifyValid(
  subject: JsonResponseSubject,
  input: unknown,
  expected: unknown,
): unknown {
  const before = structuredClone(input);
  const result = record(subject.validate(input));
  assert.equal(result.success, true);
  assert.deepEqual(result.data, expected);
  assert.deepEqual(input, before, 'validation must preserve its input');
  const inputContainers = containers(input);
  for (const output of containers(result.data))
    assert.ok(
      !inputContainers.has(output),
      'output must detach every container',
    );
  return result.data;
}

function invalidInputs(): { name: string; value: unknown }[] {
  const { items } = jsonResponseInput();
  return [
    { name: 'missing collection', value: {} },
    { name: 'wrong collection type', value: { items: {} } },
    { name: 'invalid first ID', value: { items: [{ ...items[0], id: 0 }] } },
    { name: 'fractional ID', value: { items: [{ ...items[0], id: 1.5 }] } },
    { name: 'empty label', value: { items: [{ ...items[0], label: '' }] } },
    {
      name: 'long label',
      value: { items: [{ ...items[0], label: 'x'.repeat(33) }] },
    },
    { name: 'invalid optional', value: { items: [{ ...items[0], note: 3 }] } },
    {
      name: 'long optional',
      value: { items: [{ ...items[0], note: 'x'.repeat(65) }] },
    },
    {
      name: 'missing nested value',
      value: { items: [{ ...items[0], details: {} }] },
    },
    {
      name: 'invalid nested boolean',
      value: {
        items: [{ ...items[0], details: { active: 'true', tags: [] } }],
      },
    },
    {
      name: 'long nested collection',
      value: {
        items: [
          {
            ...items[0],
            details: {
              active: true,
              tags: Array.from({ length: 9 }, () => 'tag'),
            },
          },
        ],
      },
    },
    {
      name: 'invalid last nested element',
      value: {
        items: [
          items[0],
          { ...items[1], details: { active: false, tags: [''] } },
        ],
      },
    },
    {
      name: 'long collection',
      value: { items: Array.from({ length: 129 }, () => items[0]) },
    },
    { name: 'empty cursor', value: { items: [], nextCursor: '' } },
  ];
}

export function verifyJsonResponse(subject: JsonResponseSubject): void {
  const request = record(subject.build());
  assert.equal(request.method, 'GET');
  assert.equal(request.url, '/records');

  const input = jsonResponseInput();
  const output = record(verifyValid(subject, input, jsonResponseExpected()));
  const first = record(array(output.items)[0]);
  array(record(first.details).tags).push('output mutation');
  assert.deepEqual(
    input,
    jsonResponseInput(),
    'output must be independently mutable',
  );
  const outputBefore = structuredClone(output);
  input.items[0].details.tags.push('input mutation');
  assert.deepEqual(
    output,
    outputBefore,
    'input changes must not affect output',
  );
  verifyValid(subject, { items: [] }, { items: [] });

  const excluded = jsonResponseInput();
  let reads = 0;
  for (const item of excluded.items)
    Object.defineProperty(item, 'secret', {
      enumerable: true,
      get() {
        reads++;
        throw new Error('excluded response field was read');
      },
    });
  const stripped = record(subject.validate(excluded));
  assert.equal(stripped.success, true);
  assert.deepEqual(stripped.data, jsonResponseExpected());
  assert.equal(reads, 0, 'write-only response fields must not be read');

  const observed = (body: string) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body,
  });
  const success = record(
    subject.parseResponse(observed(JSON.stringify(jsonResponseInput()))),
  );
  assert.equal(success.kind, 'success');
  assert.equal(success.operationId, 'listRecords');
  assert.equal(success.status, 200);
  assert.equal(success.contentType, 'application/json');
  assert.deepEqual(success.data, jsonResponseExpected());

  for (const { name, value } of invalidInputs()) {
    const before = structuredClone(value);
    const failure = record(subject.validate(value));
    assert.equal(failure.success, false, name);
    assert.ok(array(record(failure.error).issues).length > 0, name);
    assert.deepEqual(value, before, name);
    assert.equal(
      record(subject.parseResponse(observed(JSON.stringify(value)))).kind,
      'protocol',
      name,
    );
  }
  for (const response of [
    observed('{'),
    { ...observed('{"items":[]}'), status: 201 },
    { ...observed('{"items":[]}'), headers: { 'content-type': 'text/plain' } },
  ])
    assert.equal(record(subject.parseResponse(response)).kind, 'protocol');
}
