import assert from 'node:assert/strict';
import { readPlan } from './controller.ts';
import { runTypecheck } from './typecheck.ts';

const [plan, output, settings] = process.argv.slice(2);
assert.ok(
  plan && output && process.argv.length <= 5,
  'usage: bun run bench:typecheck <artifact-plan.json> <new-output-directory> [settings.json]',
);
const report = await runTypecheck(
  plan,
  output,
  settings ? (await readPlan(settings)).value : {},
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
