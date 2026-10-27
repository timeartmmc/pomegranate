import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '../dist/index.js';
import { infiniteFixture, infiniteSelection } from './infinite-fixture.ts';
import { infiniteLifecycleChecks } from './infinite-lifecycle-checks.ts';

type Module = typeof import('./.generated/infinite/client.consumer.queries.ts');
const repo = fileURLToPath(new URL('..', import.meta.url));
let root: string;
let module: Module;

before(async () => {
  root = await mkdtemp(
    join(await realpath(tmpdir()), 'pom-infinite-lifecycle-'),
  );
  await symlink(
    join(repo, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries(
    await compile(infiniteFixture(), infiniteSelection),
  ))
    await writeFile(join(root, name), source);
  module = (await import(
    pathToFileURL(join(root, 'client.consumer.queries.ts')).href
  )) as Module;
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

for (const [name, check] of Object.entries(infiniteLifecycleChecks))
  void test(name, async () => {
    await check(module);
  });
