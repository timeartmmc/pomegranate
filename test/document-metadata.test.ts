import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { fixture, preparation } from './helpers.ts';
import type { Fixture } from './helpers.ts';
import { annotateDocument } from './metadata-fixture.ts';
import { record } from './assertions.ts';

const selection = { clients: ['consumer'] };
type Target = (document: Fixture) => object;
const docTargets: [string, Target, string][] = [
  ['document', (d) => d, 'OpenAPI.externalDocs'],
  [
    'operation',
    preparation,
    'paths./api/widgets/{widgetId}/preparations.post.externalDocs',
  ],
  [
    'schema',
    (d) => d.components.schemas.Widget,
    'components.schemas.Widget.externalDocs',
  ],
  [
    'schema reference',
    (d) => preparation(d).requestBody.content['application/json'].schema,
    'paths./api/widgets/{widgetId}/preparations.post.requestBody.content.application/json.schema.externalDocs',
  ],
  [
    'tag',
    (d) => {
      const tag = { name: 'synthetic' };
      Object.assign(d, { tags: [tag] });
      return tag;
    },
    'tags[0].externalDocs',
  ],
];

void test('document metadata preserves JSON/YAML output and application-owned paths', async () => {
  const original = fixture();
  const expected = await compile(original, selection);
  const document = annotateDocument(original);
  const before = structuredClone(document);
  assert.deepEqual(await compile(document, selection), expected);
  assert.deepEqual(
    await compile(parseYaml(stringify(document), 'document.yaml'), selection),
    expected,
  );
  assert.deepEqual(document, before);
  for (const servers of [
    [],
    [{ url: '/v1' }],
    [{ url: '' }],
    [{ url: 'https://example.invalid' }, { url: '../v2' }],
  ]) {
    Object.assign(document, { servers });
    assert.deepEqual(await compile(document, selection), expected);
  }
});

for (const [name, target, location] of docTargets) {
  void test(`${name} external documentation validates required fields and rejects unknown keys`, async () => {
    for (const [externalDocs, suffix] of [
      [null, ''],
      [[], ''],
      [{}, '.url'],
      [{ url: 1 }, '.url'],
      [{ url: '/docs', description: false }, '.description'],
      [{ url: '/docs', unknown: true }, '.unknown'],
    ] as const) {
      const document = fixture();
      Object.assign(target(document), { externalDocs });
      const before = structuredClone(document);
      await assert.rejects(compile(document, selection), (error) => {
        assert.ok(error instanceof ContractError);
        assert.equal(error.location, `${location}${suffix}`);
        return true;
      });
      assert.deepEqual(document, before);
    }
  });
}

const sparseServerEnum = ['v1', 'unused'];
Reflect.deleteProperty(sparseServerEnum, 1);
const invalidServers: [unknown, string][] = [
  [
    [{ url: '/', variables: { v: { default: 'v1', enum: sparseServerEnum } } }],
    'servers[0].variables.v.enum',
  ],
  [undefined, 'servers'],
  [null, 'servers'],
  [{}, 'servers'],
  [[null], 'servers[0]'],
  [[{}], 'servers[0].url'],
  [[{ url: 1 }], 'servers[0].url'],
  [[{ url: '/', description: false }], 'servers[0].description'],
  [[{ url: '/', extra: true }], 'servers[0].extra'],
  [[{ url: '/', variables: null }], 'servers[0].variables'],
  [[{ url: '/', variables: { v: {} } }], 'servers[0].variables.v.default'],
  [
    [{ url: '/', variables: { v: { default: 1 } } }],
    'servers[0].variables.v.default',
  ],
  [
    [{ url: '/', variables: { v: { default: '', enum: [] } } }],
    'servers[0].variables.v.enum',
  ],
  [
    [{ url: '/', variables: { v: { default: '', enum: ['v1', 1] } } }],
    'servers[0].variables.v.enum',
  ],
  [
    [{ url: '/', variables: { v: { default: 'v2', enum: ['v1'] } } }],
    'servers[0].variables.v.default',
  ],
  [
    [{ url: '/', variables: { v: { default: '', description: null } } }],
    'servers[0].variables.v.description',
  ],
  [
    [{ url: '/', variables: { v: { default: '', type: 'string' } } }],
    'servers[0].variables.v.type',
  ],
];
void test('all server declarations validate even when a later server would not be selected', async () => {
  for (const [servers, location] of invalidServers) {
    const document = fixture();
    Object.assign(document, { servers });
    await assert.rejects(compile(document, selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, location);
      return true;
    });
  }
  const document = fixture();
  Object.assign(document, { servers: [{ url: '/' }, { url: false }] });
  await assert.rejects(compile(document, selection), /servers\[1\].url/);
});

void test('contact and terms validate shapes while URI and email spelling remain annotation data', async () => {
  const expected = await compile(fixture(), selection);
  for (const contact of [
    {},
    { name: '', url: 'opaque documentation text', email: 'annotation' },
  ]) {
    const document = fixture();
    Object.assign(document.info, { contact, termsOfService: '' });
    assert.deepEqual(await compile(document, selection), expected);
  }
  for (const [info, location] of [
    [{ contact: null }, 'info.contact'],
    [{ contact: { name: 1 } }, 'info.contact.name'],
    [{ contact: { url: false } }, 'info.contact.url'],
    [{ contact: { email: [] } }, 'info.contact.email'],
    [{ contact: { unknown: '' } }, 'info.contact.unknown'],
    [{ termsOfService: null }, 'info.termsOfService'],
  ] as const) {
    const document = fixture();
    Object.assign(document.info, info);
    await assert.rejects(compile(document, selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, location);
      return true;
    });
  }
});

void test('metadata cannot hide unsupported server overrides, extensions or unused schemas', async () => {
  for (const [target, key, value, expected] of [
    [(d: Fixture) => d.paths['/api/health'], 'servers', [], /paths.*servers/],
    [
      (d: Fixture) => d.paths['/api/health'].head,
      'servers',
      [{ url: '/v2' }],
      /paths.*servers/,
    ],
    [preparation, 'callbacks', {}, /callbacks.*unsupported keyword/],
    [
      (d: Fixture) => d,
      'x-multi-segment',
      {},
      /x-multi-segment.*unsupported semantic extension/,
    ],
    [
      (d: Fixture) => d.components.schemas,
      'Unused',
      { type: 'string', externalDocs: { url: false } },
      /Unused.externalDocs.url/,
    ],
    [
      (d: Fixture) => record(preparation(d).parameters[0]),
      'externalDocs',
      { url: '/docs' },
      /parameters.*externalDocs.*unsupported keyword/,
    ],
  ] satisfies [Target, string, unknown, RegExp][]) {
    const document = annotateDocument(fixture());
    Object.assign(target(document), { [key]: value });
    await assert.rejects(compile(document, selection), expected);
  }
});
