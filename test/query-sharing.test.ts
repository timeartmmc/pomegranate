import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { compile } from '../dist/index.js';
import { generatedWorkspace } from './generated-workspace.ts';
import { infiniteFixture, infiniteSelection } from './infinite-fixture.ts';
import { querySharingChecks } from './query-sharing-checks.ts';

type Module = typeof import('./.generated/infinite/client.consumer.queries.ts');
let root: string;
let module: Module;
before(async () => {
  root = await generatedWorkspace(
    await compile(infiniteFixture(), infiniteSelection),
  );
  module = (await import(
    pathToFileURL(join(root, 'client.consumer.queries.ts')).href
  )) as Module;
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
for (const [name, check] of Object.entries(querySharingChecks))
  void test(name, () => check(module));
