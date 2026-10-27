import { rm } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile } from '../dist/index.js';
import { generatedWorkspace } from './generated-workspace.ts';
import { verifyQueryDeclarations } from './query-declarations.ts';
import { queryFixture, querySelection } from './query-fixture.ts';

void test('query declarations publish usable factories, options and inferred application exports', async (t) => {
  const root = await generatedWorkspace(
    await compile(queryFixture(), querySelection),
    'query-generated',
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await verifyQueryDeclarations(
    root,
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    fileURLToPath(new URL('./query-types.ts', import.meta.url)),
  );
});
