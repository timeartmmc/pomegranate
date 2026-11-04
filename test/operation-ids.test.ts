import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { generatedWorkspace } from './generated-workspace.ts';
import {
  operationIdsFixture,
  operationIdsSelection,
  operationIdsTypeConsumer,
} from './operation-ids-fixture.ts';
import { verifyOperationIds } from './operation-ids-checks.ts';
import { present } from './assertions.ts';

void test('operation strings preserve types, calls, queries, pagination and hydrated identities', async (t) => {
  const document = operationIdsFixture();
  const before = structuredClone(document);
  const files = await compile(document, operationIdsSelection);
  assert.deepEqual(document, before);
  // IDs are string data even when they would be invalid URL parameter values.
  assert.deepEqual(
    await compile(
      JSON.parse(JSON.stringify(document)) as unknown,
      operationIdsSelection,
    ),
    files,
  );
  assert.deepEqual(
    await compile(
      parseYaml(stringify(document), 'ids.yaml'),
      operationIdsSelection,
    ),
    files,
  );
  document.paths = Object.fromEntries(Object.entries(document.paths).reverse());
  assert.deepEqual(await compile(document, operationIdsSelection), files);
  const root = await generatedWorkspace(files, 'operation-ids-generated');
  t.after(() => rm(root, { recursive: true, force: true }));
  const module = (await import(
    pathToFileURL(join(root, 'operation-ids-generated/client.consumer.ts')).href
  )) as typeof import('./.generated/operation-ids/client.consumer.ts');
  const queries = (await import(
    pathToFileURL(
      join(root, 'operation-ids-generated/client.consumer.queries.ts'),
    ).href
  )) as typeof import('./.generated/operation-ids/client.consumer.queries.ts');
  await verifyOperationIds(module, queries);
  await writeFile(join(root, 'consumer.ts'), operationIdsTypeConsumer());
  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      strict: true,
      declaration: true,
      emitDeclarationOnly: true,
      rewriteRelativeImportExtensions: true,
      outDir: 'declarations',
    },
    include: ['consumer.ts', 'operation-ids-generated/*.ts'],
  };
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify(config));
  const tsc = fileURLToPath(
    new URL('../node_modules/typescript/bin/tsc', import.meta.url),
  );
  await promisify(execFile)(process.execPath, [
    tsc,
    '-p',
    join(root, 'tsconfig.json'),
  ]);
  await rm(join(root, 'operation-ids-generated'), { recursive: true });
  await rm(join(root, 'consumer.ts'));
  await writeFile(
    join(root, 'published.ts'),
    `import {read,createApi} from './declarations/consumer.js'; type Tag=Awaited<ReturnType<typeof read>>; const tag:Tag='repos/get'; void tag; type Api=ReturnType<typeof createApi>; export type Item=Awaited<ReturnType<Api['repos/get']['call']>>['data'];\n// @ts-expect-error Published response literals must preserve punctuation.\nconst wrong:Tag='repos_get'; void wrong;`,
  );
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        strict: true,
        noEmit: true,
      },
      include: ['published.ts', 'declarations/**/*.d.ts'],
    }),
  );
  await promisify(execFile)(process.execPath, [
    tsc,
    '-p',
    join(root, 'tsconfig.json'),
  ]);
});

void test('operation string acceptance retains duplicate, empty and reserved-key diagnostics', async () => {
  for (const id of ['', '__proto__', 'constructor', 'prototype', 'repos/get']) {
    const document = operationIdsFixture();
    Object.assign(present(document.paths['/items/1']).get, { operationId: id });
    await assert.rejects(
      compile(document, operationIdsSelection),
      id === ''
        ? /expected a nonempty string/
        : id === 'repos/get'
          ? /duplicate operation identifier/
          : /unsupported object key/,
    );
  }
});
