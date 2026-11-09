import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson, record } from './controller.ts';
import { benchmarkSources } from './installed.ts';
import { runOutputGrowth } from './output-growth.ts';

assert.ok(
  process.argv.length >= 2 && process.argv.length <= 4,
  'usage: node bench/check-output.ts [local-compiler-entry] [typescript-entry]',
);
const compilerEntry = process.argv[2]
  ? pathToFileURL(await realpath(process.argv[2])).href
  : import.meta.resolve('pomegranate-compiler');
const controller = await benchmarkSources();
const typeScriptEntry = process.argv[3]
  ? await realpath(process.argv[3])
  : fileURLToPath(
      new URL('bin/tsc', import.meta.resolve('typescript/package.json')),
    );
async function packageMetadata(entry: string) {
  const manifest = findPackageJSON(entry);
  // Loose entries may resolve to themselves. Versions describe the entry's
  // enclosing package (including wrappers), and optional metadata must never
  // prevent the supplied compiler or TypeScript entry from executing.
  if (manifest === undefined || basename(manifest) !== 'package.json')
    return { manifest: null, version: null };
  try {
    const input = await readJson(manifest, 64 * 1024);
    const metadata = record(input.value);
    return {
      manifest: input.path,
      version: typeof metadata.version === 'string' ? metadata.version : null,
    };
  } catch {
    return { manifest, version: null };
  }
}
const { manifest: compilerPackageManifest, version: compilerVersion } =
  await packageMetadata(compilerEntry);
const { manifest: typescriptPackageManifest, version: typescriptVersion } =
  await packageMetadata(pathToFileURL(typeScriptEntry).href);
const module: unknown = await import(compilerEntry);
const compile = record(module).compile;
assert.ok(typeof compile === 'function', 'compiler must export compile()');
const report = await runOutputGrowth(async (document, options) => {
  const value: unknown = await Reflect.apply(compile, module, [
    document,
    options,
  ]);
  return value;
}, typeScriptEntry);
assert.deepEqual(
  await benchmarkSources(),
  controller,
  'output benchmark sources changed during collection',
);
process.stdout.write(
  `${JSON.stringify({ ...report, compilerEntry, compilerVersion, compilerPackageManifest, typeScriptEntry, typescriptVersion, typescriptPackageManifest, controller, node: process.version }, null, 2)}\n`,
);
