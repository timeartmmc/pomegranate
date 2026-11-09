import assert from 'node:assert/strict';
import { compareArtifacts } from './comparison.ts';
import { readPlan } from './controller.ts';

const [plan, output, settings] = process.argv.slice(2);
assert.ok(
  plan && output && (process.argv.length === 4 || process.argv.length === 5),
  'usage: node bench/compare.ts <artifact-plan.json> <new-output-directory> [timing-settings.json]',
);
const report = await compareArtifacts(
  plan,
  output,
  settings === undefined ? {} : (await readPlan(settings)).value,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== 'complete') process.exitCode = 1;
