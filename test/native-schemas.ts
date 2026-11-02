// Hand-written parsers for runtime tests that define operations directly.
// They use the same checked runtime helpers as generated parsers.
import {
  field,
  integerValue,
  invalid,
  list,
  map,
  numeric,
  objectValue,
  stringValue,
  unknownKeys,
} from '../src/runtime.ts';
import type {
  Invalid,
  Issues,
  JsonValue,
  NumberRules,
} from '../src/runtime.ts';
import { jsonValue } from '../src/runtime.ts';

const noKeys: readonly string[] = [];
export function noOptions(
  input: unknown,
  issues: Issues,
): Record<string, never> | undefined | Invalid {
  if (input === undefined) return undefined;
  const source = objectValue(input, issues);
  if (source === invalid) return invalid;
  return unknownKeys(source, noKeys, issues) ? invalid : {};
}

export function labelled(onValidate: () => void = () => {}) {
  return (input: unknown, issues: Issues): { label: string } | Invalid => {
    const source = objectValue(input, issues);
    if (source === invalid) return invalid;
    const label = field(source, 'label', stringValue, issues);
    if (label === invalid) return invalid;
    onValidate();
    return { label };
  };
}

export function detail(
  input: unknown,
  issues: Issues,
): { detail: string } | Invalid {
  const source = objectValue(input, issues);
  if (source === invalid) return invalid;
  const value = field(source, 'detail', stringValue, issues);
  return value === invalid ? invalid : { detail: value };
}

function jsonMap(
  input: unknown,
  issues: Issues,
): Record<string, JsonValue> | Invalid {
  return map(input, issues, jsonValue);
}

export function labelledAttributes(
  input: unknown,
  issues: Issues,
): { label: string; attributes: Record<string, JsonValue> } | Invalid {
  const source = objectValue(input, issues);
  if (source === invalid) return invalid;
  const label = field(source, 'label', stringValue, issues);
  const attributes = field(source, 'attributes', jsonMap, issues);
  if (label === invalid || attributes === invalid) return invalid;
  return { label, attributes };
}

function strings(input: unknown, issues: Issues): string[] | Invalid {
  return list(input, issues, stringValue);
}

export function offsetPage(
  input: unknown,
  issues: Issues,
): { offset: number; limit: number; total: number; items: string[] } | Invalid {
  const source = objectValue(input, issues);
  if (source === invalid) return invalid;
  const offset = field(source, 'offset', integerValue, issues);
  const limit = field(source, 'limit', integerValue, issues);
  const total = field(source, 'total', integerValue, issues);
  const items = field(source, 'items', strings, issues);
  if (
    offset === invalid ||
    limit === invalid ||
    total === invalid ||
    items === invalid
  )
    return invalid;
  return { offset, limit, total, items };
}

const positive: NumberRules = { integer: true, minimum: 1 };
const nonnegative: NumberRules = { integer: true, minimum: 0 };
function positiveInteger(input: unknown, issues: Issues): number | Invalid {
  return numeric(input, issues, positive);
}
function nonnegativeInteger(input: unknown, issues: Issues): number | Invalid {
  return numeric(input, issues, nonnegative);
}

const limitKeys = ['limit'];
function limitQuery(
  input: unknown,
  issues: Issues,
): { limit: number } | Invalid {
  const source = objectValue(input, issues);
  if (source === invalid) return invalid;
  const limit = field(source, 'limit', positiveInteger, issues);
  const extra = unknownKeys(source, limitKeys, issues);
  return limit === invalid || extra ? invalid : { limit };
}
const queryKeys = ['query'];
export function limitInput(
  input: unknown,
  issues: Issues,
): { query: { limit: number } } | Invalid {
  const source = objectValue(input, issues);
  if (source === invalid) return invalid;
  const query = field(source, 'query', limitQuery, issues);
  const extra = unknownKeys(source, queryKeys, issues);
  return query === invalid || extra ? invalid : { query };
}

const pageKeys = ['offset', 'limit'];
function pageQuery(
  input: unknown,
  issues: Issues,
): { offset: number; limit: number } | Invalid {
  const source = objectValue(input, issues);
  if (source === invalid) return invalid;
  const offset = field(source, 'offset', nonnegativeInteger, issues);
  const limit = field(source, 'limit', positiveInteger, issues);
  const extra = unknownKeys(source, pageKeys, issues);
  return offset === invalid || limit === invalid || extra
    ? invalid
    : { offset, limit };
}
export function pageOptions(
  input: unknown,
  issues: Issues,
): { query: { offset: number; limit: number } } | Invalid {
  const source = objectValue(input, issues);
  if (source === invalid) return invalid;
  const query = field(source, 'query', pageQuery, issues);
  const extra = unknownKeys(source, queryKeys, issues);
  return query === invalid || extra ? invalid : { query };
}
