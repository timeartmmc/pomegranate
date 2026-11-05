import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { compile, ContractError, runProject } from '../dist/index.js';
import type { CompileOptions } from '../dist/index.js';
import { invalidOptions, record } from './assertions.ts';
import { fileSnapshot, temporary } from './helpers.ts';

const memberships = {
  consumer: ['listItems', 'updateItem'],
  staff: ['updateItem'],
  internal: ['internalReport'],
};

function plainFixture() {
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic surface selection', version: '1' },
    paths: {
      '/items': {
        get: {
          operationId: 'listItems',
          responses: {
            200: {
              description: 'Public item',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PublicItem' },
                },
              },
            },
          },
        },
        post: {
          operationId: 'updateItem',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SharedLabel' },
              },
            },
          },
          responses: { 204: { description: 'Updated' } },
        },
      },
      '/internal/report': {
        get: {
          operationId: 'internalReport',
          responses: {
            200: {
              description: 'Internal report',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SecretRecord' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        PublicItem: {
          type: 'object',
          properties: { label: { $ref: '#/components/schemas/SharedLabel' } },
          required: ['label'],
          additionalProperties: false,
        },
        SharedLabel: { type: 'string', minLength: 1 },
        SecretRecord: {
          type: 'object',
          properties: { secret: { type: 'string' } },
          required: ['secret'],
          additionalProperties: false,
        },
      },
    },
  };
}

function inlineFixture() {
  const document = plainFixture();
  Object.assign(document, {
    'x-pom-policy': { version: 3, surfaces: Object.keys(memberships) },
  });
  for (const item of Object.values(document.paths))
    for (const rawOperation of Object.values(item)) {
      const operation = record(rawOperation);
      Object.assign(operation, {
        'x-pom': {
          surfaces: Object.entries(memberships)
            .filter(([, ids]) => ids.includes(String(operation.operationId)))
            .map(([surface]) => surface),
        },
      });
    }
  return document;
}

const selection: CompileOptions = {
  clients: ['consumer', 'staff'],
  surfaces: memberships,
};

for (const [name, options] of [
  ['client', { clients: ['consumer'] }],
  [
    'standalone',
    {
      clients: [],
      standalone: {
        item: { schema: '#/components/schemas/PublicItem', usage: 'response' },
      },
    },
  ],
] satisfies [string, CompileOptions][]) {
  void test(`plain ${name} input names both membership options and both fixes work`, async () => {
    const document = plainFixture();
    const before = structuredClone(document);
    await assert.rejects(compile(document, options), (error) => {
      assert.ok(error instanceof ContractError);
      assert.match(error.message, /config "surfaces" map/);
      assert.match(error.message, /"x-pom-policy.surfaces"/);
      assert.match(error.message, /operation "x-pom.surfaces"/);
      return true;
    });
    assert.deepEqual(document, before);
    assert.deepEqual(
      await compile(document, { ...options, surfaces: memberships }),
      await compile(inlineFixture(), options),
    );
  });
}

void test('present malformed inline memberships keep their value diagnostic', async () => {
  for (const surfaces of [undefined, null, []]) {
    const document = inlineFixture();
    Object.assign(record(record(document.paths['/items'].get)['x-pom']), {
      surfaces,
    });
    await assert.rejects(
      compile(document, { clients: ['consumer'] }),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.equal(error.location, 'paths./items.get.x-pom.surfaces');
        assert.match(error.message, /expected a nonempty array/);
        return true;
      },
    );
  }
});

void test('explicit config memberships preserve inline output, overlap and input values', async () => {
  const document = plainFixture();
  const before = structuredClone({ document, selection });
  const actual = await compile(document, selection);
  assert.deepEqual(
    actual,
    await compile(inlineFixture(), { clients: ['consumer', 'staff'] }),
  );
  assert.deepEqual({ document, selection }, before);
  assert.match(actual['client.consumer.operations.ts'] ?? '', /listItems/);
  assert.match(actual['client.staff.operations.ts'] ?? '', /updateItem/);
  assert.doesNotMatch(actual['client.staff.operations.ts'] ?? '', /listItems/);
  assert.match(actual['client.consumer.schemas.ts'] ?? '', /SharedLabel/);
  assert.doesNotMatch(
    Object.values(actual).join('\n'),
    /SecretRecord|internalReport/,
  );
});

void test('config map and operation reference ordering preserve generated bytes', async () => {
  const reordered = Object.fromEntries(
    Object.entries(memberships)
      .reverse()
      .map(([name, ids]) => [name, [...ids].reverse()]),
  );
  assert.deepEqual(
    await compile(plainFixture(), { ...selection, surfaces: reordered }),
    await compile(plainFixture(), selection),
  );
});

