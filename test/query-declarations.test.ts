import { symlink, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile } from '../dist/index.js';
import { temporary } from './helpers.ts';
import { verifyQueryDeclarations } from './query-declarations.ts';
import { queryFixture, querySelection } from './query-fixture.ts';

void test('query declarations publish usable factories, options and inferred application exports', async (t) => {
  const root = await temporary(t);
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const generated = join(root, 'query-generated');
  await mkdir(generated);
  for (const [name, source] of Object.entries(
    await compile(queryFixture(), querySelection),
  ))
    await writeFile(join(generated, name), source);
  await verifyQueryDeclarations(
    root,
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    fileURLToPath(new URL('./query-types.ts', import.meta.url)),
  );
});
