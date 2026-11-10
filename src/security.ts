import {
  annotations,
  arrayValues,
  fail,
  keys,
  record,
  stringArray,
  text,
  validHeaderName,
  wellFormedUnicode,
} from './diagnostics.js';
import { normalizeComponents } from './component-references.js';
import type { Security, SecurityRequirement } from './runtime.js';

type SecurityScheme =
  | Readonly<{ transport: 'basic' | 'bearer' }>
  | Readonly<{
      transport: 'apiKey';
      in: 'header' | 'query' | 'cookie';
      name: string;
    }>
  | Readonly<{ transport: 'oauth2'; scopes: ReadonlySet<string> }>;

const flowUrls = {
  implicit: ['authorizationUrl'],
  password: ['tokenUrl'],
  clientCredentials: ['tokenUrl'],
  authorizationCode: ['authorizationUrl', 'tokenUrl'],
} as const;

function oauthScopes(input: unknown, location: string): ReadonlySet<string> {
  const flows = record(input, location);
  keys(flows, Object.keys(flowUrls), location);
  const scopes = new Set<string>();
  for (const name of Object.keys(flows)) {
    const path = `${location}.${name}`;
    const flow = record(flows[name], path);
    const urls = flowUrls[name as keyof typeof flowUrls];
    keys(flow, [...urls, 'refreshUrl', 'scopes'], path);
    // OpenAPI permits relative URLs. These declarations describe application
    // authentication setup; the compiler neither resolves nor fetches them.
    for (const url of urls) text(flow[url], `${path}.${url}`);
    if (Object.hasOwn(flow, 'refreshUrl'))
      text(flow.refreshUrl, `${path}.refreshUrl`);
    const declared = record(flow.scopes, `${path}.scopes`);
    for (const [scope, description] of Object.entries(declared)) {
      if (typeof description !== 'string')
        fail(`${path}.scopes.${scope}`, 'expected a string scope description');
      scopes.add(scope);
    }
  }
  return scopes;
}

export function normalizeSecuritySchemes(
  input: unknown,
  dialect: '3.0' | '3.1' = '3.1',
): ReadonlyMap<string, SecurityScheme> {
  return normalizeComponents(input, 'securitySchemes', (scheme, location) => {
    if (scheme.type === 'mutualTLS' && dialect === '3.0')
      fail(`${location}.type`, 'mutualTLS is not supported in OpenAPI 3.0');
    if (scheme.type === 'openIdConnect' || scheme.type === 'mutualTLS')
      fail(
        location,
        `security scheme type "${scheme.type}" is not supported in this version`,
      );
    if (!['http', 'apiKey', 'oauth2'].includes(scheme.type as string))
      fail(
        `${location}.type`,
        `unrecognized security scheme type; recognized spellings are "http", "apiKey", "oauth2", "openIdConnect"${dialect === '3.1' ? ' and "mutualTLS"' : ''}`,
      );
    if (scheme.type === 'apiKey') {
      keys(scheme, ['type', 'in', 'name', 'description'], location);
      annotations(scheme, location);
      if (
        scheme.in !== 'header' &&
        scheme.in !== 'query' &&
        scheme.in !== 'cookie'
      )
        fail(`${location}.in`, 'expected header, query or cookie');
      const name = text(scheme.name, `${location}.name`);
      if (
        (scheme.in === 'header' || scheme.in === 'cookie') &&
        !validHeaderName(name)
      )
        fail(`${location}.name`, `invalid API key ${scheme.in} name`);
      if (!wellFormedUnicode(name))
        fail(
          `${location}.name`,
          'API key names must contain well-formed Unicode',
        );
      return { transport: 'apiKey', in: scheme.in, name };
    }
    if (scheme.type === 'oauth2') {
      keys(scheme, ['type', 'flows', 'description'], location);
      annotations(scheme, location);
      return {
        transport: 'oauth2',
        scopes: oauthScopes(scheme.flows, `${location}.flows`),
      };
    }
    keys(scheme, ['type', 'scheme', 'bearerFormat', 'description'], location);
    annotations(scheme, location);
    const transport =
      typeof scheme.scheme === 'string' ? scheme.scheme.toLowerCase() : '';
    if (transport !== 'basic' && transport !== 'bearer')
      fail(
        location,
        'unsupported security scheme; expected HTTP basic or bearer',
      );
    if (Object.hasOwn(scheme, 'bearerFormat')) {
      if (transport !== 'bearer')
        fail(`${location}.bearerFormat`, 'bearerFormat requires HTTP bearer');
      if (typeof scheme.bearerFormat !== 'string')
        fail(`${location}.bearerFormat`, 'expected a string annotation');
    }
    // bearerFormat is documentation, not a token parser or provider selector.
    return { transport };
  });
}

export function normalizeSecurity(
  input: unknown,
  schemes: ReadonlyMap<string, SecurityScheme>,
  location: string,
): Security {
  if (!Array.isArray(input))
    fail(location, 'expected an array of security requirements');
  if (input.length === 0) return { transport: 'none' };
  const alternatives = Array.from(arrayValues(input), (raw, index) => {
    const path = `${location}[${index}]`;
    const requirement = record(raw, path);
    return Object.keys(requirement).map((name): SecurityRequirement => {
      const memberLocation = `${path}.${name}`;
      const scheme = schemes.get(name);
      if (!scheme) fail(memberLocation, 'undeclared security scheme');
      const scopes = requirement[name];
      if (!stringArray(scopes))
        fail(memberLocation, 'expected an array of scope or role names');
      if (scheme.transport === 'oauth2') {
        for (const scope of scopes)
          if (!scheme.scopes.has(scope))
            fail(
              memberLocation,
              `undeclared OAuth2 scope ${JSON.stringify(scope)}`,
            );
        return { transport: 'oauth2', scheme: name, scopes: [...scopes] };
      }
      if (scopes.length !== 0)
        fail(
          memberLocation,
          'nonempty security role requirements are unsupported',
        );
      // Keep the declared identity, including aliases. The terminal component
      // describes credentials but does not replace the application's selector.
      if (scheme.transport === 'apiKey')
        return {
          transport: 'apiKey',
          scheme: name,
          in: scheme.in,
          name: scheme.name,
        };
      return { transport: scheme.transport, scheme: name };
    });
  });
  // Arrays are OR; members within each array are AND. An empty conjunction is
  // anonymous access, including when it coexists with authenticated branches.
  if (alternatives.length === 1) {
    const only = alternatives[0]!;
    if (only.length === 0) return { transport: 'none' };
    if (only.length === 1) return only[0]!;
  }
  return { transport: 'alternatives', alternatives };
}
