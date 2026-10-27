import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { before, after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { compile } from '../dist/index.js';
import { generatedWorkspace } from './generated-workspace.ts';
import { infiniteFixture, infiniteSelection } from './infinite-fixture.ts';
import { queryErrorChecks } from './query-error-checks.ts';

type Module = typeof import('./.generated/infinite/client.consumer.queries.ts');
type Staff = typeof import('./.generated/infinite/client.staff.queries.ts');
let root: string;
let module: Module;
let staff: Staff;
before(async () => {
  root = await generatedWorkspace(
    await compile(infiniteFixture(), infiniteSelection),
  );
  module = (await import(
    pathToFileURL(join(root, 'client.consumer.queries.ts')).href
  )) as Module;
  staff = (await import(
    pathToFileURL(join(root, 'client.staff.queries.ts')).href
  )) as Staff;
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
for (const [name, check] of Object.entries(queryErrorChecks))
  void test(name, () => check(module, staff));
