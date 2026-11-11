import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { commandError } from './assertions.ts';

export async function verifyStrictNullChecks(
  root: string,
  compiler: string,
): Promise<void> {
  const config = join(root, 'strict-null-checks.json');
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        types: [],
        strict: false,
        strictNullChecks: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        skipLibCheck: false,
      },
      include: ['./*.ts'],
    }),
  );
  const typecheck = promisify(execFile);
  await typecheck(process.execPath, [compiler, '-p', config], { cwd: root });
  await assert.rejects(
    typecheck(
      process.execPath,
      [compiler, '-p', config, '--strictNullChecks', 'false'],
      { cwd: root },
    ),
    (error: unknown) =>
      commandError(error).stdout.includes(
        'Pomegranate output requires strictNullChecks',
      ),
  );
}
