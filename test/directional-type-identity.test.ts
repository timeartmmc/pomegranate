import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compile, ContractError } from '../dist/index.js';
import { entry, runtimeInput } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import {
  directionalTypeIdentityConsumer,
  directionalTypeIdentityFixture,
  directionalTypeIdentitySelection,
  directionalTypeIdentityValue,
} from './directional-type-identity-fixture.ts';

for (const plain of [false, true]) {
  void test(`compatible directional ${plain ? 'objects' : 'tagged unions'} compose at depth 128 in source and published declarations`, async (t) => {
    const files = await compile(
      directionalTypeIdentityFixture(plain),
      directionalTypeIdentitySelection,
    );
    const root = await generatedTestWorkspace(t, files, 'generated');
    await writeFile(
      join(root, 'consumer.ts'),
      directionalTypeIdentityConsumer(plain),
    );
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
        include: ['consumer.ts', 'generated/*.ts'],
      }),
    );
    const typecheck = (config: string) =>
      promisify(execFile)(process.execPath, [
        fileURLToPath(
          new URL('../node_modules/typescript/bin/tsc', import.meta.url),
        ),
        '-p',
        join(root, config),
      ]);
    await typecheck('tsconfig.json');

    const request = await importGenerated<StandaloneModule>(
      root,
      'generated/standalone.request.ts',
    );
    const response = await importGenerated<StandaloneModule>(
      root,
      'generated/standalone.response.ts',
    );
    const client = await importGenerated<RuntimeClient>(
      root,
      'generated/client.consumer.ts',
    );
    const operation = entry(client.operations, 'save');
    const value = directionalTypeIdentityValue(undefined, plain);
    const parsed = response.schema.parse(
      directionalTypeIdentityValue({ value: 'leaf', secret: 'removed' }, plain),
    );
    assert.deepEqual(parsed, value);
    const built = runtimeInput(operation.build, { body: parsed });
    assert.deepEqual(built.body, value);
    assert.notEqual(built.body, parsed);
    assert.deepEqual(request.schema.parse(parsed), value);
    const observed = built.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    assert.equal(observed.kind, 'success');
    if (observed.kind === 'success')
      assert.deepEqual(
        runtimeInput(operation.build, { body: observed.data }).body,
        value,
      );
    const wrong = directionalTypeIdentityValue({ value: 1 }, plain);
    assert.equal(request.schema.safeParse(wrong).success, false);
    assert.throws(
      () => runtimeInput(operation.build, { body: wrong }),
      client.RequestValidationError,
    );
    const required = entry(client.operations, 'required');
    const requiredValue = directionalTypeIdentityValue(
      { value: 'leaf', secret: 'required' },
      plain,
    );
    assert.deepEqual(
      runtimeInput(required.build, { body: requiredValue }).body,
      requiredValue,
    );
    const requiredResponse = required.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requiredValue),
    });
    assert.equal(requiredResponse.kind, 'success');
    if (requiredResponse.kind === 'success') {
      assert.deepEqual(requiredResponse.data, value);
      assert.throws(
        () => runtimeInput(required.build, { body: requiredResponse.data }),
        client.RequestValidationError,
      );
    }

    // Repeat the same public assignments after source modules have been removed.
    await rm(join(root, 'generated'), { recursive: true });
    await rm(join(root, 'consumer.ts'));
    await writeFile(
      join(root, 'published.ts'),
      directionalTypeIdentityConsumer(plain)
        .replaceAll('./generated/', './declarations/generated/')
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
    await typecheck('published.json');
  });
}

void test('directional family argument expansion respects the generated source budget', async () => {
  const schemas = Object.fromEntries(
    Array.from({ length: 120 }, (_, index) => [
      `Node${index}`,
      {
        type: 'object',
        properties: {
          marker: {
            type: 'string',
            const: 'x'.repeat(16 * 1024),
            writeOnly: true,
          },
          value:
            index === 0
              ? { type: 'string' }
              : { $ref: `#/components/schemas/Node${index - 1}` },
        },
        required: ['value'],
      },
    ]),
  );
  await assert.rejects(
    compile(
      {
        openapi: '3.1.2',
        info: { title: 'Synthetic directional budget', version: '1' },
        paths: {},
        components: { schemas },
      },
      {
        clients: [],
        standalone: {
          request: { schema: '#/components/schemas/Node119', usage: 'request' },
          response: {
            schema: '#/components/schemas/Node119',
            usage: 'response',
          },
        },
      },
    ),
    (error) => {
      assert.ok(error instanceof ContractError);
      assert.match(error.message, /generated source exceeds the 32 MiB limit/);
      return true;
    },
  );
});
