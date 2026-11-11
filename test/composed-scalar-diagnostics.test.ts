import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';

void test('composed scalars retain independent assertion diagnostics and reject wrong types before constraints', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(
      {
        openapi: '3.1.2',
        info: { title: 'Synthetic scalar diagnostics', version: '1' },
        paths: {},
        components: {
          schemas: {
            Value: {
              allOf: [
                { type: 'string', minLength: 1, pattern: '^A' },
                { type: 'string', pattern: 'Z$' },
                { type: 'string', format: 'email' },
              ],
            },
          },
        },
      },
      {
        clients: [],
        standalone: {
          value: { schema: '#/components/schemas/Value', usage: 'request' },
        },
      },
    ),
  );
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.value.ts',
  );
  const failure = schema.safeParse('bad');
  assert.equal(failure.success, false);
  if (failure.success) assert.fail('all assertions must validate');
  assert.equal(
    failure.error.issues.filter(({ message }) => /pattern/.test(message))
      .length,
    2,
  );
  assert.equal(
    failure.error.issues.filter(({ message }) => /email/.test(message)).length,
    1,
  );
  const wrongType = schema.safeParse(1);
  assert.equal(wrongType.success, false);
  if (!wrongType.success)
    assert.deepEqual(wrongType.error.issues, [
      { path: [], message: 'expected a string' },
    ]);
  assert.equal(schema.parse('AZ@example.Z'), 'AZ@example.Z');
});
