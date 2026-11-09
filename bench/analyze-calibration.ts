import assert from 'node:assert/strict';
import { analyzeCalibration } from './calibration.ts';

const [plan, output] = process.argv.slice(2);
assert.ok(
  plan && output && process.argv.length === 4,
  'usage: node bench/analyze-calibration.ts <study-plan.json> <new-output-directory>',
);
const report = await analyzeCalibration(plan, output);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
