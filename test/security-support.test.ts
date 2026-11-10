import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { buildDescriptor } from '../dist/descriptor.js';
import { parseYaml } from '../dist/yaml.js';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient } from './runtime-types.ts';

const selection = {
  clients: ['consumer'],
  surfaces: { consumer: ['getRecords'], internal: ['internalRecords'] },
};
const schemes = {
  Session: { type: 'http', scheme: 'bEaReR', bearerFormat: 'Annotation' },
  Basic: { type: 'http', scheme: 'BaSiC' },
  HeaderKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
  QueryKey: { type: 'apiKey', in: 'query', name: 'api_key' },
  CookieKey: { type: 'apiKey', in: 'cookie', name: 'session_key' },
  OAuth: {
    type: 'oauth2',
    flows: {
      implicit: {
        authorizationUrl: '/authorize',
        scopes: { read: 'Read records' },
      },
      password: { tokenUrl: '/password', scopes: {} },
      clientCredentials: {
        tokenUrl: '/token',
        refreshUrl: '/refresh',
        scopes: { 'x-records:write': 'Write records' },
      },
      authorizationCode: {
        authorizationUrl: '/authorize',
        tokenUrl: '/token',
        scopes: { offline: 'Offline access' },
      },
    },
  },
};

function document(
  security: unknown = [],
  declarations: Record<string, unknown> = schemes,
) {
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic security contract', version: '1' },
    security,
    components: { securitySchemes: structuredClone(declarations) },
    paths: {
      '/records': {
        get: {
          operationId: 'getRecords',
          responses: { 200: { description: 'Ready' } },
        },
      },
      '/internal': {
        get: {
          operationId: 'internalRecords',
          security: [],
          responses: { 204: { description: 'Ready' } },
        },
      },
    },
  };
}

function effective(input: ReturnType<typeof document>) {
  return present(
    buildDescriptor(input, selection).operations.find(
      ({ id }) => id === 'getRecords',
    ),
  ).security;
}

const leaves = [
  [{ Session: [] }, { transport: 'bearer', scheme: 'Session' }],
  [{ Basic: [] }, { transport: 'basic', scheme: 'Basic' }],
  [
    { HeaderKey: [] },
    {
      transport: 'apiKey',
      scheme: 'HeaderKey',
      in: 'header',
      name: 'X-API-Key',
    },
  ],
  [
    { QueryKey: [] },
    { transport: 'apiKey', scheme: 'QueryKey', in: 'query', name: 'api_key' },
  ],
  [
    { CookieKey: [] },
    {
      transport: 'apiKey',
      scheme: 'CookieKey',
      in: 'cookie',
      name: 'session_key',
    },
  ],
  [
    { OAuth: ['offline', 'read', 'x-records:write'] },
    {
      transport: 'oauth2',
      scheme: 'OAuth',
      scopes: ['offline', 'read', 'x-records:write'],
    },
  ],
] as const;

void test('supported security schemes retain identity and semantics in OpenAPI 3.0/3.1 JSON and YAML', async () => {
  for (const version of ['3.0.4', '3.1.2']) {
    for (const [requirement, expected] of leaves) {
      const input = document([requirement]);
      input.openapi = version;
      const before = structuredClone(input);
      assert.deepEqual(effective(input), expected);
      const outputs = await compile(input, selection);
      assert.deepEqual(
        await compile(parseYaml(stringify(input), 'security.yaml'), selection),
        outputs,
      );
      assert.deepEqual(input, before);
    }
  }
});

