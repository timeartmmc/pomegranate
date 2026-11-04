import { annotations, fail, keys, record, safeKey } from './diagnostics.js';
import type { AuthTransport } from './model.js';

export function normalizeSecuritySchemes(input: unknown): ReadonlySet<string> {
  const location = 'components.securitySchemes';
  const schemes = record(input, location);
  const references = new Map<string, string | undefined>();
  for (const [name, rawScheme] of Object.entries(schemes)) {
    safeKey(name, `${location}.${name}`);
    if (name.length === 0 || /[^A-Za-z0-9._-]/.test(name))
      fail(`${location}.${name}`, 'unsupported security scheme component name');
    const scheme = record(rawScheme, `${location}.${name}`);
    if (Object.hasOwn(scheme, '$ref')) {
      keys(scheme, ['$ref', 'summary', 'description'], `${location}.${name}`);
      annotations(scheme, `${location}.${name}`);
      const prefix = '#/components/securitySchemes/';
      if (typeof scheme.$ref !== 'string' || !scheme.$ref.startsWith(prefix))
        fail(
          `${location}.${name}.$ref`,
          'only local component security scheme references are supported',
        );
      const target = scheme.$ref.slice(prefix.length);
      safeKey(target, `${location}.${name}.$ref`);
      if (target.length === 0 || /[^A-Za-z0-9._-]/.test(target))
        fail(
          `${location}.${name}.$ref`,
          'unsupported security scheme component name',
        );
      if (!Object.hasOwn(schemes, target))
        fail(
          `${location}.${name}.$ref`,
          `unresolved security scheme reference ${target}`,
        );
      references.set(name, target);
      continue;
    }
    keys(
      scheme,
      ['type', 'scheme', 'bearerFormat', 'description'],
      `${location}.${name}`,
    );
    annotations(scheme, `${location}.${name}`);
    if (
      scheme.type !== 'http' ||
      typeof scheme.scheme !== 'string' ||
      scheme.scheme.toLowerCase() !== 'bearer'
    )
      fail(
        `${location}.${name}`,
        'unsupported security scheme; only HTTP bearer schemes are supported',
      );
    if (
      Object.hasOwn(scheme, 'bearerFormat') &&
      typeof scheme.bearerFormat !== 'string'
    )
      fail(`${location}.${name}.bearerFormat`, 'expected a string annotation');
    // bearerFormat is documentation, not a token parser or provider selector.
    references.set(name, undefined);
  }
  const checked = new Set<string>();
  for (const name of references.keys()) {
    const pending = new Set<string>();
    let current: string | undefined = name;
    // Alias depth is independent of schema nesting. Walk iteratively so a
    // supported local chain cannot exhaust the JavaScript call stack.
    while (current !== undefined && !checked.has(current)) {
      if (pending.has(current))
        fail(`${location}.${current}.$ref`, 'cyclic security scheme reference');
      pending.add(current);
      current = references.get(current);
    }
    for (const visited of pending) checked.add(visited);
  }
  return new Set(references.keys());
}

export function normalizeSecurity(
  input: unknown,
  bearerSchemes: ReadonlySet<string>,
  location: string,
): AuthTransport {
  if (!Array.isArray(input))
    fail(location, 'expected an array of security requirements');
  if (input.length === 0) return 'none';
  // Multiple requirement objects mean OR, and multiple schemes in one object
  // mean AND. Neither can be reduced to one required transport without losing
  // credential-selection or optional-auth semantics. See OAS 3.1.0 §4.8.30.
  if (input.length !== 1)
    fail(
      location,
      'unsupported security alternatives (OR); declare one bearer requirement or an explicit public override',
    );
  const requirement = record(input[0], `${location}[0]`);
  const names = Object.keys(requirement);
  if (names.length === 0) return 'none';
  if (names.length !== 1)
    fail(location, 'unsupported combined security schemes (AND)');
  const name = names[0]!;
  if (!bearerSchemes.has(name))
    fail(`${location}[0].${name}`, 'undeclared bearer security scheme');
  const roles = requirement[name];
  if (!Array.isArray(roles) || roles.some((role) => typeof role !== 'string'))
    fail(`${location}[0].${name}`, 'expected an array of role names');
  if (roles.length !== 0)
    fail(
      `${location}[0].${name}`,
      'nonempty security role requirements are unsupported',
    );
  return 'bearer';
}
