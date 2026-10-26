import assert from 'node:assert/strict';
import test from 'node:test';
import { multipleOf } from '../dist/runtime.js';

void test('decimal divisibility is invariant under shared powers of ten', () => {
  // Integer divisibility supplies an independent expected result. Rescaling
  // both values must preserve it even when JS spells them in scientific form.
  for (const exponent of [-250, -25, -2, 0, 2, 25, 250]) {
    for (const divisor of [2, 3, 7, 25, 200]) {
      const accepts = multipleOf(Number(`${divisor}e${exponent}`));
      for (let numerator = -210; numerator <= 210; numerator++) {
        const value = Number(`${numerator}e${exponent}`);
        assert.equal(
          accepts(value),
          numerator % divisor === 0,
          `${numerator}e${exponent} / ${divisor}e${exponent}`,
        );
      }
      for (const value of [NaN, Infinity, -Infinity])
        assert.equal(accepts(value), false);
    }
  }
});

void test('decimal multiples preserve subnormal and maximum finite boundaries', () => {
  const minimum = multipleOf(Number.MIN_VALUE);
  for (const value of [
    0,
    -0,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    2 * Number.MIN_VALUE,
    -2 * Number.MIN_VALUE,
  ])
    assert.equal(minimum(value), true, String(value));
  const maximum = multipleOf(Number.MAX_VALUE);
  for (const value of [0, -0, Number.MAX_VALUE, -Number.MAX_VALUE])
    assert.equal(maximum(value), true, String(value));
  for (const value of [1, -1, Number.MIN_VALUE, Number.MAX_VALUE / 2])
    assert.equal(maximum(value), false, String(value));
});
