import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
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
async function packageVersion(entry: string) {
  const manifest = findPackageJSON(entry);
  if (manifest === undefined) return null;
  const metadata = record((await readJson(manifest, 64 * 1024)).value);
  return typeof metadata.version === 'string' ? metadata.version : null;
}
const compilerVersion = await packageVersion(compilerEntry);
const typescriptVersion = await packageVersion(
  pathToFileURL(typeScriptEntry).href,
);
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
  `${JSON.stringify({ ...report, compilerEntry, compilerVersion, typeScriptEntry, typescriptVersion, controller, node: process.version }, null, 2)}\n`,
);
