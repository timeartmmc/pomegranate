import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { compile, ContractError, runProject } from '../dist/index.js';
import { buildDescriptor } from '../dist/descriptor.js';
import { present, record } from './assertions.ts';
import { fixture, preparation, temporary } from './helpers.ts';
import type { Fixture } from './helpers.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient } from './runtime-types.ts';

const selected = (document: unknown, clients = ['consumer']) =>
  compile(document, { clients });
const operation = (
  descriptor: ReturnType<typeof buildDescriptor>,
  id: string,
) => present(descriptor.operations.find((value) => value.id === id));

void test('bearer requirements retain distinct declared identities through inheritance and operation overrides', async (t) => {
  const document = fixture();
  Object.assign(document.components.securitySchemes, {
    ServiceToken: { type: 'http', scheme: 'bearer' },
  });
  Object.assign(document.paths['/api/staff/reports'].get, {
    security: [{ ServiceToken: [] }],
  });
  const descriptor = buildDescriptor(document);
  assert.deepEqual(operation(descriptor, 'prepareWidget').security, {
    transport: 'bearer',
    scheme: 'WidgetSession',
  });
  assert.deepEqual(operation(descriptor, 'getStaffReport').security, {
    transport: 'bearer',
    scheme: 'ServiceToken',
  });
  const before = await selected(document, ['consumer', 'staff']);
  const root = await generatedTestWorkspace(t, before);
  const consumer = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const staff = await importGenerated<RuntimeClient>(root, 'client.staff.ts');
  const inherited = present(consumer.operations.getWidget).build({
    path: { widgetId: 'synthetic' },
  });
  const overridden = present(staff.operations.getStaffReport).build();
  assert.deepEqual(
    { ...inherited.security },
    {
      transport: 'bearer',
      scheme: 'WidgetSession',
    },
  );
  assert.deepEqual(
    { ...overridden.security },
    {
      transport: 'bearer',
      scheme: 'ServiceToken',
    },
  );
  assert.ok(Object.isFrozen(inherited.security));
  assert.ok(Object.isFrozen(overridden.security));
  Object.assign(document, { security: [{ ServiceToken: [] }] });
  Object.assign(document.paths['/api/staff/reports'].get, {
    security: [{ WidgetSession: [] }],
  });
  assert.notDeepEqual(await selected(document, ['consumer', 'staff']), before);
});

void test('drift checking detects changing only the required bearer scheme', async (t) => {
  const document = fixture();
  Object.assign(document.components.securitySchemes, {
    OtherToken: { ...document.components.securitySchemes.WidgetSession },
  });
  const root = await temporary(t);
  const input = join(root, 'openapi.json');
  const config = join(root, 'pom.json');
  await writeFile(input, JSON.stringify(document));
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      clients: ['consumer'],
    }),
  );
  await runProject(config);
  assert.equal((await runProject(config, { check: true })).clean, true);
  Object.assign(preparation(document), { security: [{ OtherToken: [] }] });
  await writeFile(input, JSON.stringify(document));
  assert.equal((await runProject(config, { check: true })).clean, false);
});

void test('bearer schemes are interpreted by semantics, not their component names', () => {
  const document = fixture();
  Reflect.deleteProperty(document.components.securitySchemes, 'WidgetSession');
  Object.assign(document.components.securitySchemes, {
    'Completely.Different-Auth_1': {
      type: 'http',
      scheme: 'bEaReR',
      bearerFormat: 'Anything documentation-only',
    },
  });
  Object.assign(document, {
    security: [{ 'Completely.Different-Auth_1': [] }],
  });
  const descriptor = buildDescriptor(document);
  assert.equal(
    operation(descriptor, 'prepareWidget').policy.get('auth'),
    'session',
  );
  assert.deepEqual(operation(descriptor, 'prepareWidget').security, {
    transport: 'bearer',
    scheme: 'Completely.Different-Auth_1',
  });
  assert.equal(
    operation(descriptor, 'getStaffReport').policy.get('auth'),
    'partnerStaff',
  );
  assert.deepEqual(operation(descriptor, 'getStaffReport').security, {
    transport: 'bearer',
    scheme: 'Completely.Different-Auth_1',
  });
  assert.equal(
    operation(descriptor, 'checkHealth').policy.get('auth'),
    'public',
  );
  assert.deepEqual(operation(descriptor, 'checkHealth').security, {
    transport: 'none',
  });
  assert.equal(
    operation(descriptor, 'widgetOptions').policy.get('auth'),
    'public',
  );
  assert.deepEqual(operation(descriptor, 'widgetOptions').security, {
    transport: 'none',
  });
});

