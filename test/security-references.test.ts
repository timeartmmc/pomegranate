import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { buildDescriptor } from '../dist/descriptor.js';
import { normalizeSecuritySchemes } from '../dist/security.js';
import { parseYaml } from '../dist/yaml.js';
import { present, record } from './assertions.ts';
import { fixture, preparation, temporary } from './helpers.ts';
import type { Fixture } from './helpers.ts';
import type { RuntimeClient } from './runtime-types.ts';

const prefix = '#/components/securitySchemes/';
const bearer = { type: 'http', scheme: 'bEaReR', bearerFormat: 'Annotation' };
const selection = { clients: ['consumer', 'staff'] };
function aliasFixture() {
  const document = fixture();
  Object.assign(document.components.securitySchemes, {
    WidgetSession: {
      $ref: `${prefix}SessionAlias`,
      description: 'Session alias',
    },
    SessionAlias: { $ref: `${prefix}Concrete.Session_1`, summary: 'Summary' },
    'Concrete.Session_1': bearer,
    OtherAlias: { $ref: `${prefix}Concrete.Session_1` },
  });
  return document;
}

void test('local bearer aliases retain exact generated output, input values and YAML interpretation', async () => {
  const document = aliasFixture();
  const before = structuredClone(document);
  const expanded = fixture();
  Object.assign(expanded.components.securitySchemes, {
    WidgetSession: bearer,
    SessionAlias: bearer,
    'Concrete.Session_1': bearer,
    OtherAlias: bearer,
  });
  const actual = await compile(document, selection);
  assert.deepEqual(actual, await compile(expanded, selection));
  assert.deepEqual(document, before);
  assert.deepEqual(
    await compile(parseYaml(stringify(document), 'aliases.yaml'), selection),
    actual,
  );
  assert.deepEqual(
    new Set(
      normalizeSecuritySchemes(document.components.securitySchemes).keys(),
    ),
    new Set([
      'WidgetSession',
      'SessionAlias',
      'Concrete.Session_1',
      'OtherAlias',
    ]),
  );
});

void test('aliases preserve inherited bearer security, public overrides and application auth labels', async (t) => {
  const document = aliasFixture();
  const outputs = await compile(document, selection);
  const root = await temporary(t);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries(outputs))
    await writeFile(join(root, name), source);
  const { operations } = (await import(
    pathToFileURL(join(root, 'client.consumer.ts')).href
  )) as RuntimeClient;
  const authenticated = present(operations.getWidget).build({
    path: { widgetId: 'synthetic' },
  });
  assert.deepEqual(
    { ...authenticated.security },
    {
      transport: 'bearer',
      scheme: 'WidgetSession',
    },
  );
  assert.equal(authenticated.policy.auth, 'session');
  for (const id of ['checkHealth', 'widgetOptions']) {
    const request = present(operations[id]).build();
    assert.deepEqual({ ...request.security }, { transport: 'none' });
    assert.equal(request.policy.auth, 'public');
    assert.ok(Object.isFrozen(request.security));
  }
  assert.ok(Object.isFrozen(authenticated.security));
  const before = await compile(document, selection);
  Object.assign(document, { security: [{ OtherAlias: [] }] });
  assert.notDeepEqual(await compile(document, selection), before);
  assert.deepEqual(
    present(
      buildDescriptor(document).operations.find(({ id }) => id === 'getWidget'),
    ).security,
    { transport: 'bearer', scheme: 'OtherAlias' },
  );
  const absent = aliasFixture();
  Reflect.deleteProperty(absent, 'security');
  for (const item of Object.values(absent.paths))
    for (const operation of Object.values(item))
      Object.assign(record(record(operation)['x-pom']), { auth: 'public' });
  Object.assign(preparation(absent), { security: [{ SessionAlias: [] }] });
  preparation(absent)['x-pom'].auth = 'session';
  const descriptor = buildDescriptor(absent);
  assert.deepEqual(
    present(descriptor.operations.find(({ id }) => id === 'prepareWidget'))
      .security,
    { transport: 'bearer', scheme: 'SessionAlias' },
  );
  assert.equal(
    present(descriptor.operations.find(({ id }) => id === 'getWidget')).security
      .transport,
    'none',
  );
});

