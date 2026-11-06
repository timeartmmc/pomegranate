import { fail } from './diagnostics.js';
import type { Scalar } from './model.js';

export type Expression = Readonly<{ source: string; depth: number }>;
const maximumExpressionNesting = 128;

export function jsonSource(value: unknown): string {
  // Preserve JSON data while making bidi controls and line separators explicit
  // in generated string values, property keys, and literal types.
  return JSON.stringify(value).replace(
    /[\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    (character) =>
      `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function node(
  source: string,
  children: readonly Expression[] = [],
): Expression {
  return {
    source,
    depth:
      1 + children.reduce((depth, child) => Math.max(depth, child.depth), 0),
  };
}

export const identifier = (name: string): Expression => node(name);
export const literal = (value: Scalar): Expression => node(jsonSource(value));
export const array = (values: readonly Expression[]): Expression =>
  node(`[${values.map((value) => value.source).join(',')}]`, values);
export const call = (
  callee: Expression,
  args: readonly Expression[] = [],
): Expression =>
  node(
    `${callee.source}(${args.map((argument) => argument.source).join(',')})`,
    [callee, ...args],
  );
export function propertyKey(name: string | number): string {
  const quoted = jsonSource(name);
  // __proto__ is data, not an object-literal prototype setter. Negative
  // numbers also need computed syntax; other keys can use ordinary properties.
  if (name === '__proto__' || (typeof name === 'number' && name < 0))
    return `[${quoted}]`;
  return typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? name
    : quoted;
}

export function object(
  entries: readonly (readonly [string | number, Expression])[],
): Expression {
  // Property and object wrappers each own their expression depth.
  const properties = entries.map(([name, value]) =>
    node(`${propertyKey(name)}: ${value.source}`, [value]),
  );
  return node(
    `{${properties.map((property) => property.source).join(',')}}`,
    properties,
  );
}

export function data(value: unknown): Expression {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return literal(value);
  if (Array.isArray(value)) return array(value.map(data));
  if (typeof value === 'object')
    return object(
      Object.entries(value).map(([name, child]) => [name, data(child)]),
    );
  fail('generated expression', 'expected JSON metadata');
}

export function source(expression: Expression, location: string): string {
  // Depth follows construction, rather than a second model of how each Schema
  // kind happens to render. Every emitted initializer goes through this gate.
  if (expression.depth > maximumExpressionNesting)
    fail(
      location,
      `generated expression nesting exceeds the supported limit of ${maximumExpressionNesting} levels`,
    );
  return expression.source;
}

export function pureInitializer(
  expression: Expression,
  location: string,
): string {
  // Standalone validator allocation is pure: it captures a named parser without
  // parsing input or invoking application callbacks. Keep argument construction
  // inside the IIFE so removing the facade also removes its allocations.
  return source(
    {
      source: `/* @__PURE__ */ (() => (${expression.source}))()`,
      depth: expression.depth + 3,
    },
    location,
  );
}
