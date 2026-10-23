import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import { buildDescriptor } from '../dist/descriptor.js';
import { fixture, preparation } from './helpers.mjs';

const selected = (document, clients = ['consumer']) =>
  compile(document, { clients });
const operation = (descriptor, id) =>
  descriptor.operations.find((value) => value.id === id);

test('bearer schemes are interpreted by semantics, not their component names', () => {
  const document = fixture();
  delete document.components.securitySchemes.WidgetSession;
  document.components.securitySchemes['Completely.Different-Auth_1'] = {
    type: 'http',
    scheme: 'bEaReR',
    bearerFormat: 'Anything documentation-only',
  };
  document.security = [{ 'Completely.Different-Auth_1': [] }];
  const descriptor = buildDescriptor(document);
  assert.deepEqual(operation(descriptor, 'prepareWidget').policy.auth, {
    label: 'session',
    transport: 'bearer',
  });
  assert.deepEqual(operation(descriptor, 'getStaffReport').policy.auth, {
    label: 'partnerStaff',
    transport: 'bearer',
  });
  assert.deepEqual(operation(descriptor, 'checkHealth').policy.auth, {
    label: 'public',
    transport: 'none',
  });
  assert.deepEqual(operation(descriptor, 'widgetOptions').policy.auth, {
    label: 'public',
    transport: 'none',
  });
});

test('absent document security and both explicit anonymous forms mean none', () => {
  for (const security of [undefined, [], [{}]]) {
    const document = fixture();
    if (security === undefined) delete document.security;
    else document.security = security;
    for (const item of Object.values(document.paths))
      for (const value of Object.values(item)) value['x-pom'].auth = 'public';
    assert.ok(
      buildDescriptor(document).operations.every(
        (value) => value.policy.auth.transport === 'none',
      ),
    );
    preparation(document).security = [{ WidgetSession: [] }];
    preparation(document)['x-pom'].auth = 'session';
    assert.equal(
      operation(buildDescriptor(document), 'prepareWidget').policy.auth
        .transport,
      'bearer',
    );
  }
});

const unsupported = [
  [
    'bearer OR public',
    (d) => {
      preparation(d).security = [{ WidgetSession: [] }, {}];
    },
    /security alternatives \(OR\)/,
  ],
  [
    'two bearer alternatives',
    (d) => {
      d.components.securitySchemes.Other = { type: 'http', scheme: 'bearer' };
      preparation(d).security = [{ WidgetSession: [] }, { Other: [] }];
    },
    /security alternatives \(OR\)/,
  ],
  [
    'two required bearer schemes',
    (d) => {
      d.components.securitySchemes.Other = { type: 'http', scheme: 'bearer' };
      preparation(d).security = [{ WidgetSession: [], Other: [] }];
    },
    /combined security schemes \(AND\)/,
  ],
  [
    'nonempty bearer roles',
    (d) => {
      preparation(d).security = [{ WidgetSession: ['editor'] }];
    },
    /role requirements are unsupported/,
  ],
  [
    'malformed role list',
    (d) => {
      preparation(d).security = [{ WidgetSession: [1] }];
    },
    /array of role names/,
  ],
  [
    'null security override',
    (d) => {
      preparation(d).security = null;
    },
    /array of security requirements/,
  ],
  [
    'undefined security override',
    (d) => {
      preparation(d).security = undefined;
    },
    /array of security requirements/,
  ],
  [
    'null requirement',
    (d) => {
      preparation(d).security = [null];
    },
    /expected an object/,
  ],
  [
    'unknown scheme',
    (d) => {
      preparation(d).security = [{ Missing: [] }];
    },
    /undeclared bearer security scheme/,
  ],
  [
    'unused basic scheme',
    (d) => {
      d.components.securitySchemes.Unused = { type: 'http', scheme: 'basic' };
    },
    /unsupported security scheme/,
  ],
  [
    'unused API key scheme',
    (d) => {
      d.components.securitySchemes.Unused = {
        type: 'apiKey',
        name: 'X-Key',
        in: 'header',
      };
    },
    /unsupported keyword|unsupported security scheme/,
  ],
  [
    'security scheme reference',
    (d) => {
      d.components.securitySchemes.WidgetSession = {
        $ref: '#/components/securitySchemes/Other',
      };
    },
    /\$ref.*unsupported keyword/,
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
      preparation(d).security = [];
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
      d['x-pom-policy'].auth = ['public'];
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
  test(`rejects ${name} before projecting clients`, async () => {
    const document = fixture();
    mutate(document);
    await assert.rejects(selected(document), message);
  });
}

test('unselected operations, unused schemas and overridden document security still validate', async () => {
  const document = fixture();
  document.paths['/api/staff/reports'].get.security = [
    { WidgetSession: ['staff'] },
  ];
  await assert.rejects(selected(document), /role requirements are unsupported/);
  delete document.paths['/api/staff/reports'].get.security;
  document.paths['/api/staff/reports'].get.responses.default = {
    description: 'Unsupported status',
  };
  await assert.rejects(selected(document), /exact numeric/);
  delete document.paths['/api/staff/reports'].get.responses.default;
  document.components.schemas.UnusedMessage.properties.message.format = 'uuid';
  await assert.rejects(selected(document), /format.*unsupported keyword/);
  delete document.components.schemas.UnusedMessage.properties.message.format;
  for (const item of Object.values(document.paths))
    for (const value of Object.values(item)) {
      value.security = [];
      value['x-pom'].auth = 'public';
    }
  document.security = [{ WidgetSession: [] }, {}];
  await assert.rejects(selected(document), /security alternatives/);
});

test('client selections reject unknown, duplicate, empty and unsafe names', async () => {
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

test('portable prefixed names cannot collide with helpers or module suffixes', async () => {
  const document = fixture();
  const names = ['runtime', 'consumer_operations', 'con', 'aux'];
  document['x-pom-policy'].surfaces.push(...names);
  document.paths['/api/health'].head['x-pom'].surfaces.push(...names);
  const files = await selected(document, ['consumer', ...names]);
  assert.equal(Object.keys(files).length, 1 + 3 * (1 + names.length));
  assert.equal(
    new Set(Object.keys(files).map((name) => name.toLowerCase())).size,
    Object.keys(files).length,
  );
  assert.ok(Object.hasOwn(files, 'runtime.ts'));
  assert.ok(Object.hasOwn(files, 'client.runtime.ts'));
  assert.ok(Object.hasOwn(files, 'client.consumer.operations.ts'));
  assert.ok(Object.hasOwn(files, 'client.consumer_operations.ts'));
});

test('selecting one client emits no aggregate or other-client module', async () => {
  const files = await selected(fixture(), ['staff']);
  assert.deepEqual(Object.keys(files).sort(), [
    'client.staff.operations.ts',
    'client.staff.schemas.ts',
    'client.staff.ts',
    'runtime.ts',
  ]);
  assert.doesNotMatch(
    Object.values(files).join('\n'),
    /client\.consumer|PreparationInput|UnusedMessage/,
  );
});
