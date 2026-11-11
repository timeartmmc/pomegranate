import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile } from '../dist/index.js';
import { executionFixture, executionSelection } from './execution-fixture.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { verifyStrictNullChecks } from './strict-null-checks.ts';

void test('generated clients and standalone validators require only strictNullChecks', async (t) => {
  const document = executionFixture();
  Object.assign(document.components.schemas, {
    NullFields: {
      type: 'object',
      required: ['required'],
      properties: {
        required: { type: 'null' },
        optional: { type: 'null' },
        read: { type: 'null', readOnly: true },
        write: { type: 'null', writeOnly: true },
      },
    },
  });
  const root = await generatedTestWorkspace(
    t,
    await compile(document, {
      ...executionSelection,
      standalone: {
        request: {
          schema: '#/components/schemas/NullFields',
          usage: 'request',
        },
        response: {
          schema: '#/components/schemas/NullFields',
          usage: 'response',
        },
      },
    }),
  );
  for (const usage of ['request', 'response']) {
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      `standalone.${usage}.ts`,
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
  await verifyStrictNullChecks(
    root,
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
  );
});
