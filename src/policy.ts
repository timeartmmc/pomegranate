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
import { schemaNode } from './schema-node.js';

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
): ReadonlyMap<string, readonly string[]> {
  const value = record(input, 'surfaces');
  const names = Object.keys(value).sort();
  surfaceNames(names, 'surfaces');
  return new Map(
    names.map(
      (name) => [name, labels(value[name], `surfaces.${name}`)] as const,
    ),
  );
}

export function normalizeVocabulary(input: unknown): PolicyVocabulary {
  const location = 'x-pom-policy';
  const value = record(input, location);
  if (value.version !== 3)
    fail(`${location}.version`, 'expected policy version 3');
  keys(value, ['version', 'auth', 'fields', 'required', 'surfaces'], location);
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
  const fields = new Map<string, Schema>(
    Object.keys(rawFields)
      .sort()
      .map((name): [string, Schema] => {
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
    fields.set(
      'auth',
      schemaNode({ kind: 'string', literals: entries.map(([label]) => label) }),
    );
  let required: readonly string[] = [];
  if (Object.hasOwn(value, 'required')) {
    if (!Array.isArray(value.required))
      fail(`${location}.required`, 'expected an array of field names');
    required =
      value.required.length === 0
        ? []
        : labels(value.required, `${location}.required`);
    for (const name of required) {
      if (!fields.has(name))
        fail(
          `${location}.required`,
          `undeclared policy field ${JSON.stringify(name)}`,
        );
    }
  }
  return {
    version: 3,
    auth: new Map(entries),
    // Keep integer-like names in numeric order before other sorted field names.
    fields: new Map(
      Object.entries(
        Object.fromEntries(
          [...fields].sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        ),
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
  const names = [...vocabulary.fields.keys()];
  keys(value, [...names, 'surfaces'], location);
  for (const name of vocabulary.required) {
    if (!Object.hasOwn(value, name))
      fail(`${location}.${name}`, 'required policy field is missing');
  }
  const policy = new Map<string, Scalar>();
  for (const name of names) {
    if (!Object.hasOwn(value, name)) continue;
    const field = vocabulary.fields.get(name)!;
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
    policy.set(name, item as Scalar);
  }
  const auth = policy.get('auth');
  if (typeof auth === 'string' && vocabulary.auth.get(auth) !== transport)
    fail(
      `${location}.auth`,
      `auth label ${JSON.stringify(auth)} requires ${vocabulary.auth.get(auth)} transport but effective OpenAPI security requires ${transport}`,
    );
  let surfaces: readonly string[];
  if (configuredSurfaces !== undefined) {
    if (Object.hasOwn(value, 'surfaces'))
      fail(
        `${location}.surfaces`,
        'cannot combine inline and configured surface membership',
      );
    surfaces = configuredSurfaces;
  } else {
    if (!Object.hasOwn(value, 'surfaces'))
      fail(
        `${location}.surfaces`,
        'operation has no surface membership; assign operation IDs in the config "surfaces" map, or declare "x-pom-policy.surfaces" and operation "x-pom.surfaces"',
      );
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
