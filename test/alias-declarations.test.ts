import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile } from '../dist/index.js';
import {
  aliasDeclarationFixture,
  verifyAliasDeclarations,
} from './alias-declarations.ts';
import { generatedTestWorkspace } from './generated-workspace.ts';

void test('published aliases resolve long chains without source files or library checking', async (t) => {
  const input = aliasDeclarationFixture();
  const root = await generatedTestWorkspace(
    t,
    await compile(input.document, input.options),
    'source',
  );
  await verifyAliasDeclarations(
    root,
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
  );
});
