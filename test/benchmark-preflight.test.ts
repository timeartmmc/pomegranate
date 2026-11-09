import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { compile } from '../dist/index.js';
import {
  jsonResponseSubject,
  jsonResponseWorkload,
  verifyJsonResponse,
} from '../bench/cases/json-response.ts';
import type { JsonResponseSubject } from '../bench/cases/json-response.ts';
import { json, record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';

const exec = promisify(execFile);

void test('benchmark preflight runs generated code without checkout dependencies and reports no performance verdict', async () => {
  const { stdout } = await exec(process.execPath, [
    fileURLToPath(new URL('../bench/preflight.ts', import.meta.url)),
  ]);
  const result = record(json(stdout));
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(result.case, { id: 'json-response', version: 1 });
  assert.match(String(result.caseSha256), /^[a-f0-9]{64}$/);
  assert.equal(result.behavior, 'verified');
  assert.equal(result.performance, 'unmeasured');
  assert.equal(result.node, process.version);
  const files = result.generated;
  assert.ok(Array.isArray(files) && files.length > 0);
  for (const value of files) {
    const file = record(value);
    assert.equal(typeof file.name, 'string');
    assert.ok(typeof file.bytes === 'number' && file.bytes > 0);
    assert.match(String(file.sha256), /^[a-f0-9]{64}$/);
  }
});

void test('benchmark oracle accepts real generated behavior and rejects faster shortcuts', async (t) => {
  const { document, options } = jsonResponseWorkload();
  const root = await generatedTestWorkspace(
    t,
    await compile(document, options),
  );
  const client = await importGenerated<unknown>(root, 'client.consumer.ts');
  const schemas = await importGenerated<unknown>(
    root,
    'client.consumer.schemas.ts',
  );
  const subject = jsonResponseSubject(client, schemas);
  verifyJsonResponse(subject);

  const corruptSuccess = (
    alter: (result: Record<string, unknown>, input: unknown) => void,
  ): JsonResponseSubject => ({
    ...subject,
    validate(input) {
      const result = record(subject.validate(input));
      if (result.success === true) alter(result, input);
      return result;
    },
  });

  await t.test('returning caller data', () => {
    assert.throws(
      () =>
        verifyJsonResponse(
          corruptSuccess((result, input) => {
            result.data = input;
          }),
        ),
      assert.AssertionError,
    );
  });

  await t.test(
    'retaining a nested container with otherwise correct values',
    () => {
      const mutant = corruptSuccess((result, input) => {
        const sourceItems = record(input).items;
        const outputItems = record(result.data).items;
        assert.ok(Array.isArray(sourceItems) && Array.isArray(outputItems));
        if (sourceItems.length > 0)
          record(outputItems[0]).details = record(sourceItems[0]).details;
      });
      assert.throws(
        () => verifyJsonResponse(mutant),
        /output must detach every container/,
      );
    },
  );

  await t.test(
    'mutating the caller input while producing correct output',
    () => {
      const mutant = corruptSuccess((_result, input) => {
        record(input).mutation = true;
      });
      assert.throws(
        () => verifyJsonResponse(mutant),
        /validation must preserve its input/,
      );
    },
  );

  await t.test('skipping constraints on invalid values', () => {
    const mutant: JsonResponseSubject = {
      ...subject,
      validate(input) {
        const result = record(subject.validate(input));
        return result.success === true ? result : { success: true, data: {} };
      },
    };
    assert.throws(() => verifyJsonResponse(mutant), assert.AssertionError);
  });

  await t.test('reading a field excluded from the response', () => {
    const mutant: JsonResponseSubject = {
      ...subject,
      validate(input) {
        const items = record(input).items;
        if (Array.isArray(items))
          for (const item of items) void record(item).secret;
        return subject.validate(input);
      },
    };
    assert.throws(
      () => verifyJsonResponse(mutant),
      /excluded response field was read/,
    );
  });

  await t.test('accepting invalid protocol responses', () => {
    const mutant: JsonResponseSubject = {
      ...subject,
      parseResponse(input) {
        const result = record(subject.parseResponse(input));
        return { ...result, kind: 'success' };
      },
    };
    assert.throws(() => verifyJsonResponse(mutant), assert.AssertionError);
  });

  await t.test('building the wrong operation', () => {
    assert.throws(
      () =>
        verifyJsonResponse({
          ...subject,
          build: () => ({ method: 'GET', url: '/wrong' }),
        }),
      assert.AssertionError,
    );
  });

  await t.test('dropping the operation from its inventory', () => {
    assert.throws(
      () => jsonResponseSubject({ operations: {} }, schemas),
      assert.AssertionError,
    );
  });
});
