import { fail } from './diagnostics.js';
import type {
  ConstraintInput,
  Constraints,
  Scalar,
  Schema,
  SchemaFormat,
} from './model.js';
import { constraintRecord } from './schema-node.js';
import { formatPattern, formats, multipleOf, patternTest } from './runtime.js';

function adjacentNumber(value: number, direction: 1 | -1): number {
  if (value === 0) return direction * Number.MIN_VALUE;
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value);
  const step = value > 0 === direction > 0 ? 1n : -1n;
  bits.setBigUint64(0, bits.getBigUint64(0) + step);
  return bits.getFloat64(0);
}

function strongestBound(
  left: number | undefined,
  right: number | undefined,
  choose: (left: number, right: number) => number,
): number | undefined {
  return left === undefined
    ? right
    : right === undefined
      ? left
      : choose(left, right);
}

export function intersectConstraints(
  base: ConstraintInput,
  extra: ConstraintInput,
): Constraints {
  const left = constraintRecord(base);
  const right = constraintRecord(extra);
  // Undefined slots represent absence and must not erase an earlier assertion.
  return {
    minLength: strongestBound(left.minLength, right.minLength, Math.max),
    maxLength: strongestBound(left.maxLength, right.maxLength, Math.min),
    minItems: strongestBound(left.minItems, right.minItems, Math.max),
    maxItems: strongestBound(left.maxItems, right.maxItems, Math.min),
    uniqueItems: right.uniqueItems ?? left.uniqueItems,
    minProperties: strongestBound(
      left.minProperties,
      right.minProperties,
      Math.max,
    ),
    maxProperties: strongestBound(
      left.maxProperties,
      right.maxProperties,
      Math.min,
    ),
    minimum: strongestBound(left.minimum, right.minimum, Math.max),
    maximum: strongestBound(left.maximum, right.maximum, Math.min),
    exclusiveMinimum: strongestBound(
      left.exclusiveMinimum,
      right.exclusiveMinimum,
      Math.max,
    ),
    exclusiveMaximum: strongestBound(
      left.exclusiveMaximum,
      right.exclusiveMaximum,
      Math.min,
    ),
    pattern: right.pattern ?? left.pattern,
    multipleOf: right.multipleOf ?? left.multipleOf,
    float: right.float ?? left.float,
  };
}

export function assertScalarRules(
  kind: Schema['kind'],
  limits: ConstraintInput,
  literals: readonly Scalar[] | undefined,
  location: string,
  format?: SchemaFormat,
): void {
  limits = constraintRecord(limits);
  for (const [minimum, maximum] of [
    ['minLength', 'maxLength'],
    ['minItems', 'maxItems'],
    ['minProperties', 'maxProperties'],
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
    // A shortest float32 decimal can exceed the exact binary32 maximum while
    // still rounding back to it. Check overflow using the runtime conversion,
    // rather than intersecting with the smaller exact-value interval.
    if (
      limits.float &&
      ((lower > 0 && !Number.isFinite(Math.fround(lower))) ||
        (upper < 0 && !Number.isFinite(Math.fround(upper))))
    )
      fail(location, 'number bounds admit no finite float32 value');
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
  limits: ConstraintInput,
  format?: SchemaFormat,
): (item: Scalar) => string | undefined {
  limits = constraintRecord(limits);
  // Bounds, formats and stable patterns use the emitted predicates. Property
  // escapes depend on the engine's Unicode data: defer their matching instead
  // of rejecting literals or pruning reference candidates on this host.
  const pattern =
    limits.pattern === undefined || hasUnicodeProperty(limits.pattern)
      ? undefined
      : patternTest(limits.pattern);
  const formatCheck =
    format === undefined
      ? undefined
      : typeof format === 'string'
        ? formats[format]
        : hasUnicodeProperty(format.pattern)
          ? undefined
          : formatPattern(format.pattern);
  const formatName = typeof format === 'string' ? format : format?.name;
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
      if (formatCheck && !formatCheck(item))
        return `literal violates declared ${formatName} format`;
    } else if (typeof item === 'number') {
      if (limits.float && !Number.isFinite(Math.fround(item)))
        return 'literal violates declared float format';
      if (multiple && !multiple(item))
        return 'literal violates declared multipleOf';
    }
    return undefined;
  };
}

export function hasUnicodeProperty(pattern: string): boolean {
  // Schemas already validated u-mode syntax. A property escape has the same
  // spelling inside and outside classes; skip escaped backslashes as one token.
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] !== '\\') continue;
    const escaped = pattern[++index];
    if ((escaped === 'p' || escaped === 'P') && pattern[index + 1] === '{')
      return true;
  }
  return false;
}
