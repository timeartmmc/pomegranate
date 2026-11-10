import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { compile } from '../dist/index.js';
import {
  defineOperation,
  invalid,
  list,
  map,
  noKeys,
  optionalField,
  absent,
  nullValue,
  report,
  stringValue,
  union,
  unknownKeys,
  validator,
  RequestValidationError,
} from '../dist/runtime.js';
import type { Parse } from '../dist/runtime.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

void test('invalid arrays and maps stop reading values at the issue budget', () => {
  for (const container of ['array', 'map']) {
    let reads = 0;
    const input = container === 'array' ? Array<unknown>(1_000) : {};
    for (let index = 0; index < 1_000; index++)
      Object.defineProperty(input, index, {
        enumerable: true,
        get() {
          reads++;
          assert.ok(reads <= 100, 'unvisited invalid values must not be read');
          return false;
        },
      });
    const result = validator((input, issues) =>
      container === 'array'
        ? list(input, issues, stringValue)
        : map(input, issues, stringValue),
    ).safeParse(input);
    assert.equal(result.success, false);
    if (result.success) assert.fail('invalid data must fail');
    assert.equal(reads, 100);
    assert.equal(result.error.issues.length, 101);
    assert.deepEqual(result.error.issues[0]?.path, [
      container === 'array' ? 0 : '0',
    ]);
    assert.match(result.error.issues.at(-1)?.message ?? '', /omitted/);
    assert.deepEqual(result.error.issues.at(-1)?.path, []);
    assert.ok(result.error.message.length <= 8_192);
  }
});

void test('the issue limit does not truncate valid data or invent omitted issues at an exact boundary', () => {
  const array = validator((input, issues) => list(input, issues, stringValue));
  const input = Array<string>(1_000).fill('valid');
  assert.deepEqual(array.parse(input), input);
  assert.notEqual(array.parse(input), input);
  const record = Object.fromEntries(
    input.map((value, index) => [index, value]),
  );
  assert.deepEqual(
    validator((input, issues) => map(input, issues, stringValue)).parse(record),
    record,
  );
  for (const container of ['array', 'map'])
    for (const size of [99, 100, 101]) {
      const values = Array<unknown>(size).fill(false);
      const parse = validator((input, issues) =>
        container === 'array'
          ? list(input, issues, stringValue)
          : map(input, issues, stringValue),
      );
      const result = parse.safeParse(
        container === 'array'
          ? values
          : Object.fromEntries(values.map((value, index) => [index, value])),
      );
      assert.equal(result.success, false);
      if (result.success) assert.fail('invalid data must fail');
      const detailed = result.error.issues.filter(
        (issue) => !/omitted/.test(issue.message),
      );
      assert.equal(detailed.length, Math.min(size, 100));
      assert.equal(result.error.issues.length, size);
      assert.equal(
        result.error.issues.filter((issue) => /omitted/.test(issue.message))
          .length,
        size > 100 ? 1 : 0,
      );
      assert.deepEqual(detailed.at(-1)?.path, [
        container === 'array'
          ? Math.min(size, 100) - 1
          : String(Math.min(size, 100) - 1),
      ]);
    }
});

void test('individual issue messages preserve the exact boundary before truncating excess text', () => {
  for (const length of [1_023, 1_024, 1_025]) {
    const message = 'x'.repeat(length);
    const result = validator((_input, issues) =>
      report(issues, message, true),
    ).safeParse(null);
    assert.equal(result.success, false);
    if (result.success) assert.fail('reported failure must fail');
    assert.equal(result.error.issues.length, 1);
    assert.equal(
      result.error.issues[0]?.message,
      length <= 1_024 ? message : `${'x'.repeat(1_023)}…`,
    );
  }
});

void test('response headers and body share one issue budget while preserving observed evidence', () => {
  let reads = 0;
  const operation = defineOperation({
    operationId: 'budget',
    method: 'GET',
    path: '/budget',
    bodyKind: 'none',
    security: { transport: 'none' },
    policy: {},
    parameters: [],
    headers: {},
    options: () => undefined,
    responses: {
      200: {
        bodyKind: 'content',
        headers: {},
        content: {
          'application/json': {
            bodyKind: 'json',
            schema: (input, issues) =>
              list(input, issues, (input, issues) => {
                reads++;
                return stringValue(input, issues);
              }),
          },
        },
      },
    },
  });
  const headers = {
    ...Object.fromEntries(
      Array.from({ length: 99 }, (_, index) => [`X-Bad-${index}`, '\n']),
    ),
    'Content-Type': 'application/json',
  };
  const result = operation.parseResponse({
    status: 200,
    headers,
    body: JSON.stringify(Array<unknown>(1_000).fill(false)),
  });
  assert.equal(result.kind, 'protocol');
  if (result.kind !== 'protocol') assert.fail('invalid response must fail');
  assert.equal(reads, 1);
  assert.equal(result.issues.length, 101);
  assert.equal(
    result.issues.filter((issue) => /omitted/.test(issue.message)).length,
    1,
  );
  assert.equal(Object.keys(result.headers).length, 100);
  assert.equal(Object.hasOwn(result, 'data'), false);
});