void test('absent document security and both explicit anonymous forms mean none', () => {
  for (const security of [undefined, [], [{}]]) {
    const document = fixture();
    if (security === undefined) Reflect.deleteProperty(document, 'security');
    else Object.assign(document, { security });
    for (const item of Object.values(document.paths))
      for (const value of Object.values(record(item)))
        record(record(value)['x-pom']).auth = 'public';
    assert.ok(
      buildDescriptor(document).operations.every(
        (value) => value.security.transport === 'none',
      ),
    );
    Object.assign(preparation(document), {
      security: [{ WidgetSession: [] }],
    });
    preparation(document)['x-pom'].auth = 'session';
    assert.equal(
      operation(buildDescriptor(document), 'prepareWidget').security.transport,
      'bearer',
    );
  }
});

const unsupported: [string, (d: Fixture) => void, RegExp][] = [
  [
    'bearer OR public',
    (d) => {
      Object.assign(preparation(d), {
        security: [{ WidgetSession: [] }, {}],
      });
    },
    /security alternatives \(OR\)/,
  ],
  [
    'two bearer alternatives',
    (d) => {
      Object.assign(d.components.securitySchemes, {
        Other: { type: 'http', scheme: 'bearer' },
      });
      Object.assign(preparation(d), {
        security: [{ WidgetSession: [] }, { Other: [] }],
      });
    },
    /security alternatives \(OR\)/,
  ],
  [
    'two required bearer schemes',
    (d) => {
      Object.assign(d.components.securitySchemes, {
        Other: { type: 'http', scheme: 'bearer' },
      });
      Object.assign(preparation(d), {
        security: [{ WidgetSession: [], Other: [] }],
      });
    },
    /combined security schemes \(AND\)/,
  ],
  [
    'nonempty bearer roles',
    (d) => {
      Object.assign(preparation(d), {
        security: [{ WidgetSession: ['editor'] }],
      });
    },
    /role requirements are unsupported/,
  ],
  [
    'malformed role list',
    (d) => {
      Object.assign(preparation(d), { security: [{ WidgetSession: [1] }] });
    },
    /array of role names/,
  ],
  [
    'null security override',
    (d) => {
      Object.assign(preparation(d), { security: null });
    },
    /array of security requirements/,
  ],
  [
    'undefined security override',
    (d) => {
      Object.assign(preparation(d), { security: undefined });
    },
    /array of security requirements/,
  ],
  [
    'null requirement',
    (d) => {
      Object.assign(preparation(d), { security: [null] });
    },
    /expected an object/,
  ],
  [
    'unknown scheme',
    (d) => {
      Object.assign(preparation(d), { security: [{ Missing: [] }] });
    },
    /undeclared bearer security scheme/,
  ],
  [
    'unused basic scheme',
    (d) => {
      Object.assign(d.components.securitySchemes, {
        Unused: { type: 'http', scheme: 'basic' },
      });
    },
    /unsupported security scheme/,
  ],
  [
    'unused API key scheme',
    (d) => {
      Object.assign(d.components.securitySchemes, {
        Unused: {
          type: 'apiKey',
          name: 'X-Key',
          in: 'header',
        },
      });
    },
    /security scheme type "apiKey" is not supported in this version/,
  ],
  [
    'missing security scheme reference',
    (d) => {
      Object.assign(d.components.securitySchemes, {
        WidgetSession: {
          $ref: '#/components/securitySchemes/Other',
        },
      });
    },
    /unresolved security scheme reference Other/,
  ],
  [
    'auth carrier mismatch',
    (d) => {
      preparation(d)['x-pom'].auth = 'public';
    },
    /requires none transport.*requires bearer/,
  ],
  [
    'anonymous override mismatch',
    (d) => {
      Object.assign(preparation(d), { security: [] });
    },
    /requires bearer transport.*requires none/,
  ],
  [
    'unknown auth transport',
    (d) => {
      d['x-pom-policy'].auth.session.transport = 'cookie';
    },
    /expected none or bearer/,
  ],
  [
    'legacy auth label array',
    (d) => {
      Object.assign(d['x-pom-policy'], { auth: ['public'] });
    },
    /expected an object/,
  ],
  [
    'empty operation surfaces',
    (d) => {
      preparation(d)['x-pom'].surfaces = [];
    },
    /nonempty array/,
  ],
  [
    'duplicate operation surfaces',
    (d) => {
      preparation(d)['x-pom'].surfaces = ['consumer', 'consumer'];
    },
    /duplicate label/,
  ],
  [
    'unknown operation surface',
    (d) => {
      preparation(d)['x-pom'].surfaces = ['unknown'];
    },
    /undeclared surface/,
  ],
  [
    'duplicate declared surfaces',
    (d) => {
      d['x-pom-policy'].surfaces.push('consumer');
    },
    /duplicate label/,
  ],
];

