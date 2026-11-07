import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile } from '../dist/index.js';
import { consumerModesFixture, verifyConsumerModes } from './consumer-modes.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';

void test('installed API and full generated modules support strict and non-strict consumers with no unused locals', async (t) => {
  const input = consumerModesFixture();
  const root = await generatedTestWorkspace(
    t,
    await compile(input.document, input.options),
  );
  for (let index = 0; index < 21; index++) {
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      `standalone.root${index}.ts`,
    );
    const wrap = (value: string) => (index % 3 === 0 ? value : { value });
    assert.deepEqual(schema.parse(wrap('valid')), wrap('valid'));
    for (const invalid of ['', 'a', 'A!', 'a'.repeat(33)])
      assert.equal(schema.safeParse(wrap(invalid)).success, false);
  }
  for (const usage of ['request', 'response']) {
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      `standalone.null-${usage}.ts`,
    );
    assert.deepEqual(schema.parse({ required: null, optional: null }), {
      required: null,
      optional: null,
    });
    assert.deepEqual(schema.parse({ required: null }), { required: null });
    assert.equal(schema.safeParse({ optional: null }).success, false);
    assert.equal(schema.safeParse({ required: 'wrong' }).success, false);
    if (usage === 'request')
      assert.equal(
        schema.safeParse({ required: null, read: null }).success,
        false,
      );
    else
      assert.deepEqual(schema.parse({ required: null, write: null }), {
        required: null,
      });
  }
  const { operations } = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const operation = operations.saveNulls;
  assert.ok(operation);
  assert.deepEqual(operation.build({ body: { required: null } }).body, {
    required: null,
  });
  assert.equal(
    operation.parseResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"required":null,"optional":null}',
    }).kind,
    'success',
  );
  await verifyConsumerModes(
    root,
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    fileURLToPath(new URL('../dist/index.js', import.meta.url)),
  );
});
