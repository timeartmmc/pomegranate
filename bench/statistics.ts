import assert from 'node:assert/strict';

export const calibrationMethod = Object.freeze({
  id: 'paired-median-sign-v1',
  status: 'unqualified candidate detector; no product acceptance verdict',
  estimator: 'median paired process cost ratio minus one',
  familyAlpha: Object.freeze({ numerator: 1, denominator: 20 }),
  correction:
    'Bonferroni across the predeclared comparisons and profiles within each session',
  assumption:
    'independent paired-block effects with a common population median; session grouping does not establish independence',
});

// Exact order-statistic ranks for a sign-test median interval. At rank k, the
// two tails have mass 2*Pr(Binomial(n,1/2)<=k-1). BigInt keeps rank selection
// exact at the rational family cutoff. See EnvStats::eqnpar (ci.method="exact")
// and https://www.stat.umn.edu/geyer/3011/examp/conf.html .
export function pairedMedianInterval(
  reference: readonly number[],
  candidate: readonly number[],
  familySize: number,
) {
  assert.ok(
    reference.length > 0 &&
      reference.length <= 100 &&
      candidate.length === reference.length,
  );
  assert.ok(
    Number.isSafeInteger(familySize) && familySize >= 1 && familySize <= 1024,
  );
  const effects = reference.map((cost, index) => {
    const other = candidate[index]!;
    assert.ok(
      Number.isFinite(cost) && cost > 0 && Number.isFinite(other) && other > 0,
    );
    const ratio = other / cost;
    assert.ok(Number.isFinite(ratio) && ratio > 0);
    return ratio - 1;
  });
  const sorted = [...effects].sort((a, b) => a - b);
  const n = sorted.length;
  const denominator = 1n << BigInt(n);
  let choose = 1n;
  let tail = 0n;
  let acceptedTail = 0n;
  let rank = 0;
  const alpha = calibrationMethod.familyAlpha;
  for (let j = 0; j < Math.floor(n / 2); j++) {
    tail += choose;
    if (
      2n * tail * BigInt(alpha.denominator) * BigInt(familySize) >
      BigInt(alpha.numerator) * denominator
    )
      break;
    rank = j + 1;
    acceptedTail = tail;
    choose = (choose * BigInt(n - j)) / BigInt(j + 1);
  }
  const middle = Math.floor(n / 2);
  const estimate =
    n % 2 ? sorted[middle]! : sorted[middle - 1]! / 2 + sorted[middle]! / 2;
  // With too few pairs, null bounds represent the full real line: coverage 1
  // is vacuous and the signal stays unresolved, not a finite detection bound.
  const lower = rank ? sorted[rank - 1]! : null;
  const upper = rank ? sorted[n - rank]! : null;
  return {
    pairs: n,
    familySize,
    effects,
    estimate,
    lower,
    upper,
    ranks: rank ? [rank, n - rank + 1] : null,
    iidModelFamilyCoverageLowerBound:
      1 - (familySize * 2 * Number(acceptedTail)) / Number(denominator),
    signal:
      lower !== null && lower > 0
        ? 'slower'
        : upper !== null && upper < 0
          ? 'faster'
          : 'unresolved',
  };
}
