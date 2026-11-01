import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { commandError } from './assertions.ts';

export async function verifyQueryPlatform(
  directory: string,
  compiler: string,
  outputs: readonly string[] = ['query-generated'],
): Promise<void> {
  // Model an existing native platform instead of importing Node's broader
  // globals. In particular, supplying a query signal requires no controller.
  const platform = join(directory, 'query-platform');
  await mkdir(platform, { recursive: true });
  const globals = join(platform, 'globals.d.ts');
  await writeFile(
    globals,
    `
    interface AbortSignal { readonly aborted: boolean; readonly reason?: unknown; }
    interface VoidFunction { (): void; }
    declare class URL {}
    declare class URLSearchParams {
      append(name: string, value: string): void;
      toString(): string;
    }
  `,
  );
  const config = join(platform, 'tsconfig.json');
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022'],
        types: [],
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noPropertyAccessFromIndexSignature: true,
        skipLibCheck: false,
        allowImportingTsExtensions: true,
        noEmit: true,
      },
      include: [
        ...outputs.map((output) => `../${output}/*.ts`),
        'globals.d.ts',
      ],
    }),
  );
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)(
      process.execPath,
      [compiler, '-p', config, '--listFiles'],
      { cwd: directory, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch (error) {
    const failure = commandError(error);
    failure.message += `\n${failure.stdout}${failure.stderr}`;
    throw failure;
  }
  const files = stdout
    .trim()
    .split(/\r?\n/)
    .map((file) => resolve(file));
  assert.ok(files.includes(globals));
  assert.ok(files.some((file) => file.endsWith('query-runtime.ts')));
  assert.ok(
    files.every((file) => !/lib\.dom\.|[/\\]@types[/\\]node[/\\]/.test(file)),
    'query-only consumers must not inherit DOM or Node declarations',
  );
}