void test('security inheritance and operation overrides distinguish required, optional and public access', () => {
  const input = document([
    { HeaderKey: [], OAuth: ['read'] },
    { Basic: [] },
    {},
  ]);
  const inherited = {
    transport: 'alternatives',
    alternatives: [
      [
        {
          transport: 'apiKey',
          scheme: 'HeaderKey',
          in: 'header',
          name: 'X-API-Key',
        },
        { transport: 'oauth2', scheme: 'OAuth', scopes: ['read'] },
      ],
      [{ transport: 'basic', scheme: 'Basic' }],
      [],
    ],
  };
  assert.deepEqual(effective(input), inherited);
  for (const security of [[], [{}]]) {
    Object.assign(input.paths['/records'].get, { security });
    assert.deepEqual(effective(input), { transport: 'none' });
  }
  Object.assign(input.paths['/records'].get, { security: [{ Session: [] }] });
  assert.deepEqual(effective(input), {
    transport: 'bearer',
    scheme: 'Session',
  });
  Reflect.deleteProperty(input.paths['/records'].get, 'security');
  assert.deepEqual(effective(input), inherited);
  Reflect.deleteProperty(input, 'security');
  assert.deepEqual(effective(input), { transport: 'none' });
  Object.assign(input.paths['/records'].get, { security: [{ QueryKey: [] }] });
  assert.deepEqual(effective(input), leaves[3][1]);
});

void test('OAuth2 permits empty flow declarations and preserves empty or repeated requested scopes', async () => {
  const empty = document([{ OAuth: [] }], {
    OAuth: { type: 'oauth2', flows: {} },
  });
  assert.deepEqual(effective(empty), {
    transport: 'oauth2',
    scheme: 'OAuth',
    scopes: [],
  });
  await compile(empty, selection);
  const repeated = document([{ OAuth: ['read', 'read'] }]);
  assert.deepEqual(effective(repeated), {
    transport: 'oauth2',
    scheme: 'OAuth',
    scopes: ['read', 'read'],
  });
});

void test('application auth labels must match the complete effective security transport', async () => {
  const cases = [
    ...leaves.map(
      ([requirement, expected]) => [[requirement], expected.transport] as const,
    ),
    [[], 'none'],
    [[{ Session: [], Basic: [] }], 'alternatives'],
    [[{ Session: [] }, {}], 'alternatives'],
  ] as const;
  for (const [security, transport] of cases) {
    const input = document(security);
    const auth = { chosen: { transport } };
    Object.assign(input, { 'x-pom-policy': { version: 3, auth } });
    Object.assign(input.paths['/records'].get, { 'x-pom': { auth: 'chosen' } });
    await compile(input, selection);
    Object.assign(auth.chosen, {
      transport: transport === 'none' ? 'bearer' : 'none',
    });
    await assert.rejects(
      compile(input, selection),
      /auth label.*requires.*transport.*effective OpenAPI security/,
    );
  }
});

void test('aliases preserve requirement names, AND members, OR branches and scope order without erasing optional access', async () => {
  const declarations = {
    ...schemes,
    KeyAlias: { $ref: '#/components/securitySchemes/HeaderKey' },
    OAuthAlias: { $ref: '#/components/securitySchemes/OAuth' },
  };
  const input = document(
    [
      {},
      { OAuthAlias: ['read', 'offline'], KeyAlias: [] },
      { HeaderKey: [] },
      {},
    ],
    declarations,
  );
  assert.deepEqual(effective(input), {
    transport: 'alternatives',
    alternatives: [
      [],
      [
        {
          transport: 'oauth2',
          scheme: 'OAuthAlias',
          scopes: ['read', 'offline'],
        },
        {
          transport: 'apiKey',
          scheme: 'KeyAlias',
          in: 'header',
          name: 'X-API-Key',
        },
      ],
      [
        {
          transport: 'apiKey',
          scheme: 'HeaderKey',
          in: 'header',
          name: 'X-API-Key',
        },
      ],
      [],
    ],
  });
  const before = await compile(input, selection);
  Object.assign(input, {
    security: [{ OAuth: ['read', 'offline'], KeyAlias: [] }],
  });
  assert.notDeepEqual(await compile(input, selection), before);
  const inherited = document([{ OAuth: ['read'] }]);
  const scoped = await compile(inherited, selection);
  Object.assign(inherited, { security: [{ OAuth: ['offline'] }] });
  assert.notDeepEqual(await compile(inherited, selection), scoped);
});