const invalid: [string, (document: Fixture) => void, string, RegExp][] = [
  [
    'missing direct target',
    (document) => {
      Object.assign(document.components.securitySchemes, {
        WidgetSession: { $ref: `${prefix}Missing` },
      });
    },
    'WidgetSession.$ref',
    /unresolved security scheme reference/,
  ],
  [
    'missing target in unused alias',
    (document) => {
      Object.assign(document.components.securitySchemes, {
        Unused: { $ref: `${prefix}Missing` },
      });
    },
    'Unused.$ref',
    /unresolved security scheme reference/,
  ],
  [
    'self cycle',
    (document) => {
      Object.assign(document.components.securitySchemes, {
        WidgetSession: { $ref: `${prefix}WidgetSession` },
      });
    },
    'WidgetSession.$ref',
    /cyclic security scheme reference/,
  ],
  [
    'cycle in unused declarations',
    (document) => {
      Object.assign(document.components.securitySchemes, {
        A: { $ref: `${prefix}B` },
        B: { $ref: `${prefix}A` },
      });
    },
    'A.$ref',
    /cyclic security scheme reference/,
  ],
  [
    'remote reference',
    (document) => {
      Object.assign(document.components.securitySchemes, {
        WidgetSession: {
          $ref: 'https://example.invalid/openapi.json#/components/securitySchemes/Session',
        },
      });
    },
    'WidgetSession.$ref',
    /only local component security scheme references/,
  ],
  [
    'wrong local section',
    (document) => {
      Object.assign(document.components.securitySchemes, {
        WidgetSession: { $ref: '#/components/schemas/Widget' },
      });
    },
    'WidgetSession.$ref',
    /only local component security scheme references/,
  ],
  [
    'empty target',
    (document) => {
      Object.assign(document.components.securitySchemes, {
        WidgetSession: { $ref: prefix },
      });
    },
    'WidgetSession.$ref',
    /component security scheme names/,
  ],
  [
    'percent-encoded target',
    (document) => {
      Object.assign(document.components.securitySchemes, {
        WidgetSession: { $ref: `${prefix}%53essionAlias` },
      });
    },
    'WidgetSession.$ref',
    /component security scheme names/,
  ],
  [
    'nested target path',
    (document) => {
      Object.assign(document.components.securitySchemes, {
        WidgetSession: { $ref: `${prefix}SessionAlias/type` },
      });
    },
    'WidgetSession.$ref',
    /component security scheme names/,
  ],
  [
    'undefined reference',
    (document) => {
      Object.assign(document.components.securitySchemes, {
        WidgetSession: { $ref: undefined },
      });
    },
    'WidgetSession.$ref',
    /only local component security scheme references/,
  ],
  [
    'semantic sibling',
    (document) => {
      Object.assign(document.components.securitySchemes, {
        WidgetSession: { $ref: `${prefix}SessionAlias`, type: 'http' },
      });
    },
    'WidgetSession.type',
    /unsupported keyword/,
  ],
  [
    'invalid reference summary',
    (document) => {
      Object.assign(document.components.securitySchemes, {
        WidgetSession: { $ref: `${prefix}SessionAlias`, summary: false },
      });
    },
    'WidgetSession.summary',
    /expected a string/,
  ],
  [
    'unsupported HTTP target',
    (document) => {
      Object.assign(document.components.securitySchemes, {
        'Concrete.Session_1': { type: 'http', scheme: 'digest' },
      });
    },
    'Concrete.Session_1',
    /basic.*bearer/,
  ],
  [
    'terminal newline in component name',
    (document) => {
      Object.assign(document.components.securitySchemes, { 'Bad\n': bearer });
    },
    'Bad\n',
    /component security scheme names/,
  ],
];
for (const [name, change, location, message] of invalid)
  void test(`security aliases reject ${name} before selection at the original declaration`, async () => {
    const document = aliasFixture();
    change(document);
    const before = structuredClone(document);
    await assert.rejects(
      compile(document, { clients: ['consumer'] }),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.equal(error.location, `components.securitySchemes.${location}`);
        assert.match(error.message, message);
        return true;
      },
    );
    assert.deepEqual(document, before);
  });

void test('aliases keep unsupported role requirements and policy contradictions explicit', async () => {
  const roles = aliasFixture();
  Object.assign(preparation(roles), {
    security: [{ SessionAlias: ['editor'] }],
  });
  await assert.rejects(compile(roles, selection), /role requirements/);
  const document = aliasFixture();
  preparation(document)['x-pom'].auth = 'public';
  await assert.rejects(
    compile(document, selection),
    /requires none transport.*requires bearer/,
  );
});

void test('long forward alias chains resolve without recursive stack growth while preserving the named requirement', async () => {
  const document = fixture();
  const schemes = Object.fromEntries(
    Array.from({ length: 10000 }, (_, index) => [
      `Alias${index}`,
      {
        $ref: `${prefix}${index === 9999 ? 'WidgetSession' : `Alias${index + 1}`}`,
      },
    ]),
  );
  Object.assign(document.components.securitySchemes, schemes);
  Object.assign(document, { security: [{ Alias0: [] }] });
  const expanded = fixture();
  Object.assign(expanded.components.securitySchemes, {
    Alias0: expanded.components.securitySchemes.WidgetSession,
  });
  Object.assign(expanded, { security: [{ Alias0: [] }] });
  assert.deepEqual(
    await compile(document, selection),
    await compile(expanded, selection),
  );
});
