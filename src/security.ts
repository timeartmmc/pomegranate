import {
  annotations,
  fail,
  keys,
  record,
  safeKey,
  stringArray,
  validComponentName,
} from './diagnostics.js';
import {
  localComponentReference,
  validateComponentAliases,
} from './component-references.js';
import type { Security } from './runtime.js';

export function normalizeSecuritySchemes(
  input: unknown,
  dialect: '3.0' | '3.1' = '3.1',
): ReadonlySet<string> {
  const location = 'components.securitySchemes';
  const schemes = record(input, location);
  const references = new Map<string, string | undefined>();
  for (const [name, rawScheme] of Object.entries(schemes)) {
    safeKey(name, `${location}.${name}`);
    if (!validComponentName(name))
      fail(`${location}.${name}`, 'unsupported security scheme component name');
    const scheme = record(rawScheme, `${location}.${name}`);
    if (Object.hasOwn(scheme, '$ref')) {
      keys(scheme, ['$ref', 'summary', 'description'], `${location}.${name}`);
      annotations(scheme, `${location}.${name}`);
      const target = localComponentReference(
        scheme.$ref,
        'securitySchemes',
        `${location}.${name}.$ref`,
      );
      safeKey(target, `${location}.${name}.$ref`);
      if (!validComponentName(target))
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
    if (scheme.type === 'mutualTLS' && dialect === '3.0')
      fail(
        `${location}.${name}.type`,
        'mutualTLS is not supported in OpenAPI 3.0; only HTTP bearer schemes are supported',
      );
    if (
      scheme.type === 'apiKey' ||
      scheme.type === 'oauth2' ||
      scheme.type === 'openIdConnect' ||
      scheme.type === 'mutualTLS'
    )
      fail(
        `${location}.${name}`,
        `security scheme type "${scheme.type}" is not supported in this version; only HTTP bearer schemes are supported`,
      );
    if (scheme.type !== 'http')
      fail(
        `${location}.${name}.type`,
        `unrecognized security scheme type; recognized spellings are "http", "apiKey", "oauth2", "openIdConnect"${dialect === '3.1' ? ' and "mutualTLS"' : ''}; only HTTP bearer schemes are supported`,
      );
    keys(
      scheme,
      ['type', 'scheme', 'bearerFormat', 'description'],
      `${location}.${name}`,
    );
    annotations(scheme, `${location}.${name}`);
    if (
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
  validateComponentAliases(references, 'securitySchemes');
  return new Set(references.keys());
}

export function normalizeSecurity(
  input: unknown,
  bearerSchemes: ReadonlySet<string>,
  location: string,
): Security {
  if (!Array.isArray(input))
    fail(location, 'expected an array of security requirements');
  if (input.length === 0) return { transport: 'none' };
  // Multiple requirement objects mean OR, and multiple schemes in one object
  // mean AND. Neither can be reduced to one required transport without losing
  // credential-selection or optional-auth semantics. See OAS 3.1.0 §4.8.30.
  if (input.length !== 1)
    fail(
      location,
      'unsupported security alternatives (OR); declare one bearer requirement or an explicit public override',
    );
  const requirement = record(
    Object.hasOwn(input, 0) ? input[0] : undefined,
    `${location}[0]`,
  );
  const names = Object.keys(requirement);
  if (names.length === 0) return { transport: 'none' };
  if (names.length !== 1)
    fail(location, 'unsupported combined security schemes (AND)');
  const name = names[0]!;
  if (!bearerSchemes.has(name))
    fail(`${location}[0].${name}`, 'undeclared bearer security scheme');
  const roles = requirement[name];
  if (!stringArray(roles))
    fail(`${location}[0].${name}`, 'expected an array of role names');
  if (roles.length !== 0)
    fail(
      `${location}[0].${name}`,
      'nonempty security role requirements are unsupported',
    );
  // Keep the requirement's declared name, including aliases. Transport alone
  // loses the identity applications need to select the operation's credential.
  return { transport: 'bearer', scheme: name };
}
