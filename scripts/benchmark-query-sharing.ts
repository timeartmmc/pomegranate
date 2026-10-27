import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { replaceEqualDeep } from '@tanstack/query-core';
import { shareQueryData } from '../src/query-sharing.ts';

// Run with Node directly. Timings are diagnostic, never a machine-dependent CI
// threshold; acceptance checks enforce traversal work and graph correctness.
const variants: readonly {
  name: string;
  share: typeof shareQueryData;
}[] = [
  { name: 'POM', share: shareQueryData },
  { name: 'TanStack', share: replaceEqualDeep },
];

for (const size of [1_000, 10_000]) {
  const rows = Array.from({ length: size }, (_, id) => ({
    id,
    label: `Item ${id}`,
    tags: ['one', 'two'],
    meta: { rank: id, active: id % 2 === 0 },
  }));
  const previous = { rows };
  const fresh = structuredClone(previous);
  const changed = structuredClone(previous);
  changed.rows[size - 1]!.meta.rank++;
  const cases: readonly {
    name: string;
    previous: unknown;
    next: unknown;
  }[] = [
    { name: 'cold selection', previous: undefined, next: rows },
    { name: 'identical selection', previous: rows, next: rows },
    { name: 'wrapper with retained rows', previous, next: { rows } },
    { name: 'equal refetch', previous, next: fresh },
    { name: 'changed refetch', previous, next: changed },
    { name: 'append', previous: rows, next: [...rows, { id: size }] },
    {
      name: 'append page',
      previous: { pages: [previous] },
      next: { pages: [previous, fresh] },
    },
  ];

  for (const scenario of cases) {
    const samples = variants.map((): number[] => []);
    const outputs: unknown[] = [];
    // Interleave implementations so collection pressure and warmup do not
    // consistently favor one. Retain outputs and verify values outside timing.
    for (let round = 0; round < 20; round++) {
      for (let position = 0; position < variants.length; position++) {
        const index = round % 2 ? variants.length - position - 1 : position;
        const variant = variants[index]!;
        const start = performance.now();
        outputs[index] = variant.share(scenario.previous, scenario.next);
        const elapsed = performance.now() - start;
        if (round >= 5) samples[index]!.push(elapsed);
      }
    }
    for (const [index, variant] of variants.entries()) {
      assert.deepEqual(outputs[index], scenario.next);
      const times = samples[index]!.sort((left, right) => left - right);
      console.log(
        JSON.stringify({
          node: process.version,
          items: size,
          scenario: scenario.name,
          implementation: variant.name,
          medianMs: Number(times[7]!.toPrecision(4)),
          p95Ms: Number(times[14]!.toPrecision(4)),
        }),
      );
    }
  }
}
