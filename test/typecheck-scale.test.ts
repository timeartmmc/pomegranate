import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compile } from '../dist/index.js';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient } from './runtime-types.ts';
import {
  scaleCompilerOptions,
  typecheckScaleFixture,
} from './typecheck-scale-fixture.ts';

void test('distinct parser graphs retain every executable contract at scale', async (t) => {
  const count = 600;
  const input = typecheckScaleFixture(count);
  const root = await generatedTestWorkspace(
    t,
    await compile(input.document, input.options),
  );
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  assert.equal(Object.keys(client.operations).length, count);
  for (let index = 0; index < count; index++) {
    const operation = present(
      client.operations[`write${String(index).padStart(5, '0')}`],
    );
    const body = {
      kind: `kind${index}`,
      score: index,
      tags: ['tag'],
      [`field${index % 32}`]: 'a'.repeat((index % 32) + 1),
    };
    assert.deepEqual(operation.build({ body }).body, body);
    assert.equal(
      operation.parseResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).kind,
      'success',
    );
    assert.throws(() => operation.build({ body: { ...body, kind: 'wrong' } }));
    assert.equal(
      operation.parseResponse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, score: -1 }),
      }).kind,
      'protocol',
    );
  }
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: scaleCompilerOptions,
      include: ['./*.ts'],
    }),
  );
  await promisify(execFile)(process.execPath, [
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
});
