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

void test('compiler API and generated public calls support strict and non-strict consumers with no unused locals', async (t) => {
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
  for (const width of [128, 129]) {
    const body: Record<string, unknown> = {
      direct: null,
      reference: null,
      enumeration: null,
      constant: null,
      field2: 'retained',
    };
    for (const usage of ['request', 'response']) {
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        `standalone.wide-null${width}-${usage}.ts`,
      );
      const parsed = schema.parse(body);
      assert.deepEqual(parsed, body);
      assert.notEqual(parsed, body);
      for (const optional of [null, undefined])
        assert.deepEqual(schema.parse({ ...body, optional }), {
          ...body,
          optional,
        });
      for (const key of ['direct', 'reference', 'enumeration', 'constant']) {
        const missing = { ...body };
        delete missing[key];
        assert.equal(schema.safeParse(missing).success, false);
        assert.equal(
          schema.safeParse({ ...body, [key]: 'wrong' }).success,
          false,
        );
      }
    }
    const wide = operations[`saveWideNull${width}`];
    assert.ok(wide);
    const request = wide.build({ body });
    assert.deepEqual(request.body, body);
    assert.notEqual(request.body, body);
    const response = request.parseResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.kind, 'success');
    if (response.kind === 'success') assert.deepEqual(response.data, body);
  }
  await verifyConsumerModes(
    root,
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    fileURLToPath(new URL('../dist/index.js', import.meta.url)),
  );
});
