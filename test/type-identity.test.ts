import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compile } from '../dist/index.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import { entry, runtimeInput } from './assertions.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import {
  typeIdentityConsumer,
  typeIdentityFixture,
  typeIdentitySelection,
  typeIdentityValue,
} from './type-identity-fixture.ts';

void test('component type identities compose at depth 128 across standalone, client and query APIs', async (t) => {
  const files = await compile(typeIdentityFixture(), typeIdentitySelection);
  const root = await generatedTestWorkspace(
    t,
    files,
    'type-identity-generated',
  );
  await writeFile(join(root, 'consumer.ts'), typeIdentityConsumer);
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        allowImportingTsExtensions: true,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: 'declarations',
      },
      include: ['consumer.ts', 'type-identity-generated/*.ts'],
    }),
  );
  await promisify(execFile)(process.execPath, [
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
  const request = await importGenerated<StandaloneModule>(
    root,
    'type-identity-generated/standalone.request.ts',
  );
  const response = await importGenerated<StandaloneModule>(
    root,
    'type-identity-generated/standalone.response.ts',
  );
  const client = await importGenerated<RuntimeClient>(
    root,
    'type-identity-generated/client.consumer.ts',
  );
  const value = typeIdentityValue();
  const parsed = request.schema.parse(value);
  const operation = entry(client.operations, 'save');
  assert.deepEqual(runtimeInput(operation.build, { body: parsed }).body, value);
  assert.deepEqual(response.schema.parse(parsed), value);
  assert.equal(
    request.schema.safeParse({ value: { kind: 'end', value: 'wrong' } })
      .success,
    false,
  );
  // Published consumers must retain the shared identities without source files.
  await rm(join(root, 'type-identity-generated'), { recursive: true });
  await rm(join(root, 'consumer.ts'));
  await writeFile(
    join(root, 'published.ts'),
    typeIdentityConsumer
      .replaceAll(
        './type-identity-generated/',
        './declarations/type-identity-generated/',
      )
      .replaceAll(".ts';", ".js';"),
  );
  await writeFile(
    join(root, 'published.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
      },
      include: ['published.ts'],
    }),
  );
  await promisify(execFile)(process.execPath, [
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    '-p',
    join(root, 'published.json'),
  ]);
});

void test('shared type modules retain each output closure and group by membership', async () => {
  const document = typeIdentityFixture();
  const files = await compile(document, typeIdentitySelection);
  assert.equal(
    Object.keys(files).filter((name) => name.startsWith('schema-types.'))
      .length,
    2,
  );
  function reachable(name: string, seen = new Set<string>()): string {
    if (seen.has(name)) return '';
    seen.add(name);
    const source = files[name];
    assert.ok(source, `missing module ${name}`);
    return (
      source +
      [...source.matchAll(/['"]\.\/([^'"]+\.ts)['"]/g)]
        .map((match) => reachable(match[1]!, seen))
        .join('\n')
    );
  }
  assert.doesNotMatch(
    reachable('client.staff.ts'),
    /Choice63|type_Root|privateMarker/,
  );
  assert.doesNotMatch(
    reachable('client.consumer.ts'),
    /privateMarker|client\.staff/,
  );
  assert.doesNotMatch(
    reachable('standalone.response.ts'),
    /privateMarker|client\./,
  );
  assert.deepEqual(
    await compile(document, {
      ...typeIdentitySelection,
      clients: ['staff', 'consumer'],
    }),
    files,
  );
});
