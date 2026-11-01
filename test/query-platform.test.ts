import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile } from '../dist/index.js';
import { executionFixture, executionSelection } from './execution-fixture.ts';
import { generatedWorkspace } from './generated-workspace.ts';
import { verifyQueryPlatform } from './query-platform-check.ts';

void test('query-only ordinary, cursor and offset output needs no AbortController, Node or DOM declarations', async (t) => {
  const root = await generatedWorkspace(
    await compile(executionFixture(), {
      ...executionSelection,
      executionClients: [],
    }),
    'query-generated',
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await verifyQueryPlatform(
    root,
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
  );
});
