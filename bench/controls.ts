import assert from 'node:assert/strict';
import { record } from './controller.ts';
import type { ValidationAdapter } from './timing.ts';

// A real-work challenge, not a claimed percentage slowdown. Every Nth main
// call performs the same validation again. Extra outputs escape and remain live
// until replaced; disposal consumes them outside the measured windows.
export function repeatValidation(
  base: ValidationAdapter,
  every: number,
): ValidationAdapter {
  assert.ok(Number.isSafeInteger(every) && every >= 0 && every <= 1024);
  const retained: unknown[] = Array(64).fill(undefined);
  let calls = 0;
  let extras = 0;
  return {
    identity: {
      ...base.identity,
      control: 'repeat-validation-v1',
      repeatEvery: String(every),
    },
    validate(input) {
      const result = base.validate(input);
      calls++;
      if (every > 0 && calls % every === 0) {
        retained[extras++ % retained.length] = base.validate(input);
      }
      return result;
    },
    async dispose() {
      try {
        // Keep extra results live through the timed windows. Observing their
        // verdict needs neither formatting nor traversal of adapter metadata.
        for (const value of retained) {
          if (value === undefined) continue;
          const result = record(value, 'extra validation result');
          assert.equal(typeof result.success, 'boolean');
        }
      } finally {
        await base.dispose?.();
      }
    },
  };
}