void test('merged request headers stop reading invalid values and bound the thrown error', () => {
  const operation = defineOperation({
    operationId: 'headers',
    method: 'GET',
    path: '/headers',
    bodyKind: 'none',
    security: { transport: 'none' },
    policy: {},
    parameters: [],
    headers: {},
    options: () => undefined,
    responses: { 204: { bodyKind: 'none', headers: {} } },
  });
  const headers: Record<string, string> = {};
  let reads = 0;
  for (let index = 0; index < 1_000; index++)
    Object.defineProperty(headers, `X-Bad-${index}`, {
      enumerable: true,
      get() {
        reads++;
        assert.ok(reads <= 100);
        return '\n';
      },
    });
  assert.throws(
    () => operation.build().validateHeaders(headers),
    (error) => {
      assert.ok(error instanceof RequestValidationError);
      assert.equal(error.issues.length, 101);
      assert.ok(error.message.length <= 8_192);
      return true;
    },
  );
  assert.equal(reads, 100);
});

void test('wide generated object parsers stop before reading later fields', async (t) => {
  const properties = Object.fromEntries(
    Array.from({ length: 257 }, (_, index) => [
      `field${index}`,
      { type: 'string' },
    ]),
  );
  const root = await generatedTestWorkspace(
    t,
    await compile(
      {
        openapi: '3.1.0',
        info: { title: 'Synthetic bounded fields', version: '1' },
        paths: {},
        components: {
          schemas: {
            Wide: {
              type: 'object',
              properties,
              required: Object.keys(properties),
            },
          },
        },
      },
      {
        clients: [],
        standalone: {
          wide: { schema: '#/components/schemas/Wide', usage: 'request' },
        },
      },
    ),
  );
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.wide.ts',
  );
  const input = {};
  let reads = 0;
  for (const name of Object.keys(properties))
    Object.defineProperty(input, name, {
      enumerable: true,
      get() {
        reads++;
        assert.ok(reads <= 100);
        return false;
      },
    });
  const result = schema.safeParse(input);
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues.length, 101);
  assert.equal(reads, 100);
});

void test('large invalid nullable responses stay bounded in generated validators, builders and raw/scoped calls under a small heap', async (t) => {
  for (const modern of [false, true]) {
    const nullable = (schema: Schema): Schema => {
      assert.ok(typeof schema.type === 'string');
      return modern
        ? { ...schema, type: [schema.type, 'null'] }
        : { ...schema, nullable: true };
    };
    let schema = nullable({
      type: 'array',
      items: nullable({ type: 'integer' }),
    });
    for (let depth = 0; depth < 8; depth++)
      schema = nullable({
        type: 'object',
        properties: { value: schema },
        required: ['value'],
      });
    schema = nullable({ type: 'array', items: schema });
    const content = {
      'application/json': { schema: { $ref: '#/components/schemas/Payload' } },
    };
    const root = await generatedTestWorkspace(
      t,
      await compile(
        {
          openapi: modern ? '3.1.0' : '3.0.4',
          info: { title: 'Synthetic validation memory budget', version: '1' },
          components: { schemas: { Payload: schema } },
          paths: {
            '/budget': {
              post: {
                operationId: 'budget',
                requestBody: { required: true, content },
                responses: { 200: { description: 'OK', content } },
              },
            },
          },
        },
        {
          clients: ['consumer'],
          executionClients: ['consumer'],
          surfaces: { consumer: ['budget'] },
          standalone: {
            payload: {
              schema: '#/components/schemas/Payload',
              usage: 'response',
            },
          },
        },
      ),
    );
    await writeFile(
      join(root, 'budget-check.mjs'),
      `
      import assert from 'node:assert/strict';
      import {schema} from './standalone.payload.ts';
      import {operations, createClient, RequestValidationError, ResponseError} from './client.consumer.ts';
      let entry=Array(12).fill('invalid');
      for(let depth=0;depth<8;depth++)entry={value:entry};
      const values=Array(12000).fill(entry);
      const body=JSON.stringify(values);
      assert.ok(Buffer.byteLength(body)>2_000_000);
      assert.equal(schema.safeParse(null).success,true);
      const parsed=schema.safeParse(values);
      assert.equal(parsed.success,false);
      assert.equal(parsed.error.issues.length,101);
      assert.ok(parsed.error.message.length<=8192);
      assert.throws(()=>operations.budget.build({body:values}),error=>{
        assert.ok(error instanceof RequestValidationError);
        assert.equal(error.issues.length,101);
        assert.ok(error.message.length<=8192);
        return true;
      });
      const raw={status:200,headers:{'Content-Type':'application/json'},body};
      const response=operations.budget.parseResponse(raw);
      assert.equal(response.kind,'protocol');
      assert.equal(response.issues.length,101);
      assert.equal(response.issues.filter(issue=>issue.message.includes('omitted')).length,1);
      for(const scoped of [false,true]){
        const client=createClient({namespace:'budget',execute:async(_request,execution)=>scoped?execution.validateResponse(raw):raw});
        await assert.rejects(client.budget.call({context:{},input:{body:null}}),error=>{
          assert.ok(error instanceof ResponseError);
          assert.equal(error.result.kind,'protocol');
          assert.equal(error.result.issues.length,101);
          return true;
        });
      }
      console.log('bounded',Buffer.byteLength(body));
    `,
    );
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--max-old-space-size=96',
      join(root, 'budget-check.mjs'),
    ]);
    assert.match(stdout, /^bounded /);
  }
});