for (const [name, mutate, message] of unsupported) {
  void test(`rejects ${name} before projecting clients`, async () => {
    const document = fixture();
    mutate(document);
    await assert.rejects(selected(document), message);
  });
}

void test('unselected operations, unused schemas and overridden document security still validate', async () => {
  const document = fixture();
  Object.assign(document.paths['/api/staff/reports'].get, {
    security: [{ WidgetSession: ['staff'] }],
  });
  await assert.rejects(selected(document), /role requirements are unsupported/);
  Reflect.deleteProperty(document.paths['/api/staff/reports'].get, 'security');
  Object.assign(document.paths['/api/staff/reports'].get.responses, {
    default: {
      description: 'Unsupported status',
    },
  });
  await assert.rejects(selected(document), /exact numeric/);
  Reflect.deleteProperty(
    document.paths['/api/staff/reports'].get.responses,
    'default',
  );
  Object.assign(document.components.schemas.UnusedMessage.properties.message, {
    format: false,
  });
  await assert.rejects(selected(document), /format.*expected a string/);
  Reflect.deleteProperty(
    document.components.schemas.UnusedMessage.properties.message,
    'format',
  );
  for (const item of Object.values(document.paths))
    for (const value of Object.values(record(item))) {
      record(value).security = [];
      record(record(value)['x-pom']).auth = 'public';
    }
  Object.assign(document, { security: [{ WidgetSession: [] }, {}] });
  await assert.rejects(selected(document), /security alternatives/);
});

void test('client selections reject unknown, duplicate, empty and unsafe names', async () => {
  for (const clients of [
    [],
    ['consumer', 'consumer'],
    ['missing'],
    ['Consumer'],
    ['consumer.schemas'],
    ['../consumer'],
    ['consumer/staff'],
    ['a'.repeat(64)],
  ]) {
    await assert.rejects(
      selected(fixture(), clients),
      /nonempty array|duplicate label|undeclared surface|surface names must match/,
    );
  }
  const document = fixture();
  document['x-pom-policy'].surfaces.push('empty');
  await assert.rejects(selected(document, ['empty']), /has no operations/);
});

void test('surface length accepts 63 characters and rejects a declared 64-character name', async () => {
  const boundary = 'a'.repeat(63);
  const document = fixture();
  document['x-pom-policy'].surfaces.push(boundary);
  document.paths['/api/health'].head['x-pom'].surfaces.push(boundary);
  const files = await selected(document, [boundary]);
  assert.ok(Object.hasOwn(files, `client.${boundary}.ts`));
  const tooLong = `${boundary}a`;
  document['x-pom-policy'].surfaces.push(tooLong);
  document.paths['/api/health'].head['x-pom'].surfaces.push(tooLong);
  await assert.rejects(selected(document, [tooLong]), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, 'x-pom-policy.surfaces');
    assert.match(error.message, /surface names must match/);
    return true;
  });
});

void test('portable prefixed names cannot collide with helpers or module suffixes', async () => {
  const document = fixture();
  const names = ['runtime', 'consumer_operations', 'con', 'aux'];
  document['x-pom-policy'].surfaces.push(...names);
  document.paths['/api/health'].head['x-pom'].surfaces.push(...names);
  const files = await selected(document, ['consumer', ...names]);
  assert.equal(Object.keys(files).length, 3 + 3 * (1 + names.length));
  assert.equal(
    new Set(Object.keys(files).map((name) => name.toLowerCase())).size,
    Object.keys(files).length,
  );
  assert.ok(Object.hasOwn(files, 'runtime.ts'));
  assert.ok(Object.hasOwn(files, 'client.runtime.ts'));
  assert.ok(Object.hasOwn(files, 'client.consumer.operations.ts'));
  assert.ok(Object.hasOwn(files, 'client.consumer_operations.ts'));
});

void test('selecting one client emits no aggregate or other-client module', async () => {
  const files = await selected(fixture(), ['staff']);
  assert.deepEqual(
    Object.keys(files)
      .filter((name) => !name.startsWith('schema-types.'))
      .sort(),
    [
      'client.staff.operations.ts',
      'client.staff.schemas.ts',
      'client.staff.ts',
      'policy-types.ts',
      'runtime.ts',
    ],
  );
  assert.doesNotMatch(
    Object.values(files).join('\n'),
    /client\.consumer|PreparationInput|UnusedMessage/,
  );
});
