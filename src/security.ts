import { annotations, fail, keys, record, safeKey } from './diagnostics.js';
import type { AuthTransport } from './model.js';

export function normalizeSecuritySchemes(input: unknown): ReadonlySet<string> {
  const location = 'components.securitySchemes';
  const schemes = record(input, location);
  const bearer = new Set<string>();
  for (const [name, rawScheme] of Object.entries(schemes)) {
    safeKey(name, `${location}.${name}`);
    if (!/^[A-Za-z0-9._-]+$/.test(name))
      fail(`${location}.${name}`, 'unsupported security scheme component name');
    const scheme = record(rawScheme, `${location}.${name}`);
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
        'unsupported security scheme; only inline HTTP bearer schemes are supported',
      );
    if (
      Object.hasOwn(scheme, 'bearerFormat') &&
      typeof scheme.bearerFormat !== 'string'
    )
      fail(`${location}.${name}.bearerFormat`, 'expected a string annotation');
    // bearerFormat is documentation, not a token parser or provider selector.
    bearer.add(name);
  }
  return bearer;
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
