import { RegExpSyntaxError, RegExpValidator } from '@eslint-community/regexpp';
import { arrayValues, ContractError, fail } from './diagnostics.js';
import type { Constraints, Scalar } from './model.js';
import { constraintRecord } from './schema-node.js';

const maximumPatternNesting = 128;

// One descriptor shares this counter across policy, component and HTTP roots.
// Reserve literal and declaration-list entries before their allocation/loops;
// opaque annotations retain their separate identity-aware JSON validation.
export type WorkCounter = (amount: number, location: string) => void;

function patternFailure(error: unknown, pattern: string): string {
  if (!(error instanceof SyntaxError)) return '';
  const prefix = 'Invalid regular expression: ';
  const sourceEnd = prefix.length + 1 + pattern.length;
  let reason: string;
  // The pinned validator and V8 echo the complete source before their reason.
  // Use its known length: the pattern can itself contain the delimiter /u: .
  if (
    error.message.startsWith(`${prefix}/`) &&
    error.message.startsWith('/u: ', sourceEnd)
  )
    reason = error.message.slice(sourceEnd + '/u: '.length);
  else if (
    error.message.startsWith(prefix) &&
    !error.message.startsWith('/', prefix.length)
  )
    // JavaScriptCore reports a reason without echoing the source or an offset.
    reason = error.message.slice(prefix.length);
  else return '';
  if (!reason) return '';
  const maximum = 160;
  const escaped = JSON.stringify(reason.slice(0, maximum))
    .slice(1, -1)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  const detail =
    escaped.slice(0, maximum) +
    (reason.length > maximum || escaped.length > maximum ? '…' : '');
  // regexpp's index is a zero-based UTF-16 offset, including end-of-input.
  const position =
    error instanceof RegExpSyntaxError
      ? `at UTF-16 offset ${error.index}: `
      : '';
  return `; ${position}${detail}`;
}

export function constraints(
  value: Record<string, unknown>,
  location: string,
): Constraints {
  // Parse sibling syntax before folding null-only literals. Check whether the
  // interval admits a value only for a retained scalar, container or ref target.
  const result = {
    ...bounds(value, 'minLength', 'maxLength', location, true),
    ...bounds(value, 'minItems', 'maxItems', location, true),
    ...bounds(value, 'minProperties', 'maxProperties', location, true),
    ...bounds(value, 'minimum', 'maximum', location, false),
    ...bounds(value, 'exclusiveMinimum', 'exclusiveMaximum', location, false),
    ...uniqueness(value, location),
  };
  const multipleOf = bound(value, 'multipleOf', location, false);
  if (multipleOf !== undefined && multipleOf <= 0)
    fail(`${location}.multipleOf`, 'expected a positive number');
  let pattern: string | undefined;
  if (Object.hasOwn(value, 'pattern')) {
    if (typeof value.pattern !== 'string')
      fail(`${location}.pattern`, 'expected a string');
    pattern = value.pattern;
    try {
      let nesting = 0;
      const enter = () => {
        if (++nesting > maximumPatternNesting)
          fail(
            `${location}.pattern`,
            `pattern nesting exceeds the supported limit of ${maximumPatternNesting} groups and lookaround assertions`,
          );
      };
      const leave = () => {
        nesting--;
      };
      // Keep syntax independent of the compiler's Node version. The exact
      // regexpp 4.12.1 pin supplies Unicode 16.0 property names, matching both
      // supported Node floors; 4.12.2 adds names unavailable there. Validation
      // builds no AST; keep this instance local so its last source is released.
      // Enter hooks run before recursive descent; escaped parens and class
      // characters never enter, and sequential groups release their depth.
      new RegExpValidator({
        ecmaVersion: 2024,
        onGroupEnter: enter,
        onGroupLeave: leave,
        onCapturingGroupEnter: enter,
        onCapturingGroupLeave: leave,
        onLookaroundAssertionEnter: enter,
        onLookaroundAssertionLeave: leave,
      }).validatePattern(pattern, 0, pattern.length, { unicode: true });
      new RegExp(pattern, 'u');
    } catch (error) {
      if (error instanceof ContractError) throw error;
      if (error instanceof RangeError)
        fail(
          `${location}.pattern`,
          'pattern validation exceeded available parser resources',
        );
      fail(
        `${location}.pattern`,
        'expected a valid Unicode ECMAScript 2024 regular expression with Unicode 16.0 property names' +
          patternFailure(error, pattern),
      );
    }
  }
  return constraintRecord({ ...result, multipleOf, pattern });
}

// uniqueItems: false is the JSON Schema default; only true adds an assertion.
export function uniqueness(
  value: Record<string, unknown>,
  location: string,
): { uniqueItems?: true } {
  if (!Object.hasOwn(value, 'uniqueItems')) return {};
  if (typeof value.uniqueItems !== 'boolean')
    fail(`${location}.uniqueItems`, 'expected a boolean');
  return value.uniqueItems ? { uniqueItems: true } : {};
}

function bound(
  value: Record<string, unknown>,
  key: string,
  location: string,
  integer: boolean,
): number | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  const number = value[key];
  if (
    typeof number !== 'number' ||
    !Number.isFinite(number) ||
    (integer && (!Number.isSafeInteger(number) || number < 0))
  ) {
    fail(
      `${location}.${key}`,
      integer
        ? 'expected a nonnegative safe integer'
        : 'expected a finite number',
    );
  }
  return number;
}

export function bounds(
  value: Record<string, unknown>,
  minimum: string,
  maximum: string,
  location: string,
  integer: boolean,
): Record<string, number> {
  const min = bound(value, minimum, location, integer);
  const max = bound(value, maximum, location, integer);
  return {
    ...(min === undefined ? {} : { [minimum]: min }),
    ...(max === undefined ? {} : { [maximum]: max }),
  };
}

function scalarValue(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

// Without a kind, every scalar is admitted and the caller derives the types.
export function literals(
  value: Record<string, unknown>,
  kind: string | undefined,
  location: string,
  nullable = false,
  work?: WorkCounter,
): readonly Scalar[] | undefined {
  if (Object.hasOwn(value, 'const') && Object.hasOwn(value, 'enum'))
    fail(location, 'const and enum together are unsupported');
  const raw = Object.hasOwn(value, 'const') ? [value.const] : value.enum;
  if (!Object.hasOwn(value, 'const') && !Object.hasOwn(value, 'enum'))
    return undefined;
  if (!Array.isArray(raw) || raw.length === 0)
    fail(`${location}.enum`, 'expected a nonempty array');
  work?.(raw.length, location);
  const result: Scalar[] = [];
  const seen = new Set<Scalar>();
  for (const item of arrayValues(raw)) {
    const matches =
      kind === undefined ||
      (kind === 'null'
        ? item === null
        : kind === 'integer'
          ? typeof item === 'number' && Number.isInteger(item)
          : typeof item === kind);
    if ((!matches && !(nullable && item === null)) || !scalarValue(item))
      fail(
        location,
        kind === undefined
          ? 'enum and const values must be strings, finite numbers, booleans or null'
          : `literal must match type ${kind}`,
      );
    if (seen.has(item)) fail(location, 'duplicate literal');
    seen.add(item);
    result.push(item);
  }
  return result;
}
