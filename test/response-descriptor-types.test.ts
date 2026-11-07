import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile } from '../dist/index.js';
import { generatedTestWorkspace } from './generated-workspace.ts';
import {
  responseDescriptorFixture,
  verifyResponseDescriptorDeclarations,
} from './response-descriptor-fixture.ts';

void test('response descriptor aliases preserve exact metadata and published status/media data correlations', async (t) => {
  const files = await compile(responseDescriptorFixture(), {
    clients: ['consumer'],
    surfaces: { consumer: ['read', 'empty'] },
  });
  const root = await generatedTestWorkspace(t, files);
  await verifyResponseDescriptorDeclarations(
    root,
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
  );
});
