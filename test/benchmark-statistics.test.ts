import assert from 'node:assert/strict';
import test from 'node:test';
import { repeatValidation } from '../bench/controls.ts';
import { pairedMedianInterval } from '../bench/statistics.ts';

void test('exact median intervals respect sample size and the declared comparison family', () => {
  const ones = (n: number) => Array<number>(n).fill(1);
  const small = pairedMedianInterval(ones(5), ones(5), 1);
  assert.equal(small.lower, null);
  assert.equal(small.upper, null);
  assert.equal(small.signal, 'unresolved');
  // The full-line interval covers everything but supplies no detection bound.
  assert.equal(small.iidModelFamilyCoverageLowerBound, 1);
  const six = pairedMedianInterval(ones(6), [1, 2, 3, 4, 5, 6], 1);
  assert.deepEqual(six.ranks, [1, 6]);
  assert.equal(six.iidModelFamilyCoverageLowerBound, 0.96875);
  const sixteen = pairedMedianInterval(
    ones(16),
    Array.from({ length: 16 }, (_, i) => i + 1),
    9,
  );
  assert.deepEqual(sixteen.ranks, [3, 14]);
  assert.equal(sixteen.lower, 2);
  assert.equal(sixteen.upper, 13);
  assert.equal(sixteen.signal, 'slower');
  // 2*(C(16,0)+C(16,1)+C(16,2))=274 out of 65,536 sign
  // sequences exclude the true median; union bound over nine comparisons.
  assert.equal(
    sixteen.iidModelFamilyCoverageLowerBound,
    1 - (9 * 274) / 65_536,
  );
  const wider = pairedMedianInterval(
    ones(16),
    Array.from({ length: 16 }, (_, i) => i + 1),
    100,
  );
  assert.ok(wider.lower! <= sixteen.lower && wider.upper! >= sixteen.upper);
});

void test('paired effects retain ties and differ from ratios of marginal medians', () => {
  const reference = [1, 100, 100, 100, 100, 100];
  const candidate = [2, 200, 200, 50, 50, 50];
  const result = pairedMedianInterval(reference, candidate, 1);
  assert.equal(result.estimate, 0.25);
  assert.equal(result.signal, 'unresolved');
  assert.equal(
    pairedMedianInterval(
      Array<number>(16).fill(1),
      Array<number>(16).fill(1),
      9,
    ).signal,
    'unresolved',
  );
  assert.equal(
    pairedMedianInterval(
      Array<number>(16).fill(2),
      Array<number>(16).fill(1),
      9,
    ).signal,
    'faster',
  );
});

void test('finite large ratios retain a finite estimate', () => {
  assert.equal(pairedMedianInterval([1, 1], [1e308, 1e308], 1).estimate, 1e308);
});

void test('invalid paired samples and invalid comparison families cannot produce a verdict', () => {
  for (const [a, b, family] of [
    [[], [], 1],
    [[1], [], 1],
    [[0], [1], 1],
    [[1], [NaN], 1],
    [[1], [1], 0],
    [[1], [1], 1.5],
    [[Number.MIN_VALUE], [Number.MAX_VALUE], 1],
  ] as const)
    assert.throws(() => pairedMedianInterval(a, b, family));
});

void test('work controls add actual validations, preserve the primary result and bind disposal', async () => {
  for (const every of [0, 2, 64]) {
    const base = {
      identity: { name: 'test' },
      calls: 0,
      disposed: false,
      validate(input: unknown) {
        this.calls++;
        return { success: true, data: { input, call: this.calls } };
      },
      dispose() {
        this.disposed = true;
      },
    };
    const control = repeatValidation(base, every);
    for (let i = 0; i < 128; i++) {
      const before = base.calls;
      assert.deepEqual(control.validate(i), {
        success: true,
        data: { input: i, call: before + 1 },
      });
    }
    assert.equal(base.calls, 128 + (every ? 128 / every : 0));
    assert.equal(control.identity.repeatEvery, String(every));
    await control.dispose?.();
    assert.equal(base.disposed, true);
  }
  for (const every of [-1, 0.5, Infinity, 1025])
    assert.throws(() =>
      repeatValidation({ identity: {}, validate: () => undefined }, every),
    );
});

void test('control disposal cleans up its base when an extra result is malformed', async () => {
  let disposed = false;
  const broken = repeatValidation(
    {
      identity: {},
      validate: () => null,
      dispose() {
        disposed = true;
      },
    },
    1,
  );
  broken.validate({});
  await assert.rejects(
    async () => broken.dispose?.(),
    /extra validation result: expected an object/,
  );
  assert.equal(disposed, true);
});
