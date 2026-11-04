/*!
 * MIT License
 *
 * Copyright (c) 2026 Jamil Kazimzade
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import type { Policy } from './policy-types.ts';
export type { Policy } from './policy-types.ts';

// Generated validators are ordinary functions over unknown input. A parser
// returns a fresh value of its declared type, or `invalid` after recording at
// least one issue in the caller's sink. Generated return expressions are
// checked against named contract types, so no schema-library inference or
// assertion establishes a validated type.
export const invalid: unique symbol = Symbol('pom.invalid');
export type Invalid = typeof invalid;
// An optional field distinguishes an absent key from an explicit undefined.
export const absent: unique symbol = Symbol('pom.absent');
export type Absent = typeof absent;

// Fatal issues report a wrong shape or type. Constraint, format and unknown-key
// issues are not fatal: later checks still run, and a union reports the one
// branch that failed only on constraints instead of every alternative.
type Problem = { path: (string | number)[]; message: string; fatal: boolean };
export type Issues = Problem[];
export type Parse<T> = (input: unknown, issues: Issues) => T | Invalid;

export function report(
  issues: Issues,
  message: string,
  fatal: boolean,
  path: (string | number)[] = [],
): Invalid {
  issues.push({ path, message, fatal });
  return invalid;
}

// Children record relative paths. Prefix only on failure, so successful parsing
// allocates no path frames.
function within(issues: Issues, start: number, key: string | number): void {
  for (let index = start; index < issues.length; index++)
    issues[index]?.path.unshift(key);
}

function fatalSince(issues: Issues, start: number): boolean {
  for (let index = start; index < issues.length; index++)
    if (issues[index]?.fatal) return true;
  return false;
}

// Parsers record an issue before returning `invalid`. Consumers still treat
// either signal as failure and name a missing issue, so a parser defect cannot
// become success, a dropped array item or a silently absent header.
function rejected(issues: Issues, start: number): Invalid {
  if (issues.length === start) report(issues, 'invalid value', true);
  return invalid;
}

export type ValidationIssue = Readonly<{
  path: readonly (string | number)[];
  message: string;
}>;

function validationIssues(issues: Issues): ValidationIssue[] {
  return issues.map(({ path, message }) => ({ path, message }));
}

export class ValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(
      `invalid value (${issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ')})`,
    );
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export type SafeParseResult<T> =
  | Readonly<{ success: true; data: T }>
  | Readonly<{ success: false; error: ValidationError }>;

// The public validator API for schema registries and standalone roots. It is
// deliberately small: generated code composes parse functions, not validators.
export interface Validator<T> {
  readonly parse: (input: unknown) => T;
  readonly safeParse: (input: unknown) => SafeParseResult<T>;
}

export function validator<T>(run: Parse<T>): Validator<T> {
  const safeParse = (input: unknown): SafeParseResult<T> => {
    const issues: Issues = [];
    const data = run(input, issues);
    if (data !== invalid && issues.length === 0) return { success: true, data };
    rejected(issues, 0);
    return {
      success: false,
      error: new ValidationError(validationIssues(issues)),
    };
  };
  return Object.freeze({
    safeParse,
    parse: (input: unknown): T => {
      const result = safeParse(input);
      if (result.success) return result.data;
      throw result.error;
    },
  });
}

// Read the unparsed input only after validation selected its expected shape.
// Generated parsers never retain caller objects: they return fresh values.
export function objectValue(input: unknown, issues: Issues): object | Invalid {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? input
    : report(issues, 'expected an object', true);
}

// Fixed fields use TypeScript's structural semantics: inherited and accessor
// fields count, except from Object.prototype. Contract fields cannot use its
// names, so a key held there is prototype pollution rather than input.
// A value already read proves presence unless Object.prototype could have
// supplied it. One read of that key is the measured cheapest test (an `in` or
// own-key test costs more per field); the chain walk is the rare path.
// This covers polluted data. An accessor installed there is application code,
// which could equally replace these builtins; gating reads costs ~14% per field.
function present(source: object, key: string, value: unknown): boolean {
  if (value !== undefined)
    return (
      Reflect.get(Object.prototype, key) === undefined || holds(source, key)
    );
  return key in source && holds(source, key);
}

// Whether an input object before Object.prototype owns the key. A key reported
// only by a proxy trap stays present unless Object.prototype owns it. Bound
// the walk: a proxy can report an unending prototype chain.
function holds(source: object, key: string): boolean {
  let holder: object | null = source;
  for (let depth = 0; holder !== null && depth < 1024; depth++) {
    if (holder === Object.prototype) break;
    if (Object.hasOwn(holder, key)) return true;
    holder = Reflect.getPrototypeOf(holder);
  }
  return !Object.hasOwn(Object.prototype, key);
}

// Read once. A value that was read proves presence, so validation and output
// use that one value even if its accessor then removes the key; an undefined
// read still tests membership.
export function field<T>(
  source: object,
  key: string,
  parse: Parse<T>,
  issues: Issues,
): T | Invalid {
  const start = issues.length;
  const value: unknown = Reflect.get(source, key);
  const result = parse(value, issues);
  if (result === invalid) {
    rejected(issues, start);
    within(issues, start, key);
    return invalid;
  }
  return present(source, key, value)
    ? result
    : report(issues, 'expected a required property', true, [key]);
}

export function optionalField<T>(
  source: object,
  key: string,
  parse: Parse<T>,
  issues: Issues,
): T | undefined | Absent | Invalid {
  const start = issues.length;
  const value: unknown = Reflect.get(source, key);
  // The common absent case costs one membership test, as an explicit
  // undefined still needs an input holder.
  if (value === undefined)
    return key in source && holds(source, key) ? undefined : absent;
  const result = parse(value, issues);
  if (!present(source, key, value)) {
    issues.length = start;
    return absent;
  }
  if (result === invalid) {
    rejected(issues, start);
    within(issues, start, key);
  }
  return result;
}

// Generated modules declare key lists and rule objects as plain data and call
// these helpers from function bodies. Derived sets and compiled checks are
// cached by identity, so module initialisation runs no validator constructors.
const keySets = new WeakMap<readonly string[], ReadonlySet<string>>();
export const noKeys: readonly string[] = [];
export function unknownKeys(
  source: object,
  known: readonly string[],
  issues: Issues,
): boolean {
  let keys = keySets.get(known);
  if (!keys) {
    keys = new Set(known);
    keySets.set(known, keys);
  }
  const extra: string[] = [];
  // Strict request objects reject enumerable inherited keys too, as for...in
  // reports them, except keys held only by Object.prototype: it is never input.
  // Own __proto__ data is an unknown key like any other.
  // oxlint-disable-next-line guard-for-in -- inherited enumerable keys are input.
  for (const key in source)
    if (!keys.has(key) && holds(source, key)) extra.push(key);
  if (extra.length === 0) return false;
  report(
    issues,
    `unrecognized ${extra.length === 1 ? 'key' : 'keys'}: ${extra.map((key) => JSON.stringify(key)).join(', ')}`,
    false,
  );
  return true;
}

export function forbiddenKeys(
  source: object,
  names: readonly string[],
  issues: Issues,
): boolean {
  let found = false;
  for (const key of names) {
    // Known read-only fields follow structural presence even when they are
    // non-enumerable. Test membership without invoking an excluded getter.
    if (key in source && holds(source, key)) {
      report(issues, 'read-only property is forbidden in requests', false, [
        key,
      ]);
      found = true;
    }
  }
  return found;
}

function codePoints(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
    count++;
  }
  return count;
}

export function patternTest(pattern: string): (value: string) => boolean {
  const expression = new RegExp(pattern, 'u');
  return (value) => expression.test(value);
}

function decimal(value: number): readonly [bigint, number] {
  const [mantissa = '', exponent] = value.toString().split('e');
  const fraction = mantissa.split('.')[1]?.length ?? 0;
  return [BigInt(mantissa.replace('.', '')), Number(exponent ?? 0) - fraction];
}

export function multipleOf(divisor: number): (value: number) => boolean {
  const [divisorDigits, divisorExponent] = decimal(divisor);
  // Interpret finite JS numbers by their decimal spelling. Integer arithmetic
  // avoids remainder rounding and handles scientific notation and subnormals.
  return (value) => {
    if (!Number.isFinite(value)) return false;
    const [digits, exponent] = decimal(value);
    const shift = exponent - divisorExponent;
    return shift >= 0
      ? (digits * 10n ** BigInt(shift)) % divisorDigits === 0n
      : digits % (divisorDigits * 10n ** BigInt(-shift)) === 0n;
  };
}

function calendarDate(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = m === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
  return m >= 1 && m <= 12 && d >= 1 && d <= days;
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
// RFC 3339 profile: seconds and a timezone are required, fractions are allowed,
// lowercase t/z are accepted without changing the value, leap seconds are not.
const dateTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;
const uuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const formats = {
  date: (value: string): boolean => {
    const match = datePattern.exec(value);
    return (
      match !== null &&
      calendarDate(match[1] ?? '', match[2] ?? '', match[3] ?? '')
    );
  },
  'date-time': (value: string): boolean => {
    const match = dateTimePattern.exec(value);
    return (
      match !== null &&
      calendarDate(match[1] ?? '', match[2] ?? '', match[3] ?? '')
    );
  },
  uuid: (value: string): boolean => uuidPattern.test(value),
} as const;
const formatMessages = {
  date: 'expected a calendar date',
  'date-time':
    'expected a calendar date-time with seconds and timezone (no leap seconds)',
  uuid: 'expected a UUID',
} as const;

export type StringRules = Readonly<{
  format?: keyof typeof formats;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}>;
type Check<T> = (value: T, issues: Issues) => void;

const stringCache = new WeakMap<StringRules, Check<string>>();
function stringChecks(rules: StringRules): Check<string> {
  const known = stringCache.get(rules);
  if (known) return known;
  const { format, minLength, maxLength, pattern } = rules;
  const formatted = format === undefined ? undefined : formats[format];
  const matches = pattern === undefined ? undefined : patternTest(pattern);
  // Lengths count Unicode code points, as JSON Schema specifies.
  const check: Check<string> = (value, issues) => {
    if (format !== undefined && formatted && !formatted(value))
      report(issues, formatMessages[format], false);
    if (minLength !== undefined || maxLength !== undefined) {
      const length = codePoints(value);
      if (minLength !== undefined && length < minLength)
        report(issues, 'string is too short', false);
      if (maxLength !== undefined && length > maxLength)
        report(issues, 'string is too long', false);
    }
    if (matches && !matches(value))
      report(issues, 'string does not match pattern', false);
  };
  stringCache.set(rules, check);
  return check;
}

export function text(
  input: unknown,
  issues: Issues,
  rules?: StringRules,
): string | Invalid {
  if (typeof input !== 'string')
    return report(issues, 'expected a string', true);
  if (!rules) return input;
  const start = issues.length;
  stringChecks(rules)(input, issues);
  return issues.length === start ? input : invalid;
}

export type NumberRules = Readonly<{
  integer?: true;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
}>;

const numberCache = new WeakMap<NumberRules, Check<number>>();
function numberChecks(rules: NumberRules): Check<number> {
  const known = numberCache.get(rules);
  if (known) return known;
  const { integer, minimum, maximum, exclusiveMinimum, exclusiveMaximum } =
    rules;
  const multiple =
    rules.multipleOf === undefined ? undefined : multipleOf(rules.multipleOf);
  // Integer checks add no implicit safe-integer range.
  const check: Check<number> = (value, issues) => {
    if (integer && !Number.isInteger(value))
      report(issues, 'expected an integer', false);
    if (minimum !== undefined && !(value >= minimum))
      report(issues, `expected value >= ${minimum}`, false);
    if (maximum !== undefined && !(value <= maximum))
      report(issues, `expected value <= ${maximum}`, false);
    if (exclusiveMinimum !== undefined && !(value > exclusiveMinimum))
      report(issues, `expected value > ${exclusiveMinimum}`, false);
    if (exclusiveMaximum !== undefined && !(value < exclusiveMaximum))
      report(issues, `expected value < ${exclusiveMaximum}`, false);
    if (multiple && !multiple(value))
      report(issues, 'expected a declared multiple', false);
  };
  numberCache.set(rules, check);
  return check;
}

export function numeric(
  input: unknown,
  issues: Issues,
  rules?: NumberRules,
): number | Invalid {
  if (typeof input !== 'number' || !Number.isFinite(input))
    return report(issues, 'expected a finite number', true);
  if (!rules) return input;
  const start = issues.length;
  numberChecks(rules)(input, issues);
  return issues.length === start ? input : invalid;
}

const integerRules: NumberRules = { integer: true };
export function stringValue(input: unknown, issues: Issues): string | Invalid {
  return text(input, issues);
}
export function numberValue(input: unknown, issues: Issues): number | Invalid {
  return numeric(input, issues);
}
export function integerValue(input: unknown, issues: Issues): number | Invalid {
  return numeric(input, issues, integerRules);
}
export function booleanValue(
  input: unknown,
  issues: Issues,
): boolean | Invalid {
  return typeof input === 'boolean'
    ? input
    : report(issues, 'expected a boolean', true);
}
export function nullValue(input: unknown, issues: Issues): null | Invalid {
  return input === null ? null : report(issues, 'expected null', true);
}
function neverValue(_input: unknown, issues: Issues): Invalid {
  return report(issues, 'expected no value', true);
}

// $ref siblings restrict the referenced value. Their checks run unless the base
// already reported a wrong type or shape. A constraint failure remains eligible
// for the remaining sibling rules.
// Alias chains are resolved by the compiler: `rules` lists each reference's
// siblings from the terminal outwards, so no wrapper frame grows with depth.
export function refineText<T extends string>(
  input: unknown,
  issues: Issues,
  base: Parse<T>,
  rules: readonly StringRules[],
): T | Invalid {
  const start = issues.length;
  const value = base(input, issues);
  if (typeof input === 'string' && !fatalSince(issues, start))
    for (const rule of rules) stringChecks(rule)(input, issues);
  return issues.length === start ? value : invalid;
}

export function refineNumber<T extends number>(
  input: unknown,
  issues: Issues,
  base: Parse<T>,
  rules: readonly NumberRules[],
): T | Invalid {
  const start = issues.length;
  const value = base(input, issues);
  if (typeof input === 'number' && !fatalSince(issues, start))
    for (const rule of rules) numberChecks(rule)(input, issues);
  return issues.length === start ? value : invalid;
}

export type ArrayRules = Readonly<{ minItems?: number; maxItems?: number }>;

// Observe a host length once and reject impossible counts before any item read.
function arrayLength(input: readonly unknown[]): number | undefined {
  const length: unknown = Reflect.get(input, 'length');
  return typeof length === 'number' &&
    Number.isSafeInteger(length) &&
    length >= 0 &&
    length <= 0xffffffff
    ? length
    : undefined;
}

function arrayItem(input: readonly unknown[], index: number): unknown {
  // A hole is missing JSON data, even if another library polluted a prototype.
  // Keep own accessors observable, with one value read after the ownership check.
  return Object.hasOwn(input, index) ? input[index] : undefined;
}

export function list<T>(
  input: unknown,
  issues: Issues,
  items: Parse<T>,
  rules?: ArrayRules,
): T[] | Invalid {
  if (!Array.isArray(input)) return report(issues, 'expected an array', true);
  const length = arrayLength(input);
  if (length === undefined)
    return report(issues, 'expected a valid array length', true);
  if (rules?.maxItems !== undefined && length > rules.maxItems)
    return report(issues, `expected at most ${rules.maxItems} items`, false);
  if (rules?.minItems !== undefined && length < rules.minItems)
    return report(issues, `expected at least ${rules.minItems} items`, false);
  const start = issues.length;
  const output: T[] = [];
  for (let index = 0; index < length; index++) {
    const before = issues.length;
    const element = arrayItem(input, index);
    const value = items(element, issues);
    if (value === invalid) {
      rejected(issues, before);
      within(issues, before, index);
    } else output.push(value);
  }
  return issues.length === start ? output : invalid;
}

function* arrayEntries(
  input: unknown[],
  length: number,
): Generator<readonly [number, unknown]> {
  for (let index = 0; index < length; index++)
    yield [index, arrayItem(input, index)];
}

export function map<T>(
  input: unknown,
  issues: Issues,
  values: Parse<T>,
): Record<string, T> | Invalid {
  // Dynamic JSON keys are data: inspect own entries of plain records and build
  // the result with fromEntries so keys such as __proto__ stay own properties.
  if (!plainRecord(input)) return report(issues, 'expected an object', true);
  const start = issues.length;
  const entries: [string, T][] = [];
  for (const [name, value] of Object.entries(input)) {
    const before = issues.length;
    const parsed = values(value, issues);
    if (parsed === invalid) {
      rejected(issues, before);
      within(issues, before, name);
    } else entries.push([name, parsed]);
  }
  return issues.length === start ? Object.fromEntries(entries) : invalid;
}

export function emptyOptions(
  input: unknown,
  issues: Issues,
): Record<string, never> | Invalid {
  return map<never>(input, issues, neverValue);
}

export function union<T>(
  input: unknown,
  issues: Issues,
  left: Parse<T>,
  right: Parse<T>,
): T | Invalid {
  const first: Issues = [];
  const a = left(input, first);
  if (a !== invalid && first.length === 0) return a;
  const second: Issues = [];
  const b = right(input, second);
  if (b !== invalid && second.length === 0) return b;
  const start = issues.length;
  const leftFatal = fatalSince(first, 0);
  if (leftFatal !== fatalSince(second, 0)) {
    // Copy one at a time. A spread call has an engine argument limit, so many
    // constraint failures would otherwise throw RangeError instead of failing.
    for (const issue of leftFatal ? second : first) issues.push(issue);
    return rejected(issues, start);
  }
  for (const [index, branch] of [first, second].entries())
    for (const { path, message } of branch)
      report(issues, `union branch ${index + 1}: ${message}`, true, path);
  return rejected(issues, start);
}

export function taggedUnion<T>(
  input: unknown,
  issues: Issues,
  propertyName: string,
  cases: Readonly<Record<string, Parse<T>>>,
): T | Invalid {
  // The compiler proves that each branch requires its distinct literal tag.
  // Dispatch before parsing: trying every branch repeats nested union work.
  // The selected branch validates its tag again; callers must keep it stable.
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    return report(issues, 'expected an object', true);
  const tag: unknown = Reflect.get(input, propertyName);
  if (typeof tag === 'string' && Object.hasOwn(cases, tag)) {
    const parse = cases[tag];
    if (parse !== undefined) return parse(input, issues);
  }
  return report(issues, 'expected a declared discriminator tag', true, [
    propertyName,
  ]);
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function dictionary<Value>(): Record<string, Value> {
  return Object.create(null) as Record<string, Value>;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const invalidJson = Symbol('invalid JSON');

function cloneJson(input: unknown): JsonValue | typeof invalidJson {
  const result: Record<string, JsonValue> = {};
  type Frame = {
    source?: object;
    target: Record<string, JsonValue> | JsonValue[];
    entries: Iterator<readonly [string | number, unknown]>;
  };
  const stack: Frame[] = [
    { target: result, entries: [['value', input] as const].values() },
  ];
  const pending = new Set<object>();
  // Validate and copy iteratively: valid JSON can exceed the JS call stack.
  // Track ancestors, not all visited nodes, so shared values remain valid.
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const entry = frame.entries.next();
    if (entry.done) {
      if (frame.source) pending.delete(frame.source);
      stack.pop();
      continue;
    }
    const [key, value] = entry.value;
    let copy: JsonValue;
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      copy = value;
    else {
      if ((!Array.isArray(value) && !plainRecord(value)) || pending.has(value))
        return invalidJson;
      let entries: Frame['entries'];
      if (Array.isArray(value)) {
        const count = arrayLength(value);
        if (count === undefined) return invalidJson;
        entries = arrayEntries(value, count);
      } else entries = Object.entries(value).values();
      pending.add(value);
      copy = Array.isArray(value) ? [] : {};
      stack.push({
        source: value,
        target: copy,
        entries,
      });
    }
    // Own JSON keys such as __proto__ must remain data, including in arrays.
    Object.defineProperty(frame.target, key, {
      value: copy,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result['value']!;
}

export function jsonValue(input: unknown, issues: Issues): JsonValue | Invalid {
  const result = cloneJson(input);
  return result === invalidJson
    ? report(issues, 'expected a JSON value', true)
    : result;
}

// Native applications resolve file references and own file access/serialization.
// Keep browser File globals and types out of this shared runtime.
export type NativeFile = {
  uri: string;
  name?: string | undefined;
  mediaType?: string | undefined;
};
const nonemptyRules: StringRules = { minLength: 1 };
const nativeFileKeys = ['uri', 'name', 'mediaType'];
function nonemptyText(input: unknown, issues: Issues): string | Invalid {
  return text(input, issues, nonemptyRules);
}
export function nativeFile(
  input: unknown,
  issues: Issues,
): NativeFile | Invalid {
  const source = objectValue(input, issues);
  if (source === invalid) return invalid;
  const uri = field(source, 'uri', nonemptyText, issues);
  const name = optionalField(source, 'name', nonemptyText, issues);
  const mediaType = optionalField(source, 'mediaType', nonemptyText, issues);
  const extra = unknownKeys(source, nativeFileKeys, issues);
  if (uri === invalid || name === invalid || mediaType === invalid || extra)
    return invalid;
  return {
    uri,
    ...(name === absent ? {} : { name }),
    ...(mediaType === absent ? {} : { mediaType }),
  };
}

export type Security = Readonly<{ transport: 'none' | 'bearer' }>;
export type HeaderContext = Readonly<Record<string, string>>;
export type ObservedResponse = Readonly<{
  status: number;
  headers: HeaderContext;
  body: string;
}>;
export type ProtocolIssue = Readonly<{
  part: 'status' | 'headers' | 'content-type' | 'body';
  path?: readonly (string | number)[];
  message: string;
}>;

export type ProtocolFailure = Readonly<{
  kind: 'protocol';
  operationId: string;
  status: number;
  headers: HeaderContext;
  validatedHeaders: HeaderContext;
  issues: readonly ProtocolIssue[];
}>;

type HeaderSpec = Readonly<{ schema: Parse<string>; required: boolean }>;
type ResponseSpec = Readonly<{
  headers: Readonly<Record<string, HeaderSpec>>;
}> &
  (
    | Readonly<{ bodyKind: 'none' }>
    | Readonly<{ bodyKind: 'json'; schema: Parse<unknown> }>
  );
export type Responses = Readonly<Record<number, ResponseSpec>>;

type Data<R> = R extends { schema: Parse<infer T> } ? T : undefined;
export type DeclaredResponse<R extends Responses> = {
  [S in keyof R]: S extends number
    ? Readonly<{
        kind: number extends S
          ? 'success' | 'error'
          : `${S}` extends `2${string}`
            ? 'success'
            : 'error';
        operationId: string;
        status: S;
        headers: HeaderContext;
        validatedHeaders: HeaderContext;
        data: Data<R[S]>;
      }>
    : never;
}[keyof R];

export type ProtocolResult<R extends Responses> =
  | DeclaredResponse<R>
  | ProtocolFailure;
type BodyKind = 'none' | 'json' | 'multipart';
export type MultipartField = Readonly<{
  name: string;
  kind: 'text' | 'file';
  multiple: boolean;
  required: boolean;
}>;
type Primitive = string | number | boolean;
export type RequestParts = {
  path?: Readonly<Record<string, Primitive>> | undefined;
  query?:
    | Readonly<
        Record<string, Primitive | readonly Primitive[] | null | undefined>
      >
    | undefined;
  headers?: Readonly<Record<string, string | null | undefined>> | undefined;
  body?: unknown;
};

export type PreparedRequest<
  R extends Responses = Responses,
  B extends BodyKind = BodyKind,
  Body = unknown,
  P = Policy,
> = Readonly<{
  operationId: string;
  method: string;
  url: string;
  security: Security;
  policy: Readonly<P>;
  headers: HeaderContext;
  validateHeaders: (headers: HeaderContext) => HeaderContext;
  parseResponse: (response: ObservedResponse) => ProtocolResult<R>;
}> &
  (B extends 'json'
    ? Readonly<{ bodyKind: 'json'; body: Body }>
    : B extends 'multipart'
      ? Readonly<{
          bodyKind: 'multipart';
          body: Body;
          multipart: readonly MultipartField[];
        }>
      : Readonly<{ bodyKind: 'none' }>);

type RequestBody<O> =
  NonNullable<O> extends { body: infer Value } ? Value : never;

export interface Operation<
  O extends RequestParts | undefined,
  R extends Responses,
  B extends BodyKind,
> {
  readonly build: (
    ...args: undefined extends O ? [options?: O] : [options: O]
  ) => PreparedRequest<R, B, RequestBody<O>>;
  readonly parseResponse: (response: ObservedResponse) => ProtocolResult<R>;
}

export class RequestValidationError extends Error {
  readonly operationId: string;
  readonly issues: readonly ValidationIssue[];

  constructor(operationId: string, issues: readonly ValidationIssue[]) {
    super(
      `${operationId}: invalid request (${issues.map((issue) => `${issue.path.join('.') || 'options'}: ${issue.message}`).join('; ')})`,
    );
    this.name = 'RequestValidationError';
    this.operationId = operationId;
    this.issues = issues;
  }
}

type Parameter = Readonly<{
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
}>;
type Definition<
  O extends RequestParts | undefined,
  R extends Responses,
  B extends BodyKind,
> = Readonly<{
  operationId: string;
  method: string;
  path: string;
  security: Security;
  policy: Policy;
  bodyKind: B;
  multipart?: readonly MultipartField[];
  parameters: readonly Parameter[];
  options: Parse<O>;
  headers: Readonly<
    Record<string, { schema: Parse<string | null>; required: boolean }>
  >;
  responses: R;
}>;

function frozenHeaders(headers: Record<string, string>): HeaderContext {
  return Object.freeze(headers);
}

function requireWellFormed(
  value: string,
  operationId: string,
  path: readonly (string | number)[],
): void {
  // Keep runtime validation local: generated code cannot import compiler helpers.
  try {
    encodeURIComponent(value);
  } catch {
    throw new RequestValidationError(operationId, [
      { path, message: 'must contain well-formed Unicode' },
    ]);
  }
}

function encodePath(
  value: Primitive,
  operationId: string,
  name: string,
): string {
  const serialized = String(value);
  if (serialized === '' || serialized === '.' || serialized === '..') {
    throw new RequestValidationError(operationId, [
      {
        path: ['path', name],
        message: 'must be nonempty and cannot be a dot segment',
      },
    ]);
  }
  requireWellFormed(serialized, operationId, ['path', name]);
  return encodeURIComponent(serialized).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const tokenCharacters = "!#$%&'*+.^_`|~0-9A-Za-z-";
const invalidHeaderName = new RegExp(`[^${tokenCharacters}]`);
const token = `[${tokenCharacters}]+`;
const quotedParameter = String.raw`"(?:[^"\\]|\\.)*"`;
// RFC 9110 sections 5.6.6 and 8.3: match one complete media type, including
// quoted parameter data. Each segment owns its trailing whitespace so empty
// parameters do not introduce overlapping whitespace repetitions.
const jsonContentType = new RegExp(
  `^application/json[\\t ]*(?:;[\\t ]*(?:${token}=(?:${token}|${quotedParameter})[\\t ]*)?)*$`,
  'i',
);

function validHeaderValue(value: string): boolean {
  // Preserve canonical HTTP field bytes: Fetch requires ByteString values and
  // trims boundary SP/HTAB. Reject those transformations before transport;
  // internal HTAB and Latin-1 obs-text remain valid field content.
  return (
    // oxlint-disable-next-line no-control-regex -- HTTP field content excludes controls except internal HTAB.
    !/[\u0000-\u0008\u000a-\u001f\u007f\u0100-\uffff]/.test(value) &&
    !/^[\t ]|[\t ]$/.test(value)
  );
}

function observedHeaders(input: HeaderContext) {
  if (!plainRecord(input))
    throw new TypeError('response headers must be a plain record');
  const context: Record<string, string> = dictionary<string>();
  const issues: ProtocolIssue[] = [];
  const invalidFields = new Set<string>();
  for (const [rawName, value] of Object.entries(input)) {
    if (typeof value !== 'string')
      throw new TypeError(
        `response header ${JSON.stringify(rawName)} must be a string`,
      );
    const name = rawName.toLowerCase();
    const repeated = Object.hasOwn(context, name);
    context[name] = repeated ? `${context[name]}, ${value}` : value;
    // Validate before case folding: a non-ASCII name can otherwise alias a
    // declared ASCII field. Its value is evidence, not a validated header.
    if (rawName.length === 0 || invalidHeaderName.test(rawName)) {
      invalidFields.add(name);
      issues.push({
        part: 'headers',
        message: `invalid HTTP header name ${JSON.stringify(rawName)}`,
      });
    }
    // Joining malformed duplicate fields can accidentally repair quotes;
    // reject repeated singleton fields independently of the combined text.
    if (name === 'content-type' && repeated)
      issues.push({
        part: 'content-type',
        message: 'expected a single Content-Type field',
      });
    if (!validHeaderValue(value)) {
      invalidFields.add(name);
      issues.push({
        part: 'headers',
        message: `invalid HTTP header value for ${JSON.stringify(rawName)}`,
      });
    }
  }
  const headers = frozenHeaders(context);
  return { headers, issues, invalidFields };
}

function declaredHeaders(
  spec: ResponseSpec | undefined,
  headers: HeaderContext,
  invalidFields: ReadonlySet<string>,
  issues: ProtocolIssue[],
): HeaderContext {
  const validated: Record<string, string> = dictionary<string>();
  if (spec) {
    for (const [name, header] of Object.entries(spec.headers)) {
      const raw = headers[name];
      if (raw === undefined && !header.required) continue;
      const problems: Issues = [];
      const parsed = header.schema(raw, problems);
      if (parsed === invalid || problems.length > 0) {
        rejected(problems, 0);
        for (const detail of validationIssues(problems)) {
          issues.push({
            ...detail,
            part: 'headers',
            path: [name, ...detail.path],
          });
        }
      } else if (!invalidFields.has(name) && validHeaderValue(parsed))
        validated[name] = parsed;
      else
        issues.push({
          part: 'headers',
          path: [name],
          message: `invalid or missing declared header ${name}`,
        });
    }
  }
  return frozenHeaders(validated);
}

function responseParser<R extends Responses>(
  operationId: string,
  responses: R,
): (observed: ObservedResponse) => ProtocolResult<R> {
  return (observed) => {
    if (observed === null || typeof observed !== 'object')
      throw new TypeError('response evidence must be an object');
    // JavaScript executors can bypass the declared evidence types. Snapshot
    // fields once and reject coercion before lookup or JSON parsing can turn a
    // malformed adapter result into successful, incorrectly typed protocol data.
    const { status, body, headers: rawHeaders } = observed;
    if (typeof status !== 'number')
      throw new TypeError('response status must be a number');
    if (typeof body !== 'string')
      throw new TypeError('response body must be raw text');
    const { headers, issues, invalidFields } = observedHeaders(rawHeaders);
    const spec = Object.hasOwn(responses, status)
      ? responses[status]
      : undefined;
    if (!spec)
      issues.push({ part: 'status', message: 'undeclared response status' });
    const validatedHeaders = declaredHeaders(
      spec,
      headers,
      invalidFields,
      issues,
    );
    let data: unknown;
    if (spec?.bodyKind === 'none') {
      if (body !== '')
        issues.push({
          part: 'body',
          message: 'expected an empty response body',
        });
    } else if (spec?.bodyKind === 'json') {
      const mediaType = headers['content-type'];
      if (
        mediaType === undefined ||
        !validHeaderValue(mediaType) ||
        !jsonContentType.test(mediaType)
      )
        issues.push({
          part: 'content-type',
          message: 'expected a single valid application/json media type',
        });
      let decoded: unknown;
      let decodedSuccessfully = false;
      try {
        decoded = JSON.parse(body) as unknown;
        decodedSuccessfully = true;
      } catch {
        issues.push({ part: 'body', message: 'invalid JSON response body' });
      }
      if (decodedSuccessfully) {
        const problems: Issues = [];
        const parsed = spec.schema(decoded, problems);
        if (parsed !== invalid && problems.length === 0) data = parsed;
        else {
          rejected(problems, 0);
          for (const detail of validationIssues(problems))
            issues.push({ part: 'body', ...detail });
        }
      }
    }
    if (issues.length > 0) {
      return Object.freeze({
        kind: 'protocol',
        operationId,
        status,
        headers,
        validatedHeaders,
        issues: Object.freeze(issues),
      });
    }
    // The only successful path selects an exact declared status and validates its
    // schema. TypeScript cannot express that runtime lookup as the mapped union.
    return Object.freeze({
      kind: status >= 200 && status < 300 ? 'success' : 'error',
      operationId,
      status,
      headers,
      validatedHeaders,
      data,
    }) as DeclaredResponse<R>;
  };
}

function validateMultipart(
  body: unknown,
  multipart: readonly MultipartField[],
  operationId: string,
): void {
  if (!plainRecord(body))
    throw new RequestValidationError(operationId, [
      { path: ['body'], message: 'expected a multipart object' },
    ]);
  for (const field of multipart) {
    const value = body[field.name];
    if (
      field.required &&
      field.multiple &&
      Array.isArray(value) &&
      value.length === 0
    )
      throw new RequestValidationError(operationId, [
        {
          path: ['body', field.name],
          message: 'a required file array must contain at least one file',
        },
      ]);
    if (field.kind === 'text' && typeof value === 'string') {
      requireWellFormed(value, operationId, ['body', field.name]);
      // Standard multipart encoding rewrites isolated CR and LF to CRLF.
      // Require canonical line breaks to preserve the validated text exactly.
      if (/\r(?!\n)|(?:^|[^\r])\n/.test(value))
        throw new RequestValidationError(operationId, [
          {
            path: ['body', field.name],
            message: 'line breaks must use CRLF',
          },
        ]);
    }
  }
}

function serializeParameters(
  operationId: string,
  template: string,
  parameters: readonly Parameter[],
  options: RequestParts,
): { url: string; headers: HeaderContext } {
  let path = template;
  const query = new URLSearchParams();
  const headers: Record<string, string> = dictionary<string>();
  for (const parameter of parameters) {
    if (parameter.in === 'path') {
      path = path.replace(
        `{${parameter.name}}`,
        encodePath(options.path![parameter.name]!, operationId, parameter.name),
      );
    } else if (parameter.in === 'query') {
      const value = options.query?.[parameter.name];
      // The options schema admits null only for optional nullable primitives.
      // Their null value means omission, distinct from the string "null".
      if (value === undefined || value === null) continue;
      // Repeated-key encoding cannot represent a present empty array.
      if (parameter.required && Array.isArray(value) && value.length === 0)
        throw new RequestValidationError(operationId, [
          {
            path: ['query', parameter.name],
            message: 'a required query array must contain at least one value',
          },
        ]);
      for (const item of Array.isArray(value) ? value : [value]) {
        const serialized = String(item);
        // URLSearchParams silently replaces unpaired surrogates. Validate first
        // so the wire query remains the value that passed the endpoint schema.
        requireWellFormed(serialized, operationId, ['query', parameter.name]);
        query.append(parameter.name, serialized);
      }
    } else {
      const value = options.headers?.[parameter.name];
      if (value === undefined || value === null) continue;
      if (!validHeaderValue(value))
        throw new RequestValidationError(operationId, [
          {
            path: ['headers', parameter.name],
            message: 'invalid HTTP header value',
          },
        ]);
      headers[parameter.name] = value;
    }
  }
  const search = query.toString();
  return {
    url: `${path}${search ? `?${search}` : ''}`,
    headers: frozenHeaders(headers),
  };
}

function headerValidator(
  operationId: string,
  specs: Readonly<
    Record<string, { schema: Parse<string | null>; required: boolean }>
  >,
) {
  return (input: HeaderContext): HeaderContext => {
    const headers: Record<string, string> = dictionary<string>();
    const issues: ValidationIssue[] = [];
    for (const [rawName, value] of Object.entries(input)) {
      const name = rawName.toLowerCase();
      if (
        !name ||
        invalidHeaderName.test(rawName) ||
        typeof value !== 'string' ||
        !validHeaderValue(value) ||
        Object.hasOwn(headers, name)
      )
        issues.push({
          path: ['headers', rawName],
          message: 'invalid or duplicate HTTP header',
        });
      headers[name] = value;
    }
    for (const [name, spec] of Object.entries(specs)) {
      if (headers[name] === undefined && !spec.required) continue;
      const problems: Issues = [];
      const parsed = spec.schema(headers[name], problems);
      if (parsed === invalid || problems.length > 0) {
        rejected(problems, 0);
        for (const detail of validationIssues(problems)) {
          issues.push({
            ...detail,
            path: ['headers', name, ...detail.path],
          });
        }
      }
    }
    if (issues.length) throw new RequestValidationError(operationId, issues);
    return frozenHeaders(headers);
  };
}

export function validateOptions<O>(
  schema: Parse<O>,
  input: unknown,
  operationId: string,
): O {
  const issues: Issues = [];
  const parsed = schema(input, issues);
  if (parsed === invalid || issues.length > 0) {
    rejected(issues, 0);
    throw new RequestValidationError(operationId, validationIssues(issues));
  }
  return parsed;
}

export function defineOperation<
  const O extends RequestParts | undefined,
  const R extends Responses,
  const B extends BodyKind,
>(definition: Definition<O, R, B>): Operation<O, R, B> {
  const security = Object.freeze({ ...definition.security });
  const policy = Object.freeze({ ...definition.policy });
  const multipart = Object.freeze(
    (definition.multipart ?? []).map((field) => Object.freeze({ ...field })),
  );
  const parseResponse = responseParser(
    definition.operationId,
    definition.responses,
  );
  const validateHeaders = headerValidator(
    definition.operationId,
    definition.headers,
  );
  function build(
    ...args: undefined extends O ? [options?: O] : [options: O]
  ): PreparedRequest<R, B, RequestBody<O>> {
    if (args.length > 1)
      throw new RequestValidationError(definition.operationId, [
        { path: [], message: 'expected at most one options argument' },
      ]);
    const options: RequestParts =
      validateOptions(definition.options, args[0], definition.operationId) ??
      {};
    if (definition.bodyKind === 'multipart')
      validateMultipart(options.body, multipart, definition.operationId);
    const serialized = serializeParameters(
      definition.operationId,
      definition.path,
      definition.parameters,
      options,
    );
    const request = {
      operationId: definition.operationId,
      method: definition.method,
      url: serialized.url,
      security,
      policy,
      headers: serialized.headers,
      validateHeaders,
      parseResponse,
      ...(definition.bodyKind === 'json'
        ? { bodyKind: 'json' as const, body: options.body }
        : definition.bodyKind === 'multipart'
          ? { bodyKind: 'multipart' as const, body: options.body, multipart }
          : { bodyKind: 'none' as const }),
    };
    // The generated options schema and bodyKind are emitted together from one
    // descriptor. Their relationship cannot be inferred through this generic.
    return Object.freeze(request) as unknown as PreparedRequest<
      R,
      B,
      RequestBody<O>
    >;
  }
  return Object.freeze({ build, parseResponse });
}
