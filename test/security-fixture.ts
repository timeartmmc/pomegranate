import assert from 'node:assert/strict';
import { present } from './assertions.ts';
import type { RuntimeClient } from './runtime-types.ts';

const responses = { 204: { description: 'Synthetic security accepted' } };
const leaf = (operationId: string, security: unknown) => ({
  get: { operationId, security, responses },
});

export const securitySelection = {
  clients: ['consumer'],
  surfaces: {
    consumer: [
      'inherited',
      'queryKey',
      'cookieKey',
      'basic',
      'bearer',
      'oauth',
      'public',
      'publicObject',
      'optional',
      'alternative',
    ],
  },
} as const;

export function securityFixture() {
  return {
    openapi: '3.1.1',
    info: { title: 'Synthetic security requirements', version: '1' },
    security: [{ HeaderKey: [], OAuthAlias: ['widgets:read', 'x-scope'] }],
    components: {
      securitySchemes: {
        HeaderKey: { type: 'apiKey', in: 'header', name: 'X-Widget-Key' },
        QueryKey: { type: 'apiKey', in: 'query', name: 'widget_key' },
        CookieKey: { type: 'apiKey', in: 'cookie', name: 'widget_session' },
        Basic: { type: 'http', scheme: 'BaSiC' },
        Bearer: { type: 'http', scheme: 'BeArEr', bearerFormat: 'Synthetic' },
        OAuthAlias: { $ref: '#/components/securitySchemes/OAuth' },
        OAuth: {
          type: 'oauth2',
          flows: {
            implicit: {
              authorizationUrl: '/authorize',
              scopes: { 'widgets:read': 'Read synthetic widgets' },
            },
            password: { tokenUrl: '/token', scopes: {} },
            clientCredentials: { tokenUrl: '/token', scopes: {} },
            authorizationCode: {
              authorizationUrl: '/authorize',
              tokenUrl: '/token',
              refreshUrl: '/refresh',
              scopes: { 'x-scope': 'An application scope, not an extension' },
            },
          },
        },
      },
    },
    paths: {
      '/inherited': { get: { operationId: 'inherited', responses } },
      '/query-key': leaf('queryKey', [{ QueryKey: [] }]),
      '/cookie-key': leaf('cookieKey', [{ CookieKey: [] }]),
      '/basic': leaf('basic', [{ Basic: [] }]),
      '/bearer': leaf('bearer', [{ Bearer: [] }]),
      '/oauth': leaf('oauth', [{ OAuthAlias: ['widgets:read'] }]),
      '/public': leaf('public', []),
      '/public-object': leaf('publicObject', [{}]),
      '/optional': leaf('optional', [{ Bearer: [] }, {}]),
      '/alternative': leaf('alternative', [
        { Basic: [] },
        { HeaderKey: [], OAuthAlias: ['widgets:read'] },
      ]),
    },
  };
}

export const securityConsumer = `
import { operations } from './client.consumer.ts';
import type { Security, SecurityRequirement } from './client.consumer.ts';
export const build: typeof operations.inherited.build = operations.inherited.build;

export function credentialIdentity(requirement: SecurityRequirement): string {
  switch (requirement.transport) {
    case 'basic':
    case 'bearer': return requirement.scheme;
    case 'apiKey': {
      const location: 'header' | 'query' | 'cookie' = requirement.in;
      return requirement.scheme + ':' + location + ':' + requirement.name;
    }
    case 'oauth2': {
      const scopes: readonly string[] = requirement.scopes;
      return requirement.scheme + ':' + scopes.join(',');
    }
  }
}

export function securityIdentity(security: Security): readonly string[] {
  if (security.transport === 'none') return [];
  if (security.transport === 'alternatives')
    return security.alternatives.map(requirements => requirements.map(credentialIdentity).join('+'));
  return [credentialIdentity(security)];
}

function readonlyRequirements(security: Security): void {
  if (security.transport === 'alternatives') {
    // @ts-expect-error Security alternatives are immutable.
    security.alternatives.push([]);
    for (const requirements of security.alternatives) {
      // @ts-expect-error AND requirements are immutable too.
      requirements.push({transport:'bearer',scheme:'Other'});
    }
  } else if (security.transport === 'oauth2') {
    // @ts-expect-error OAuth scope requirements are immutable.
    security.scopes.push('other');
  }
}
void readonlyRequirements;
// @ts-expect-error Credential injection is application-owned, outside builder inputs.
operations.bearer.build({token:'application-owned'});
`;

export function verifySecurity(client: RuntimeClient): void {
  const expected = {
    inherited: {
      transport: 'alternatives',
      alternatives: [
        [
          {
            transport: 'apiKey',
            scheme: 'HeaderKey',
            in: 'header',
            name: 'X-Widget-Key',
          },
          {
            transport: 'oauth2',
            scheme: 'OAuthAlias',
            scopes: ['widgets:read', 'x-scope'],
          },
        ],
      ],
    },
    queryKey: {
      transport: 'apiKey',
      scheme: 'QueryKey',
      in: 'query',
      name: 'widget_key',
    },
    cookieKey: {
      transport: 'apiKey',
      scheme: 'CookieKey',
      in: 'cookie',
      name: 'widget_session',
    },
    basic: { transport: 'basic', scheme: 'Basic' },
    bearer: { transport: 'bearer', scheme: 'Bearer' },
    oauth: {
      transport: 'oauth2',
      scheme: 'OAuthAlias',
      scopes: ['widgets:read'],
    },
    public: { transport: 'none' },
    publicObject: { transport: 'none' },
    optional: {
      transport: 'alternatives',
      alternatives: [[{ transport: 'bearer', scheme: 'Bearer' }], []],
    },
    alternative: {
      transport: 'alternatives',
      alternatives: [
        [{ transport: 'basic', scheme: 'Basic' }],
        [
          {
            transport: 'apiKey',
            scheme: 'HeaderKey',
            in: 'header',
            name: 'X-Widget-Key',
          },
          {
            transport: 'oauth2',
            scheme: 'OAuthAlias',
            scopes: ['widgets:read'],
          },
        ],
      ],
    },
  };
  for (const [id, security] of Object.entries(expected)) {
    const request = present(client.operations[id]).build();
    assert.deepEqual(JSON.parse(JSON.stringify(request.security)), security);
    assert.equal(Object.getPrototypeOf(request.security), null);
    assert.ok(Object.isFrozen(request.security));
    assert.equal(request.url.includes('?'), false);
    assert.deepEqual(Object.keys(request.headers), []);
    if (request.security.transport === 'alternatives') {
      assert.ok(Object.isFrozen(request.security.alternatives));
      for (const requirements of request.security.alternatives) {
        assert.ok(Object.isFrozen(requirements));
        for (const requirement of requirements) {
          assert.equal(Object.getPrototypeOf(requirement), null);
          assert.ok(Object.isFrozen(requirement));
          if (requirement.transport === 'oauth2')
            assert.ok(Object.isFrozen(requirement.scopes));
        }
      }
    } else if (request.security.transport === 'oauth2') {
      assert.ok(Object.isFrozen(request.security.scopes));
    }
  }
}
