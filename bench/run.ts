import assert from 'node:assert/strict';
import { runTiming, samplingPolicy, timingWorker } from './timing.ts';
import { record } from './controller.ts';
import { scenarios, runtimeProfiles } from './cases/json-response-runtime.ts';
import type { Scenario } from './cases/json-response-runtime.ts';

if (process.argv[2] === '--worker') {
  const [, , , adapter, mode, requestText] = process.argv;
  assert.ok(adapter && mode && requestText && process.argv.length === 6);
  assert.ok(mode === 'preflight' || scenarios.includes(mode as Scenario));
  const request = record(JSON.parse(requestText) as unknown);
  assert.deepEqual(
    Object.keys(request).sort(),
    [
      'seed',
      'policy',
      'profiles',
      ...(mode === 'preflight' ? [] : ['records']),
    ].sort(),
  );
  const seed = request.seed;
  assert.ok(
    typeof seed === 'number' &&
      Number.isSafeInteger(seed) &&
      seed >= 0 &&
      seed <= 0xffffffff,
  );
  const profile =
    mode === 'preflight'
      ? undefined
      : runtimeProfiles([{ scenario: mode, records: request.records }])[0];
  const result = await timingWorker(adapter, mode as 'preflight' | Scenario, {
    seed,
    policy: samplingPolicy(request.policy),
    profiles: runtimeProfiles(request.profiles),
    ...(profile ? { records: profile.records } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  const [plan, output] = process.argv.slice(2);
  assert.ok(
    plan && output && process.argv.length === 4,
    'usage: node bench/run.ts <timing-plan.json> <new-output-directory>',
  );
  const result = await runTiming(plan, output);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'complete') process.exitCode = 1;
}
