import { z } from 'zod';
import { fail } from './diagnostics.js';
import type { Constraints, Scalar, Schema } from './model.js';
import { dateTime, multipleOf, patternTest } from './runtime.js';

const formats = { date: z.iso.date(), 'date-time': dateTime, uuid: z.guid() };

function adjacentNumber(value: number, direction: 1 | -1): number {
  if (value === 0) return direction * Number.MIN_VALUE;
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value);
  const step = value > 0 === direction > 0 ? 1n : -1n;
  bits.setBigUint64(0, bits.getBigUint64(0) + step);
  return bits.getFloat64(0);
}

export function intersectConstraints(
  base: Constraints,
  extra: Constraints,
): Constraints {
  const merged = { ...base, ...extra };
  for (const key of [
    'minimum',
    'exclusiveMinimum',
    'minLength',
    'minItems',
  ] as const) {
    const left = base[key];
    const right = extra[key];
    if (left !== undefined && right !== undefined)
      merged[key] = Math.max(left, right);
  }
  for (const key of [
    'maximum',
    'exclusiveMaximum',
    'maxLength',
    'maxItems',
  ] as const) {
    const left = base[key];
    const right = extra[key];
    if (left !== undefined && right !== undefined)
      merged[key] = Math.min(left, right);
  }
  return merged;
}

export function assertScalarRules(
  kind: Schema['kind'],
  limits: Constraints,
  literals: readonly Scalar[] | undefined,
  location: string,
  format?: 'date' | 'date-time' | 'uuid',
): void {
  for (const [minimum, maximum] of [
    ['minLength', 'maxLength'],
    ['minItems', 'maxItems'],
  ] as const) {
    const lower = limits[minimum];
    const upper = limits[maximum];
    if (lower !== undefined && upper !== undefined && lower > upper)
      fail(location, `${minimum} exceeds ${maximum}`);
  }
  if (kind === 'number' || kind === 'integer') {
    let lower = limits.minimum ?? -Number.MAX_VALUE;
    let upper = limits.maximum ?? Number.MAX_VALUE;
    // The runtime accepts finite JS numbers. Step exclusive bounds by one
    // representable value before rounding integers; +/- 1 fails above 2^53.
    if (limits.exclusiveMinimum !== undefined)
      lower = Math.max(lower, adjacentNumber(limits.exclusiveMinimum, 1));
    if (limits.exclusiveMaximum !== undefined)
      upper = Math.min(upper, adjacentNumber(limits.exclusiveMaximum, -1));
    if (kind === 'integer') {
      lower = Math.ceil(lower);
      upper = Math.floor(upper);
    }
    if (lower > upper)
      fail(
        location,
        `${kind} bounds admit no finite ${kind === 'integer' ? 'integer' : 'number'}`,
      );
  }
  // Inline enum/const assertions must agree with their own sibling rules.
  // Reference siblings may legitimately narrow an existing multi-value enum.
  const violation = literalViolation(limits, format);
  for (const item of literals ?? []) {
    const reason = violation(item);
    if (reason) fail(location, reason);
  }
}

export function literalViolation(
  limits: Constraints,
  format?: 'date' | 'date-time' | 'uuid',
): (item: Scalar) => string | undefined {
  // Use the same predicates and Zod format profiles as emitted validators.
  const pattern =
    limits.pattern === undefined ? undefined : patternTest(limits.pattern);
  const multiple =
    limits.multipleOf === undefined ? undefined : multipleOf(limits.multipleOf);
  return (item) => {
    // oxlint-disable-next-line typescript/no-misused-spread -- JSON Schema lengths count Unicode code points.
    const magnitude = typeof item === 'string' ? [...item].length : item;
    if (
      typeof magnitude === 'number' &&
      ((limits.minLength !== undefined && magnitude < limits.minLength) ||
        (limits.maxLength !== undefined && magnitude > limits.maxLength) ||
        (limits.minimum !== undefined && magnitude < limits.minimum) ||
        (limits.maximum !== undefined && magnitude > limits.maximum) ||
        (limits.exclusiveMinimum !== undefined &&
          magnitude <= limits.exclusiveMinimum) ||
        (limits.exclusiveMaximum !== undefined &&
          magnitude >= limits.exclusiveMaximum))
    )
      return 'literal violates declared bounds';
    if (typeof item === 'string') {
      if (pattern && !pattern(item)) return 'literal violates declared pattern';
      if (format && !formats[format].safeParse(item).success)
        return `literal violates declared ${format} format`;
    } else if (typeof item === 'number' && multiple && !multiple(item))
      return 'literal violates declared multipleOf';
    return undefined;
  };
}
