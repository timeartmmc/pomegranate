import assert from 'node:assert/strict';
import { symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '../dist/index.js';
import { runtimeInput } from './assertions.ts';
import { generatedFixture, temporary } from './helpers.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const options = () => ({
  path: { widgetId: 'widget' },
  headers: { 'Idempotency-Key': 'attempt' },
  body: { acknowledged: true as const, label: 'Synthetic' },
});
const headers = () => ({
  'Content-Type': 'application/json',
  'X-Request-ID': 'request',
  'Retry-After': '3',
  Location: '/next',
});
const pending = { state: 'pending', reference: 'reference' };

void test('generated protocol invariants hold across the complete byte and status vocabularies', async (t) => {
  const root = await temporary(t);
  await symlink(
    join(repo, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const files = await compile(generatedFixture(), { clients: ['consumer'] });
  for (const [name, source] of Object.entries(files))
    await writeFile(join(root, name), source);
  const { operations, RequestValidationError } = (await import(
    pathToFileURL(join(root, 'client.consumer.ts')).href
  )) as typeof import('./.generated/runtime/client.consumer.ts');
  const operation = operations.prepareWidget;

  await t.test(
    'malformed raw evidence cannot become successful typed protocol data',
    () => {
      const observed = {
        status: 202,
        headers: headers(),
        body: JSON.stringify(pending),
      };
      const malformed: readonly (readonly [unknown, RegExp])[] = [
        ...[null, undefined, false, 'response'].map(
          (value) => [value, /response evidence must be an object/] as const,
        ),
        ...[
          '202',
          null,
          undefined,
          true,
          202n,
          { [Symbol.toPrimitive]: () => 202 },
        ].map(
          (status) =>
            [
              { ...observed, status },
              /response status must be a number/,
            ] as const,
        ),
        ...[
          5,
          null,
          false,
          true,
          undefined,
          pending,
          {
            toString: () => JSON.stringify(pending),
          },
        ].map(
          (body) =>
            [{ ...observed, body }, /response body must be raw text/] as const,
        ),
        ...[
          null,
          undefined,
          [],
          [['X-Key', 'value']],
          new Headers(headers()),
        ].map(
          (value) =>
            [
              { ...observed, headers: value },
              /response headers must be a plain record/,
            ] as const,
        ),
        ...[null, undefined, 5, true, [], {}, { toString: () => 'value' }].map(
          (value) =>
            [
              { ...observed, headers: { ...headers(), 'X-Other': value } },
              /response header "X-Other" must be a string/,
            ] as const,
        ),
      ];
      for (const [value, message] of malformed)
        assert.throws(() => runtimeInput(operation.parseResponse, value), {
          name: 'TypeError',
          message,
        });
    },
  );

  await t.test(
    'response parsing snapshots fields once and accepts null-prototype header maps',
    () => {
      const reads = { status: 0, headers: 0, body: 0, value: 0 };
      const observedHeaders = Object.assign(
        Object.create(null) as object,
        headers(),
      );
      Object.defineProperty(observedHeaders, 'X-Key', {
        enumerable: true,
        get() {
          reads.value += 1;
          return reads.value === 1 ? 'original' : 'changed';
        },
      });
      class Evidence {
        get status() {
          reads.status += 1;
          return reads.status === 1 ? 202 : 200;
        }
        get headers() {
          reads.headers += 1;
          return observedHeaders;
        }
        get body() {
          reads.body += 1;
          return reads.body === 1 ? JSON.stringify(pending) : '{';
        }
      }
      const result = operation.parseResponse(new Evidence());
      assert.equal(result.kind, 'success');
      assert.equal(result.status, 202);
      assert.deepEqual(result.data, pending);
      assert.equal(result.headers['x-key'], 'original');
      assert.equal(result.validatedHeaders['x-key'], 'original');
      assert.deepEqual(reads, { status: 1, headers: 1, body: 1, value: 1 });
    },
  );

  await t.test(
    'numeric status evidence remains a protocol failure when undeclared',
    () => {
      for (const status of [0, -0, -1, 202.5, NaN, Infinity, -Infinity]) {
        const result = operation.parseResponse({
          status,
          headers: headers(),
          body: JSON.stringify(pending),
        });
        assert.equal(result.kind, 'protocol');
        assert.equal(result.status, status);
        assert.ok(result.issues.some((issue) => issue.part === 'status'));
        assert.equal(Object.hasOwn(result, 'data'), false);
      }
    },
  );

  await t.test(
    'every HTTP byte has the same acceptance in builder, merged headers and response headers',
    () => {
      const request = operation.build(options());
      for (let code = 0; code <= 255; code++) {
        const value = `left${String.fromCharCode(code)}right`;
        const accepted = code === 9 || (code >= 32 && code !== 127);
        const context = `HTTP byte ${code}`;
        const build = () =>
          operation.build({
            ...options(),
            headers: { 'Idempotency-Key': value },
          });
        const merge = () =>
          request.validateHeaders({ 'Idempotency-Key': value });
        if (accepted) {
          assert.equal(build().headers['Idempotency-Key'], value, context);
          assert.equal(merge()['idempotency-key'], value, context);
          assert.equal(
            new Headers(build().headers).get('Idempotency-Key'),
            value,
            context,
          );
        } else {
          assert.throws(build, RequestValidationError, context);
          assert.throws(merge, RequestValidationError, context);
        }
        const result = operation.parseResponse({
          status: 202,
          headers: { ...headers(), 'X-Key': value },
          body: JSON.stringify(pending),
        });
        assert.equal(result.kind, accepted ? 'success' : 'protocol', context);
        assert.equal(result.headers['x-key'], value, context);
        assert.equal(
          result.validatedHeaders['x-request-id'],
          'request',
          context,
        );
        if (accepted)
          assert.equal(result.validatedHeaders['x-key'], value, context);
        else {
          assert.equal(
            Object.hasOwn(result.validatedHeaders, 'x-key'),
            false,
            context,
          );
          assert.equal(Object.hasOwn(result, 'data'), false, context);
        }
      }
    },
  );

  await t.test(
    'all final HTTP statuses select only their declared payload and outcome',
    () => {
      const bodies: Record<number, unknown> = {
        200: { state: 'refused', reason: 'unavailable' },
        202: pending,
        303: { code: 'redirect', detail: 'see-other' },
        400: { code: 'invalid', detail: 'invalid input' },
        409: { code: 'conflict', retryable: false },
      };
      for (let status = 200; status <= 599; status++) {
        const declared = Object.hasOwn(bodies, status);
        const body = declared ? bodies[status] : pending;
        const result = operation.parseResponse({
          status,
          headers: headers(),
          body: JSON.stringify(body),
        });
        assert.equal(result.status, status);
        if (declared) {
          assert.equal(result.kind, status < 300 ? 'success' : 'error');
          assert.deepEqual(result.data, body);
        } else {
          assert.equal(result.kind, 'protocol');
          assert.ok(result.issues.some((issue) => issue.part === 'status'));
          assert.equal(Object.hasOwn(result, 'data'), false);
          assert.deepEqual(Object.keys(result.validatedHeaders), []);
        }
      }
    },
  );

  await t.test(
    'immutable request metadata cannot alter later authentication or headers',
    () => {
      const input = options();
      const first = operation.build(input);
      input.path.widgetId = 'changed';
      input.headers['Idempotency-Key'] = 'changed';
      input.body.label = 'changed';
      assert.equal(first.url, '/api/widgets/widget/preparations');
      assert.equal(first.headers['Idempotency-Key'], 'attempt');
      assert.equal(first.body.label, 'Synthetic');
      assert.equal(Reflect.set(first, 'url', '/changed'), false);
      assert.equal(Reflect.set(first.policy, 'retry', 'changed'), false);
      assert.equal(Reflect.set(first.policy.auth, 'transport', 'none'), false);
      assert.equal(
        Reflect.set(first.headers, 'Idempotency-Key', 'changed'),
        false,
      );
      const next = operation.build(options());
      assert.deepEqual(next.policy.auth, {
        label: 'session',
        transport: 'bearer',
      });
      assert.equal(next.headers['Idempotency-Key'], 'attempt');
    },
  );

  await t.test(
    'simultaneous failures preserve independent evidence without leaking state between parses',
    () => {
      const observed = {
        status: 202,
        headers: headers(),
        body: JSON.stringify(pending),
      };
      const before = operation.parseResponse(observed);
      assert.equal(before.kind, 'success');
      observed.headers['X-Request-ID'] = 'changed';
      assert.equal(before.headers['x-request-id'], 'request');
      assert.equal(before.validatedHeaders['x-request-id'], 'request');
      assert.equal(
        Reflect.set(before.headers, 'x-request-id', 'edited'),
        false,
      );
      const failure = operation.parseResponse({
        status: 202,
        headers: {
          'Content-Type': 'text/plain',
          'X-Request-ID': '',
          'X-Key': 'independent',
        },
        body: '{',
      });
      assert.equal(failure.kind, 'protocol');
      assert.deepEqual(
        new Set(failure.issues.map((issue) => issue.part)),
        new Set(['headers', 'content-type', 'body']),
      );
      assert.equal(failure.validatedHeaders['x-key'], 'independent');
      assert.equal(
        Object.hasOwn(failure.validatedHeaders, 'x-request-id'),
        false,
      );
      assert.equal(Object.hasOwn(failure, 'data'), false);
      const after = operation.parseResponse(observed);
      assert.equal(after.kind, 'success');
      assert.equal(after.validatedHeaders['x-request-id'], 'changed');
      assert.deepEqual(after.data, pending);
    },
  );
});