void test('a bounded failed branch does not suppress a valid alternative', () => {
  let reads = 0;
  const failed: Parse<string> = (_input, issues) => {
    list(Array<unknown>(1_000).fill(false), issues, (input, issues) => {
      reads++;
      return stringValue(input, issues);
    });
    return invalid;
  };
  const parser = validator((input, issues) =>
    union(input, issues, [failed, stringValue]),
  );
  assert.deepEqual(parser.safeParse('valid'), { success: true, data: 'valid' });
  assert.equal(reads, 100);
});

void test('existing sibling failures reduce the remaining branch budget and produce one omission marker', () => {
  let reads = 0;
  const parser = validator((input, issues) => {
    for (let index = 0; index < 97; index++)
      report(issues, 'prior failure', false);
    return union<readonly string[] | null>(input, issues, [
      (input, issues) =>
        list(input, issues, (input, issues) => {
          reads++;
          return stringValue(input, issues);
        }),
      nullValue,
    ]);
  });
  const result = parser.safeParse(Array<unknown>(1_000).fill(false));
  assert.equal(result.success, false);
  if (result.success) assert.fail('invalid data must fail');
  assert.equal(reads, 3);
  assert.equal(result.error.issues.length, 101);
  assert.equal(
    result.error.issues.filter((issue) => /omitted/.test(issue.message)).length,
    1,
  );
});

void test('long issue messages and repeated long paths cannot expand exception text without bound', () => {
  const key = 'x'.repeat(200_000);
  const parser = validator((input, issues) =>
    map(input, issues, (input, issues) => list(input, issues, stringValue)),
  );
  const result = parser.safeParse({ [key]: Array<unknown>(1_000).fill(false) });
  assert.equal(result.success, false);
  if (result.success) assert.fail('invalid data must fail');
  assert.ok(result.error.message.length <= 8_192);
  assert.equal(result.error.issues[0]?.path[0], key);
  const message = validator((_input, issues) =>
    report(issues, key, true),
  ).safeParse(null);
  assert.equal(message.success, false);
  if (!message.success)
    assert.ok((message.error.issues[0]?.message.length ?? Infinity) <= 1_024);
  const request = new RequestValidationError(key, result.error.issues);
  assert.equal(request.operationId, key);
  assert.ok(request.message.length <= 8_192);
});

void test('unknown-key summaries are bounded and never read excluded values', () => {
  const input = {};
  for (let index = 0; index < 1_000; index++)
    Object.defineProperty(input, `${index}${'x'.repeat(2_000)}`, {
      enumerable: true,
      get() {
        assert.fail('unknown values must not be read');
      },
    });
  // Fixed-object unknown-key checks report keys without parsing their values.
  const fixed = validator((input, issues) => {
    if (typeof input !== 'object' || input === null)
      return report(issues, 'expected an object', true);
    return unknownKeys(input, noKeys, issues) ? invalid : {};
  });
  const result = fixed.safeParse(input);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(result.error.issues.length, 1);
    assert.ok((result.error.issues[0]?.message.length ?? Infinity) <= 1_024);
    assert.ok(result.error.message.length <= 8_192);
  }
});

void test('discarded polluted optional fields restore the diagnostic budget', () => {
  const name = 'budgetOptional';
  const before = Object.getOwnPropertyDescriptor(Object.prototype, name);
  try {
    Object.defineProperty(Object.prototype, name, {
      value: Array<unknown>(1_000).fill(false),
      configurable: true,
    });
    const parse = validator((input, issues) => {
      if (typeof input !== 'object' || input === null)
        return report(issues, 'expected an object', true);
      const value = optionalField(
        input,
        name,
        (input, issues) => list(input, issues, stringValue),
        issues,
      );
      return value === absent ? {} : invalid;
    });
    assert.deepEqual(parse.safeParse({}), { success: true, data: {} });
  } finally {
    if (before) Object.defineProperty(Object.prototype, name, before);
    else Reflect.deleteProperty(Object.prototype, name);
  }
});
