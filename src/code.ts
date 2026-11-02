import { fail } from './diagnostics.js';
import type { Scalar } from './model.js';

export type Expression = Readonly<{ source: string; depth: number }>;
const maximumExpressionNesting = 128;

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
export const literal = (value: Scalar): Expression =>
  node(JSON.stringify(value));
export const array = (values: readonly Expression[]): Expression =>
  node(`[${values.map((value) => value.source).join(',')}]`, values);
export const member = (
  receiver: Expression,
  key: string | Expression,
): Expression =>
  node(
    typeof key === 'string'
      ? `${receiver.source}.${key}`
      : `${receiver.source}[${key.source}]`,
    typeof key === 'string' ? [receiver] : [receiver, key],
  );
export const call = (
  callee: Expression,
  args: readonly Expression[] = [],
): Expression =>
  node(
    `${callee.source}(${args.map((argument) => argument.source).join(',')})`,
    [callee, ...args],
  );
export const method = (
  receiver: Expression,
  name: string,
  args: readonly Expression[] = [],
): Expression => call(member(receiver, name), args);
export const arrow = (parameter: string, body: Expression): Expression =>
  node(`${parameter} => ${body.source}`, [body]);
export const binary = (
  left: Expression,
  operator: '>=' | '<=' | '>' | '<',
  right: Expression,
): Expression =>
  node(`${left.source} ${operator} ${right.source}`, [left, right]);
export const spread = (value: Expression): Expression =>
  node(`...${value.source}`, [value]);

export function propertyKey(name: string | number): string {
  const quoted = JSON.stringify(name);
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
  // Only generated schema/operation construction and fresh aggregate freezing
  // use this boundary. They allocate validators, closures and plain metadata;
  // they never parse input or invoke application callbacks. Keep argument
  // construction inside the IIFE so removing it also removes nested allocations.
  // Do not mark arbitrary calls pure: runtime validation can have visible effects.
  return source(
    {
      source: `/* @__PURE__ */ (() => (${expression.source}))()`,
      depth: expression.depth + 3,
    },
    location,
  );
}