const sparseIds = ['listItems', 'unused', 'updateItem'];
Reflect.deleteProperty(sparseIds, 1);
const invalidMemberships: [string, unknown][] = [
  ['explicit undefined', undefined],
  ['null', null],
  ['array', []],
  ['empty map', {}],
  ['empty member list', { ...memberships, consumer: [] }],
  [
    'duplicate operation ID',
    { ...memberships, consumer: ['listItems', 'listItems', 'updateItem'] },
  ],
  [
    'unknown ID on unselected surface',
    { ...memberships, internal: ['internalReport', 'missing'] },
  ],
  [
    'unassigned internal operation',
    { consumer: ['listItems', 'updateItem'], staff: ['updateItem'] },
  ],
  ['unsafe surface name', { ...memberships, '../escape': ['listItems'] }],
  ['sparse operation list', { ...memberships, consumer: sparseIds }],
];
for (const [name, surfaces] of invalidMemberships)
  void test(`config memberships reject ${name} before selection`, async () => {
    const document = plainFixture();
    const options = { ...selection, surfaces };
    const before = structuredClone({ document, options });
    await assert.rejects(
      invalidOptions(compile, document, options),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.match(error.location, /surfaces/);
        return true;
      },
    );
    assert.deepEqual({ document, options }, before);
  });

void test('config membership does not suppress unsupported unselected operations or schemas', async () => {
  const operationFailure = plainFixture();
  Object.assign(operationFailure.paths['/internal/report'].get.responses, {
    default: { description: 'Unsupported fallback' },
  });
  await assert.rejects(compile(operationFailure, selection), /exact numeric/);
  const schemaFailure = plainFixture();
  Object.assign(
    schemaFailure.components.schemas.SecretRecord.properties.secret,
    {
      format: false,
    },
  );
  await assert.rejects(
    compile(schemaFailure, selection),
    /format.*expected a string/,
  );
});

void test('valid inline and configured memberships cannot both own the document', async () => {
  await assert.rejects(compile(inlineFixture(), selection), {
    name: 'ContractError',
    location: 'x-pom-policy.surfaces',
    message:
      'x-pom-policy.surfaces: cannot combine inline and configured surface membership',
  });
});

for (const surfaces of [[], undefined]) {
  void test(`invalid inline surface vocabularies keep their value diagnostic ${surfaces === undefined ? 'with undefined' : 'with an empty array'}`, async () => {
    const document = plainFixture();
    Object.assign(document, { 'x-pom-policy': { version: 3, surfaces } });
    await assert.rejects(compile(document, selection), {
      name: 'ContractError',
      location: 'x-pom-policy.surfaces',
      message: 'x-pom-policy.surfaces: expected a nonempty array of labels',
    });
  });
  void test(`config memberships reject a present operation membership field ${surfaces === undefined ? 'with undefined' : 'with an empty array'}`, async () => {
    const document = plainFixture();
    Object.assign(document.paths['/items'].get, { 'x-pom': { surfaces } });
    await assert.rejects(compile(document, selection), {
      name: 'ContractError',
      location: 'paths./items.get.x-pom.surfaces',
      message:
        'paths./items.get.x-pom.surfaces: cannot combine inline and configured surface membership',
    });
  });
}

void test('empty inline metadata does not conflict with config membership ownership', async () => {
  const document = plainFixture();
  Object.assign(document.paths['/items'].get, { 'x-pom': {} });
  assert.deepEqual(
    await compile(document, selection),
    await compile(plainFixture(), selection),
  );
});

void test('project config and programmatic memberships agree and failures preserve output', async (t) => {
  const root = await temporary(t);
  const document = plainFixture();
  const input = join(root, 'openapi.json');
  const config = join(root, 'pom.json');
  const output = join(root, 'generated');
  const configuration = {
    version: 2,
    openapi: './openapi.json',
    output: './generated',
    ...selection,
  };
  await writeFile(input, JSON.stringify(document));
  await writeFile(config, JSON.stringify(configuration));
  await runProject(config);
  const expected = await compile(document, selection);
  for (const [name, source] of Object.entries(expected))
    assert.equal(await readFile(join(output, name), 'utf8'), source);
  const snapshot = await fileSnapshot(output);
  assert.equal((await runProject(config, { check: true })).clean, true);
  assert.deepEqual(await fileSnapshot(output), snapshot);
  for (const surfaces of [
    { ...memberships, internal: ['missing'] },
    { consumer: ['listItems', 'updateItem'] },
  ]) {
    await writeFile(config, JSON.stringify({ ...configuration, surfaces }));
    await assert.rejects(runProject(config));
    await assert.rejects(runProject(config, { check: true }));
    assert.deepEqual(await fileSnapshot(output), snapshot);
    assert.equal(await readFile(input, 'utf8'), JSON.stringify(document));
  }
});
