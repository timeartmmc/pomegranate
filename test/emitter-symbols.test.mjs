import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { compile } from '../dist/index.js';
import { symbolFixture, verifySymbols } from './symbol-fixture.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

test('operation IDs cannot collide with private validator scopes or escape sequences', async (t) => {
  const cache = join(repo, 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, 'pom-symbols-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'symbol-generated'));
  const files = await compile(symbolFixture(), {
    clients: ['symbols', 'other'],
  });
  for (const [name, source] of Object.entries(files))
    await writeFile(join(root, 'symbol-generated', name), source);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const config = JSON.parse(
    await readFile(join(repo, 'examples/json/tsconfig.json'), 'utf8'),
  );
  config.include = ['*.ts', 'symbol-generated/*.ts'];
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify(config));
  await cp(join(repo, 'test/symbol-types.ts'), join(root, 'symbol-types.ts'));
  await promisify(execFile)(process.execPath, [
    join(repo, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
  for (const client of ['symbols', 'other']) {
    const { operations, RequestValidationError } = await import(
      pathToFileURL(
        join(root, '.build/symbol-generated', `client.${client}.js`),
      ).href
    );
    verifySymbols(operations, RequestValidationError);
  }
});

test('symbol generation is deterministic and independent of other client projections', async () => {
  const document = symbolFixture();
  const files = await compile(document, { clients: ['symbols'] });
  document.paths = Object.fromEntries(Object.entries(document.paths).reverse());
  assert.deepEqual(await compile(document, { clients: ['symbols'] }), files);
  const both = await compile(document, { clients: ['symbols', 'other'] });
  for (const [name, source] of Object.entries(files))
    assert.equal(both[name], source);
  const extra = structuredClone(document.paths['/symbols/read/{entry}']);
  extra.post.operationId = 'aaa_read_options';
  extra.post['x-pom'].surfaces = ['other'];
  document.paths['/additional/{entry}'] = extra;
  assert.deepEqual(await compile(document, { clients: ['symbols'] }), files);
});
