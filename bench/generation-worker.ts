import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeJson } from './controller.ts';

const [cli, config, warmupConfig, mode, resultPath] = process.argv.slice(2);
assert.ok(
  cli &&
    config &&
    warmupConfig &&
    resultPath &&
    (mode === 'cold' || mode === 'warm'),
  'expected CLI, measured/warmup configs, cold|warm and result path',
);

async function generate(configPath: string, phase: string) {
  process.argv = [process.execPath, cli!, 'generate', '--config', configPath];
  const entry = pathToFileURL(cli!);
  // Reevaluate the actual CLI entry for each invocation; its project/compiler
  // dependencies retain their normal module cache for the warm invocation.
  entry.searchParams.set('benchmark', phase);
  await import(entry.href);
  assert.ok(
    !process.exitCode,
    `generation ${phase} failed with exit code ${String(process.exitCode)}`,
  );
}
function completed(configPath: string, phase: string) {
  // The maintained CLI awaits generation at module top level. Refuse a CLI
  // that returns early: its last-written ownership manifest must already exist.
  // Keep this check synchronous so pending asynchronous generation cannot finish
  // while an awaited filesystem check runs after an under-reported interval.
  assert.ok(
    statSync(join(dirname(configPath), phase, '.pom-manifest.json'), {
      throwIfNoEntry: false,
    })?.isFile(),
    'CLI module must await generation completion before returning',
  );
}
if (mode === 'warm') {
  await generate(warmupConfig, 'warmup');
  completed(warmupConfig, 'warmup');
}
const start = performance.now();
await generate(config, 'measured');
const generationMs = performance.now() - start;
// Node normalizes maxRSS to KiB on all platforms. This is the worker's lifetime
// high-water mark, including compiler loading and any untimed warmup, not a delta
// or a sampled heap figure. https://nodejs.org/api/process.html#processresourceusage
const peakRssKiB = process.resourceUsage().maxRSS;
completed(config, 'measured');
await writeJson(resultPath, {
  schemaVersion: 1,
  mode,
  generationMs,
  peakRssKiB,
  node: process.version,
  cli,
});
