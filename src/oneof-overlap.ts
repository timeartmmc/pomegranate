import type { Schema, SchemaTable, Scalar } from './model.js';
import type { WarnSchema } from './diagnostics.js';
import { assertNever } from './diagnostics.js';
import { hasConstraints, schemaNode } from './schema-node.js';
import { hasUnicodeProperty, literalViolation } from './scalar-rules.js';

const unknown = Symbol('unproved overlap');
const anyJson = schemaNode({ kind: 'json' });

// This is a bounded witness search, not another schema validator or a general
// satisfiability solver. Every supported construction proves a common member;
// unsupported forms and exhausted search simply produce no warning. In
// particular, sharing a JSON type does not prove overlapping values.
export function overlapWarnings(warn: WarnSchema | undefined) {
  let remaining = 10_000;
  const charge = (amount = 1): boolean => (remaining -= amount) >= 0;
  function target(input: Schema, schemas: SchemaTable): Schema | undefined {
    let value = input;
    while (value.kind === 'ref') {
      if (!charge() || hasConstraints(value.constraints)) return;
      const next = schemas.get(value.name);
      if (!next) return;
      value = next;
    }
    return value;
  }
  function scalar(schema: Schema, value: Scalar): boolean {
    if (!charge()) return false;
    if ('literals' in schema && schema.literals) {
      if (!charge(schema.literals.length) || !schema.literals.includes(value))
        return false;
    }
    switch (schema.kind) {
      case 'null':
        return value === null;
      case 'boolean':
        return typeof value === 'boolean';
      case 'string':
      case 'number':
      case 'integer': {
        if (
          schema.kind === 'integer'
            ? typeof value !== 'number' || !Number.isInteger(value)
            : typeof value !== schema.kind
        )
          return false;
        if (schema.kind === 'string') {
          const formatPattern =
            typeof schema.format === 'object'
              ? schema.format.pattern
              : undefined;
          if (schema.pattern !== undefined || formatPattern !== undefined) {
            if (!schema.literals) return false;
            if (
              !charge(
                (schema.pattern?.length ?? 0) + (formatPattern?.length ?? 0),
              ) ||
              (schema.pattern !== undefined &&
                hasUnicodeProperty(schema.pattern)) ||
              (formatPattern !== undefined && hasUnicodeProperty(formatPattern))
            )
              return false;
          }
        }
        // A retained finite member was checked against its own assertions by
        // normalization. Never run a consumer regexp against a new candidate
        // merely to produce an optional diagnostic: even short strings can
        // trigger unbounded backtracking. Unicode rules above stay unknown.
        if (schema.literals) return true;
        return (
          literalViolation(
            schema,
            schema.kind === 'string' ? schema.format : undefined,
          )(value) === undefined
        );
      }
      case 'json':
        return true;
      case 'array':
      case 'binary':
      case 'intersection':
      case 'map':
      case 'object':
      case 'ref':
      case 'union':
        return false;
      default:
        return assertNever(schema);
    }
  }
  function witness(
    left: Schema,
    right: Schema,
    schemas: SchemaTable,
    depth = 0,
  ): unknown {
    if (!charge() || depth >= 5) return unknown;
    const a = target(left, schemas),
      b = target(right, schemas);
    if (!a || !b) return unknown;
    if (a.kind === 'json' && b.kind !== 'json')
      return witness(b, b, schemas, depth + 1);
    if (b.kind === 'json' && a.kind !== 'json')
      return witness(a, a, schemas, depth + 1);
    if (a.kind === 'json' && b.kind === 'json') return null;
    if (a.kind === 'object' && b.kind === 'object') {
      if (
        !charge(
          (a.sourceKeys?.length ?? a.properties.size) +
            (b.sourceKeys?.length ?? b.properties.size) +
            a.required.length +
            b.required.length,
        )
      )
        return unknown;
      const allowedA = new Set(a.sourceKeys ?? a.properties.keys());
      const allowedB = new Set(b.sourceKeys ?? b.properties.keys());
      const names = new Set([...a.required, ...b.required]);
      const allowed = (name: string) =>
        (!a.closed || allowedA.has(name)) && (!b.closed || allowedB.has(name));
      if ([...names].some((name) => !allowed(name))) return unknown;
      const minimum = Math.max(a.minProperties ?? 0, b.minProperties ?? 0);
      const maximum = Math.min(
        a.maxProperties ?? Infinity,
        b.maxProperties ?? Infinity,
      );
      if (minimum > Math.min(maximum, 8) || names.size > Math.min(maximum, 8))
        return unknown;
      for (const name of new Set([...allowedA, ...allowedB])) {
        if (names.size >= minimum) break;
        if (allowed(name)) names.add(name);
      }
      for (
        let index = 0;
        names.size < minimum && !a.closed && !b.closed;
        index++
      )
        names.add(`overlap_${index}`);
      if (names.size < minimum) return unknown;
      const value: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
      >;
      for (const name of names) {
        if (name.length > 64) return unknown;
        const child = witness(
          a.properties.get(name) ?? anyJson,
          b.properties.get(name) ?? anyJson,
          schemas,
          depth + 1,
        );
        if (child === unknown) return unknown;
        value[name] = child;
      }
      return value;
    }
    if (a.kind === 'array' && b.kind === 'array') {
      const minimum = Math.max(a.minItems ?? 0, b.minItems ?? 0);
      const maximum = Math.min(a.maxItems ?? Infinity, b.maxItems ?? Infinity);
      if (minimum > Math.min(maximum, 1)) return unknown;
      if (minimum === 0) return [];
      const item = witness(a.items, b.items, schemas, depth + 1);
      return item === unknown ? unknown : [item];
    }
    if (a.kind === 'map' && b.kind === 'map') {
      if (!charge(a.required.length + b.required.length)) return unknown;
      const names = new Set([...a.required, ...b.required]);
      const minimum = Math.max(a.minProperties ?? 0, b.minProperties ?? 0);
      const maximum = Math.min(
        a.maxProperties ?? Infinity,
        b.maxProperties ?? Infinity,
      );
      if (minimum > Math.min(maximum, 8) || names.size > Math.min(maximum, 8))
        return unknown;
      for (let index = 0; names.size < minimum; index++)
        names.add(`overlap_${index}`);
      const value: Record<string, unknown> = Object.create(null) as Record<
        string,
        unknown
      >;
      for (const name of names) {
        if (name.length > 64) return unknown;
        const child = witness(
          a.values === true ? anyJson : a.values,
          b.values === true ? anyJson : b.values,
          schemas,
          depth + 1,
        );
        if (child === unknown) return unknown;
        value[name] = child;
      }
      return value;
    }
    const candidates: Scalar[] = [
      null,
      false,
      true,
      0,
      1,
      -1,
      0.5,
      '',
      'a',
      'x',
    ];
    for (const schema of [a, b]) {
      if ('literals' in schema && schema.literals)
        for (const value of schema.literals.slice(0, 8))
          if (typeof value !== 'string' || value.length <= 128)
            candidates.push(value);
      if (schema.kind === 'number' || schema.kind === 'integer')
        for (const value of [
          schema.minimum,
          schema.maximum,
          schema.exclusiveMinimum,
          schema.exclusiveMaximum,
        ])
          if (value !== undefined) candidates.push(value, value + 1, value - 1);
    }
    for (const value of candidates)
      if (scalar(a, value) && scalar(b, value)) return value;
    return unknown;
  }
  return (
    schema: Extract<Schema, { kind: 'union' }>,
    schemas: SchemaTable,
    location: string,
    usage: string,
  ): void => {
    if (
      !warn ||
      schema.cardinality !== 'one' ||
      schema.discriminator ||
      usage === 'component' ||
      remaining <= 0
    )
      return;
    // One useful witness per union is enough. Stop after a bounded prefix of
    // pairs so wide, disjoint declarations do not pay quadratic diagnostic work.
    let pairs = 0;
    for (let right = 1; right < schema.branches.length; right++)
      for (let left = 0; left < right; left++) {
        if (++pairs > 64 || remaining <= 0) return;
        const value = witness(
          schema.branches[left]!,
          schema.branches[right]!,
          schemas,
        );
        if (value === unknown) continue;
        const example = JSON.stringify(value);
        if (example.length > 512) continue;
        warn(
          location,
          `oneOf alternatives overlap for ${usage} values; for example ${example} matches multiple alternatives and will fail exact matching. Make the alternatives exclusive, or use anyOf if multiple matches are intended`,
          'oneof-overlap',
        );
        return;
      }
  };
}
