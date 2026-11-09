import assert from 'node:assert/strict';
import { prepareArtifacts } from './artifacts.ts';

const [plan, output] = process.argv.slice(2);
assert.ok(
  process.argv.length === 4 && plan && output,
  'usage: node bench/prepare.ts <plan.json> <new-output-directory>',
);
const report = await prepareArtifacts(plan, output);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
