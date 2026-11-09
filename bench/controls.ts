import assert from 'node:assert/strict';
import { inspect } from 'node:util';
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
        // Observe the declared outputs without imposing JSON serialization on
        // arbitrary Error metadata or invoking adapter inspection hooks.
        const outputs = retained.map((value) => {
          if (value === undefined) return value;
          const result = record(value);
          if (result.success === true) return { data: result.data };
          assert.equal(result.success, false);
          const issues = record(result.error).issues;
          assert.ok(Array.isArray(issues));
          return {
            issues: issues.map((value: unknown) => {
              const issue = record(value);
              return { path: issue.path, message: issue.message };
            }),
          };
        });
        assert.ok(
          inspect(
            { calls, extras, outputs },
            {
              depth: null,
              customInspect: false,
              getters: false,
              maxArrayLength: null,
              maxStringLength: null,
            },
          ).length > 0,
        );
      } finally {
        await base.dispose?.();
      }
    },
  };
}