void test('generated security metadata is detached and deeply immutable while credential application stays outside builders', async (t) => {
  const input = document([
    { QueryKey: [], CookieKey: [], OAuth: ['read'] },
    {},
  ]);
  Object.assign(input.paths['/records'].get, {
    parameters: [
      {
        name: 'limit',
        in: 'query',
        required: true,
        schema: { type: 'integer', minimum: 1 },
      },
    ],
  });
  const expected = effective(input);
  const root = await generatedTestWorkspace(t, await compile(input, selection));
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const operation = present(client.operations.getRecords);
  const request = operation.build({ query: { limit: 2 } });
  assert.deepEqual(structuredClone(request.security), expected);
  assert.equal(request.url, '/records?limit=2');
  assert.deepEqual(Object.keys(request.headers), []);
  assert.equal(request.headers['Authorization'], undefined);
  assert.equal(request.headers['Cookie'], undefined);
  assert.equal(Object.getPrototypeOf(request.security), null);
  assert.ok(Object.isFrozen(request.security));
  assert.equal(request.security.transport, 'alternatives');
  if (request.security.transport !== 'alternatives')
    assert.fail('Expected alternatives');
  assert.ok(Object.isFrozen(request.security.alternatives));
  assert.equal(
    Reflect.set(request.security.alternatives, 1, [
      { transport: 'bearer', scheme: 'Other' },
    ]),
    false,
  );
  const branch = present(request.security.alternatives[0]);
  assert.ok(Object.isFrozen(branch));
  assert.equal(Reflect.set(branch, 0, { transport: 'none' }), false);
  for (const requirement of branch) {
    assert.equal(Object.getPrototypeOf(requirement), null);
    assert.ok(Object.isFrozen(requirement));
    assert.equal(Reflect.set(requirement, 'scheme', 'Other'), false);
    if (requirement.transport === 'oauth2') {
      assert.ok(Object.isFrozen(requirement.scopes));
      assert.equal(Reflect.set(requirement.scopes, 0, 'offline'), false);
    }
  }
  Object.assign(input, { security: [] });
  assert.deepEqual(
    structuredClone(operation.build({ query: { limit: 3 } }).security),
    expected,
  );
  assert.throws(() => operation.build(), client.RequestValidationError);
  assert.throws(
    () => operation.build({ query: { limit: 0 } }),
    client.RequestValidationError,
  );
  const authorized = request.validateHeaders({
    ...request.headers,
    Authorization: 'Bearer application-owned',
  });
  assert.equal(authorized['authorization'], 'Bearer application-owned');
  assert.throws(
    () => request.validateHeaders({ Authorization: 'Bearer invalid\nvalue' }),
    client.RequestValidationError,
  );
});

