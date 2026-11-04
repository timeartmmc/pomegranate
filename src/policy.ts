import {
  contractField,
  fail,
  keys,
  record,
  safeKey,
  text,
} from './diagnostics.js';
import type {
  AuthTransport,
  Policy,
  PolicyVocabulary,
  Scalar,
  Schema,
} from './model.js';
import { normalizeSchema } from './schemas.js';

function labels(input: unknown, location: string): readonly string[] {
  if (!Array.isArray(input) || input.length === 0)
    fail(location, 'expected a nonempty array of labels');
  // Visit holes as well as values for programmatic inputs.
  const result = Array.from(input, (label, index) =>
    text(label, `${location}[${index}]`),
  );
  if (new Set(result).size !== result.length) fail(location, 'duplicate label');
  return result;
}

export function surfaceNames(
  input: unknown,
  location: string,
): readonly string[] {
  const result = labels(input, location);
  // Names become paths on case-insensitive filesystems.
  for (const name of result) {
    if (!/^[a-z][a-z0-9_-]{0,62}$/.test(name))
      fail(location, 'surface names must match [a-z][a-z0-9_-]{0,62}');
  }
  return result;
}

export function normalizeMemberships(
  input: unknown,
): Readonly<Record<string, readonly string[]>> {
  const value = record(input, 'surfaces');
  const names = Object.keys(value).sort();
  surfaceNames(names, 'surfaces');
  return Object.fromEntries(
    names.map((name) => [name, labels(value[name], `surfaces.${name}`)]),
  );
}

export function normalizeVocabulary(input: unknown): PolicyVocabulary {
  const location = 'x-pom-policy';
  const value = record(input, location);
  keys(value, ['version', 'auth', 'fields', 'required', 'surfaces'], location);
  if (value.version !== 3)
    fail(`${location}.version`, 'expected policy version 3');
  const auth = record(
    Object.hasOwn(value, 'auth') ? value.auth : {},
    `${location}.auth`,
  );
  if (Object.hasOwn(value, 'auth') && Object.keys(auth).length === 0)
    fail(`${location}.auth`, 'expected at least one auth label');
  const entries = Object.keys(auth)
    .sort()
    .map((label): readonly [string, AuthTransport] => {
      text(label, `${location}.auth`);
      safeKey(label, `${location}.auth.${label}`);
      const binding = record(auth[label], `${location}.auth.${label}`);
      keys(binding, ['transport'], `${location}.auth.${label}`);
      if (binding.transport !== 'none' && binding.transport !== 'bearer')
        fail(`${location}.auth.${label}.transport`, 'expected none or bearer');
      return [label, binding.transport];
    });
  const rawFields = record(
    Object.hasOwn(value, 'fields') ? value.fields : {},
    `${location}.fields`,
  );
  const fields: Record<string, Schema> = Object.fromEntries(
    Object.keys(rawFields)
      .sort()
      .map((name) => {
        const fieldLocation = `${location}.fields.${name}`;
        contractField(text(name, fieldLocation), fieldLocation);
        if (name === 'auth' || name === 'surfaces')
          fail(fieldLocation, 'reserved policy field');
        const field = record(rawFields[name], fieldLocation);
        // Metadata needs enums and scalar types, not a second executable schema
        // language. In particular host Unicode versions must not change acceptance.
        keys(field, ['type', 'enum'], fieldLocation);
        if (
          typeof field.type !== 'string' ||
          !['string', 'number', 'integer', 'boolean', 'null'].includes(
            field.type,
          )
        )
          fail(`${fieldLocation}.type`, 'expected a scalar type');
        return [name, normalizeSchema(field, fieldLocation)];
      }),
  );
  if (entries.length > 0)
    fields.auth = { kind: 'string', literals: entries.map(([label]) => label) };
  let required: readonly string[] = [];
  if (Object.hasOwn(value, 'required')) {
    if (!Array.isArray(value.required))
      fail(`${location}.required`, 'expected an array of field names');
    required =
      value.required.length === 0
        ? []
        : labels(value.required, `${location}.required`);
    for (const name of required) {
      if (!Object.hasOwn(fields, name))
        fail(
          `${location}.required`,
          `undeclared policy field ${JSON.stringify(name)}`,
        );
    }
  }
  return {
    version: 3,
    auth: Object.fromEntries(entries),
    fields: Object.fromEntries(
      Object.entries(fields).sort(([left], [right]) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    ),
    required: [...required].sort(),
    surfaces: Object.hasOwn(value, 'surfaces')
      ? surfaceNames(value.surfaces, `${location}.surfaces`)
      : [],
  };
}

export function normalizeOperationPolicy(
  input: unknown,
  vocabulary: PolicyVocabulary,
  transport: AuthTransport,
  location: string,
  configuredSurfaces?: readonly string[],
): { policy: Policy; surfaces: readonly string[] } {
  const value = record(input, location);
  const names = Object.keys(vocabulary.fields);
  keys(value, [...names, 'surfaces'], location);
  for (const name of vocabulary.required) {
    if (!Object.hasOwn(value, name))
      fail(`${location}.${name}`, 'required policy field is missing');
  }
  const policy: Record<string, Scalar> = {};
  for (const name of names) {
    if (!Object.hasOwn(value, name)) continue;
    const field = vocabulary.fields[name]!;
    const item = value[name];
    const matches =
      field.kind === 'null'
        ? item === null
        : field.kind === 'integer'
          ? typeof item === 'number' && Number.isInteger(item)
          : typeof item === field.kind;
    if (!matches || (typeof item === 'number' && !Number.isFinite(item)))
      fail(`${location}.${name}`, `expected ${field.kind} policy value`);
    if (
      'literals' in field &&
      field.literals &&
      !field.literals.includes(item as Scalar)
    )
      fail(
        `${location}.${name}`,
        `undeclared policy label ${JSON.stringify(item)}`,
      );
    policy[name] = item as Scalar;
  }
  if (
    typeof policy.auth === 'string' &&
    vocabulary.auth[policy.auth] !== transport
  )
    fail(
      `${location}.auth`,
      `auth label ${JSON.stringify(policy.auth)} requires ${vocabulary.auth[policy.auth]} transport but effective OpenAPI security requires ${transport}`,
    );
  let surfaces: readonly string[];
  if (configuredSurfaces !== undefined) {
    if (Object.hasOwn(value, 'surfaces'))
      fail(
        `${location}.surfaces`,
        'cannot combine inline and configured surface membership',
      );
    if (configuredSurfaces.length === 0)
      fail(
        `${location}.surfaces`,
        'operation has no configured surface membership',
      );
    surfaces = configuredSurfaces;
  } else {
    surfaces = surfaceNames(value.surfaces, `${location}.surfaces`);
    for (const surface of surfaces) {
      if (!vocabulary.surfaces.includes(surface))
        fail(
          `${location}.surfaces`,
          `undeclared surface ${JSON.stringify(surface)}`,
        );
    }
  }
  return { policy, surfaces };
}
