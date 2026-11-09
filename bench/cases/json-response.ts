import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

export const jsonResponseCase = Object.freeze({
  id: 'json-response',
  version: 2,
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
    ] satisfies [object, object],
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

function assertDetached(
  output: unknown,
  source: unknown,
  message: string,
): void {
  const sourceContainers = containers(source);
  for (const container of containers(output))
    assert.ok(!sourceContainers.has(container), message);
}

// Exercise permitted mutations on every container in this fixed workload;
// mutating only an array would miss frozen object roots and nested records.
function mutateOutput(value: unknown): void {
  const output = record(value);
  output.nextCursor = 'output mutation';
  const items = array(output.items);
  for (const item of items) {
    const entry = record(item);
    entry.label = 'output mutation';
    const details = record(entry.details);
    details.active = details.active !== true;
    array(details.tags).push('output mutation');
  }
  items.reverse();
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
  assertDetached(result.data, input, 'output must detach every container');
  return result.data;
}

function invalidInputs(): {
  name: string;
  value: unknown;
  path: readonly (string | number)[];
}[] {
  const { items } = jsonResponseInput();
  return [
    { name: 'null root', value: null, path: [] },
    { name: 'null item', value: { items: [null] }, path: ['items', 0] },
    { name: 'null collection', value: { items: null }, path: ['items'] },
    {
      name: 'missing details',
      value: { items: [{ id: 1, label: 'Alpha' }] },
      path: ['items', 0, 'details'],
    },
    {
      name: 'null details',
      value: { items: [{ ...items[0], details: null }] },
      path: ['items', 0, 'details'],
    },
    {
      name: 'non-string label',
      value: { items: [{ ...items[0], label: ['x'] }] },
      path: ['items', 0, 'label'],
    },
    {
      name: 'non-array tags',
      value: { items: [{ ...items[0], details: { active: true, tags: 'x' } }] },
      path: ['items', 0, 'details', 'tags'],
    },
    {
      name: 'non-string cursor',
      value: { items: [], nextCursor: 5 },
      path: ['nextCursor'],
    },
    { name: 'missing collection', value: {}, path: ['items'] },
    { name: 'wrong collection type', value: { items: {} }, path: ['items'] },
    {
      name: 'invalid first ID',
      value: { items: [{ ...items[0], id: 0 }] },
      path: ['items', 0, 'id'],
    },
    {
      name: 'fractional ID',
      value: { items: [{ ...items[0], id: 1.5 }] },
      path: ['items', 0, 'id'],
    },
    {
      name: 'empty label',
      value: { items: [{ ...items[0], label: '' }] },
      path: ['items', 0, 'label'],
    },
    {
      name: 'long label',
      value: { items: [{ ...items[0], label: 'x'.repeat(33) }] },
      path: ['items', 0, 'label'],
    },
    {
      name: 'invalid optional',
      value: { items: [{ ...items[0], note: 3 }] },
      path: ['items', 0, 'note'],
    },
    {
      name: 'long optional',
      value: { items: [{ ...items[0], note: 'x'.repeat(65) }] },
      path: ['items', 0, 'note'],
    },
    {
      name: 'missing nested value',
      value: { items: [{ ...items[0], details: {} }] },
      path: ['items', 0, 'details', 'active'],
    },
    {
      name: 'invalid nested boolean',
      value: {
        items: [{ ...items[0], details: { active: 'true', tags: [] } }],
      },
      path: ['items', 0, 'details', 'active'],
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
      path: ['items', 0, 'details', 'tags'],
    },
    {
      name: 'invalid last nested element',
      value: {
        items: [
          items[0],
          { ...items[1], details: { active: false, tags: [''] } },
        ],
      },
      path: ['items', 1, 'details', 'tags', 0],
    },
    {
      name: 'long collection',
      value: { items: Array.from({ length: 129 }, () => items[0]) },
      path: ['items'],
    },
    {
      name: 'empty cursor',
      value: { items: [], nextCursor: '' },
      path: ['nextCursor'],
    },
  ];
}

function verifyIssues(
  value: unknown,
  path: readonly (string | number)[] | undefined,
  part?: string,
): void {
  const issues = array(value).map(record);
  assert.ok(issues.length > 0);
  for (const issue of issues)
    assert.ok(typeof issue.message === 'string' && issue.message.length > 0);
  assert.ok(
    issues.some(
      (issue) =>
        (part === undefined || issue.part === part) &&
        (path === undefined || isDeepStrictEqual(issue.path, path)),
    ),
    'failure must retain the expected issue path and part',
  );
}

function verifyProtocolFailure(
  subject: JsonResponseSubject,
  response: { status: number; headers: Record<string, string>; body: string },
  part: string,
  path?: readonly (string | number)[],
): void {
  const failure = record(subject.parseResponse(response));
  assert.equal(failure.kind, 'protocol');
  assert.equal(failure.operationId, 'listRecords');
  assert.equal(failure.status, response.status);
  assert.deepEqual({ ...record(failure.headers) }, response.headers);
  verifyIssues(failure.issues, path, part);
}

export function verifyJsonResponse(subject: JsonResponseSubject): void {
  const request = record(subject.build());
  assert.equal(request.method, 'GET');
  assert.equal(request.url, '/records');

  const input = jsonResponseInput();
  const output = verifyValid(subject, input, jsonResponseExpected());
  // Identity caches can pass a single parse while reusing mutable results or
  // retaining a stale snapshot after the same input object changes.
  const repeated = verifyValid(subject, input, jsonResponseExpected());
  assertDetached(
    repeated,
    output,
    'validation calls must return independent containers',
  );
  mutateOutput(output);
  assert.deepEqual(
    input,
    jsonResponseInput(),
    'output must be independently mutable',
  );
  assert.deepEqual(
    repeated,
    jsonResponseExpected(),
    'output changes must not affect another result',
  );
  const outputBefore = structuredClone(output);
  input.items[0].details.tags.push('input mutation');
  assert.deepEqual(
    output,
    outputBefore,
    'input changes must not affect output',
  );
  const changedExpected = jsonResponseExpected();
  changedExpected.items[0].details.tags.push('input mutation');
  verifyValid(subject, input, changedExpected);
  input.items[0].id = 0;
  assert.equal(
    record(subject.validate(input)).success,
    false,
    'validation must reject newly invalid input',
  );
  verifyValid(subject, { items: [] }, { items: [] });
  const withoutSecrets = jsonResponseInput();
  for (const item of withoutSecrets.items) delete record(item).secret;
  verifyValid(subject, withoutSecrets, jsonResponseExpected());
  const boundary = {
    items: Array.from({ length: 128 }, () => ({
      id: 1,
      label: 'x'.repeat(32),
      note: 'n'.repeat(64),
      details: { active: true, tags: Array.from({ length: 8 }, () => 'tag') },
    })),
  };
  // Every field here is visible. The independently chosen limits are not read
  // from the schema; a clone is the expected value, never the expected identity.
  verifyValid(subject, boundary, structuredClone(boundary));

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
  const response = observed(JSON.stringify(jsonResponseInput()));
  const success = record(subject.parseResponse(response));
  assert.equal(success.kind, 'success');
  assert.equal(success.operationId, 'listRecords');
  assert.equal(success.status, 200);
  assert.equal(success.contentType, 'application/json');
  assert.deepEqual(success.data, jsonResponseExpected());
  const parameterized = record(
    subject.parseResponse({
      ...response,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }),
  );
  assert.equal(parameterized.kind, 'success');
  assert.equal(parameterized.contentType, 'application/json');
  assert.deepEqual(parameterized.data, jsonResponseExpected());
  const repeatedResponse = record(subject.parseResponse(response));
  assert.equal(repeatedResponse.kind, 'success');
  assert.deepEqual(repeatedResponse.data, jsonResponseExpected());
  assertDetached(
    repeatedResponse.data,
    success.data,
    'response parse calls must return independent containers',
  );
  mutateOutput(success.data);
  assert.deepEqual(
    repeatedResponse.data,
    jsonResponseExpected(),
    'response output changes must not affect another result',
  );
  response.body = '{}';
  assert.equal(
    record(subject.parseResponse(response)).kind,
    'protocol',
    'response parsing must reject newly invalid input',
  );

  for (const { name, value, path } of invalidInputs()) {
    const before = structuredClone(value);
    const failure = record(subject.validate(value));
    assert.equal(failure.success, false, name);
    assert.ok(failure.error instanceof Error, name);
    verifyIssues(record(failure.error).issues, path);
    assert.deepEqual(value, before, name);
    verifyProtocolFailure(
      subject,
      observed(JSON.stringify(value)),
      'body',
      path,
    );
  }
  verifyProtocolFailure(subject, observed('{'), 'body');
  verifyProtocolFailure(
    subject,
    { ...observed('{"items":[]}'), status: 201 },
    'status',
  );
  verifyProtocolFailure(
    subject,
    { ...observed('{"items":[]}'), headers: { 'content-type': 'text/plain' } },
    'content-type',
  );
}