type Invalid = readonly [string, unknown, string, RegExp];
const invalidDeclarations: readonly Invalid[] = [
  ['API key missing name', { type: 'apiKey', in: 'header' }, 'name', /string/],
  [
    'API key invalid location',
    { type: 'apiKey', in: 'body', name: 'key' },
    'in',
    /header.*query.*cookie/,
  ],
  [
    'API key malformed header',
    { type: 'apiKey', in: 'header', name: 'X-Key\n' },
    'name',
    /header/,
  ],
  [
    'API key cookie delimiter injection',
    { type: 'apiKey', in: 'cookie', name: 'key; other=value' },
    'name',
    /cookie/,
  ],
  [
    'API key malformed query Unicode',
    { type: 'apiKey', in: 'query', name: '\ud800' },
    'name',
    /Unicode/,
  ],
  [
    'unsupported HTTP authentication',
    { type: 'http', scheme: 'digest' },
    '',
    /basic.*bearer/,
  ],
  [
    'invalid bearer annotation',
    { type: 'http', scheme: 'bearer', bearerFormat: 42 },
    'bearerFormat',
    /string/,
  ],
  ['OAuth missing flows', { type: 'oauth2' }, 'flows', /object/],
  [
    'OAuth unknown flow',
    { type: 'oauth2', flows: { device: { tokenUrl: '/token', scopes: {} } } },
    'flows.device',
    /unsupported keyword/,
  ],
  [
    'OAuth missing authorization URL',
    { type: 'oauth2', flows: { implicit: { scopes: {} } } },
    'flows.implicit.authorizationUrl',
    /string/,
  ],
  [
    'OAuth missing token URL',
    {
      type: 'oauth2',
      flows: { authorizationCode: { authorizationUrl: '/auth', scopes: {} } },
    },
    'flows.authorizationCode.tokenUrl',
    /string/,
  ],
  [
    'OAuth malformed refresh URL',
    {
      type: 'oauth2',
      flows: {
        clientCredentials: {
          tokenUrl: '/token',
          refreshUrl: false,
          scopes: {},
        },
      },
    },
    'flows.clientCredentials.refreshUrl',
    /string/,
  ],
  [
    'OAuth missing scopes',
    { type: 'oauth2', flows: { password: { tokenUrl: '/token' } } },
    'flows.password.scopes',
    /object/,
  ],
  [
    'OAuth invalid scope description',
    {
      type: 'oauth2',
      flows: {
        clientCredentials: { tokenUrl: '/token', scopes: { read: false } },
      },
    },
    'flows.clientCredentials.scopes.read',
    /string/,
  ],
];
for (const [name, declaration, suffix, message] of invalidDeclarations) {
  void test(`unused security declarations reject ${name} before selection`, async () => {
    const input = document([], { Unused: declaration });
    const before = structuredClone(input);
    await assert.rejects(compile(input, selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(
        error.location,
        `components.securitySchemes.Unused${suffix ? `.${suffix}` : ''}`,
      );
      assert.match(error.message, message);
      return true;
    });
    assert.deepEqual(input, before);
  });
}

// Programmatic inputs can omit an own array entry; that is missing data.
const sparse: unknown[] = [];
sparse.length = 1;
for (const [name, security, suffix, message] of [
  ['undefined override', undefined, '', /array/],
  ['null override', null, '', /array/],
  ['sparse alternatives', sparse, '[0]', /object/],
  [
    'undeclared scheme after public branch',
    [{}, { Missing: [] }],
    '[1].Missing',
    /undeclared/,
  ],
  ['unknown OAuth scope', [{ OAuth: ['write'] }], '[0].OAuth', /scope/],
  ['non-string scope', [{ OAuth: [42] }], '[0].OAuth', /array/],
  ['sparse scopes', [{ OAuth: sparse }], '[0].OAuth', /array/],
  [
    'nonempty API-key roles',
    [{ QueryKey: ['editor'] }],
    '[0].QueryKey',
    /role|scope/,
  ],
  ['nonempty basic roles', [{ Basic: ['editor'] }], '[0].Basic', /role|scope/],
  [
    'nonempty bearer roles',
    [{ Session: ['editor'] }],
    '[0].Session',
    /role|scope/,
  ],
] as const) {
  void test(`unselected operations reject ${name} rather than hiding invalid security`, async () => {
    const input = document();
    Object.assign(input.paths['/internal'].get, { security });
    await assert.rejects(compile(input, selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, `paths./internal.get.security${suffix}`);
      assert.match(error.message, message);
      return true;
    });
  });
}

void test('OAuth flow extensions require explicit ignore entries while x-prefixed scope identities survive filtering', async () => {
  const input = document([{ OAuth: ['x-records:write'] }]);
  Object.assign(input.components.securitySchemes, {
    OAuth: {
      type: 'oauth2',
      flows: {
        clientCredentials: {
          tokenUrl: '/token',
          scopes: { 'x-records:write': 'Write records' },
          'x-note': 'Documentation only',
        },
      },
    },
  });
  await assert.rejects(compile(input, selection), /x-note/);
  const ignored = await compile(input, {
    ...selection,
    ignoreExtensions: ['x-note'],
  });
  const plain = document([{ OAuth: ['x-records:write'] }]);
  Object.assign(plain.components.securitySchemes, {
    OAuth: {
      type: 'oauth2',
      flows: {
        clientCredentials: {
          tokenUrl: '/token',
          scopes: { 'x-records:write': 'Write records' },
        },
      },
    },
  });
  assert.deepEqual(ignored, await compile(plain, selection));
});
