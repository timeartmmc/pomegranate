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

export function object(
  entries: readonly (readonly [string | number, Expression])[],
): Expression {
  // Computed keys keep contract-owned __proto__ data even if support for that
  // name changes later. Property and object wrappers each own their depth.
  const properties = entries.map(([name, value]) =>
    node(`[${JSON.stringify(name)}]: ${value.source}`, [value]),
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
