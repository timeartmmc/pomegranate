import assert from 'node:assert/strict';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { compile, ContractError, runProject } from '../dist/index.js';
import { invalidOptions } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import { temporary } from './helpers.ts';
import { infiniteFixture, infiniteSelection } from './infinite-fixture.ts';
import { queryFixture, querySelection } from './query-fixture.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

const selection = {
  clients: [],
  standalone: {
    value: { schema: '#/components/schemas/Value', usage: 'request' },
  },
} as const;
function document(Value: Schema, schemas: Record<string, Schema> = {}) {
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic compiler diagnostics', version: '1' },
    paths: {},
    components: { schemas: { ...schemas, Value } },
  };
}

void test('unsupported authentication schemes fail before inspecting scheme-specific fields', async () => {
  for (const scheme of [
    {
      type: 'openIdConnect',
      openIdConnectUrl:
        'https://auth.example.invalid/.well-known/openid-configuration',
    },
  ]) {
    const input = document({ type: 'string' });
    Object.assign(input.components, { securitySchemes: { Future: scheme } });
    await assert.rejects(compile(input, selection), {
      name: 'ContractError',
      location: 'components.securitySchemes.Future',
      message: `components.securitySchemes.Future: security scheme type "${scheme.type}" is not supported in this version`,
    });
  }
});

void test('an unrecognized security type is diagnosed before its siblings without implying equivalent authentication', async () => {
  const input = document({ type: 'string' });
  const scheme = { type: 'apikey', in: 'header', name: 'X-Key' };
  Object.assign(input.components, { securitySchemes: { Future: scheme } });
  await assert.rejects(compile(input, selection), {
    name: 'ContractError',
    location: 'components.securitySchemes.Future.type',
    message:
      'components.securitySchemes.Future.type: unrecognized security scheme type; recognized spellings are "http", "apiKey", "oauth2", "openIdConnect" and "mutualTLS"',
  });
  // Correcting the type spelling enables the declared API-key semantics.
  scheme.type = 'apiKey';
  await compile(input, selection);
});

void test('surface typo diagnostics list bounded declared choices and the listed selection compiles', async () => {
  const input = queryFixture();
  await assert.rejects(compile(input, { clients: ['consumr'] }), {
    name: 'ContractError',
    location: 'clients',
    message:
      'clients: undeclared surface "consumr"; declared surfaces: "consumer", "staff"',
  });
  await compile(input, { clients: ['consumer'] });
  const plain = document({ type: 'string' });
  await assert.rejects(
    compile(plain, { ...selection, clients: ['consumer'] }),
    {
      name: 'ContractError',
      location: 'clients',
      message:
        'clients: undeclared surface "consumer"; declared surfaces: (none)',
    },
  );
  await compile(plain, selection);
  const names = Array.from(
    { length: 10 },
    (_, index) => `surface${String(index).padStart(2, '0')}`,
  );
  const many = document({ type: 'string' });
  Object.assign(many.paths, {
    '/read': {
      get: {
        operationId: 'read',
        responses: { 204: { description: 'Empty' } },
      },
    },
  });
  const surfaces = Object.fromEntries(names.map((name) => [name, ['read']]));
  await assert.rejects(
    compile(many, { clients: ['missing'], surfaces }),
    (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, 'clients');
      for (const name of names.slice(0, 8))
        assert.ok(error.message.includes(JSON.stringify(name)));
      for (const name of names.slice(8))
        assert.equal(error.message.includes(JSON.stringify(name)), false);
      assert.match(error.message, /\.\.\. \(2 more\)$/);
      return true;
    },
  );
  await compile(many, { clients: [names[0]!], surfaces });
});

void test('oneOf advice points supported scalar and nullable alternatives to an anyOf spelling that compiles', async () => {
  for (const branches of [
    [{ type: 'string' }, { type: 'integer' }],
    [{ $ref: '#/components/schemas/Text' }, { type: 'null' }],
  ] satisfies Schema[][]) {
    const schemas = { Text: { type: 'string' } };
    await assert.rejects(
      compile(document({ oneOf: branches }, schemas), selection),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.equal(error.location, 'components.schemas.Value.discriminator');
        assert.match(
          error.message,
          /use anyOf for a non-null schema plus null, or string plus integer/,
        );
        assert.match(
          error.message,
          /tagged object alternatives require component references/,
        );
        return true;
      },
    );
    await compile(document({ anyOf: branches }, schemas), selection);
  }
});

void test('format advice does not suggest string registration for container or boolean schemas', async () => {
  for (const schema of [
    { type: 'boolean' },
    { type: 'array', items: { type: 'string' } },
    { type: 'object' },
  ])
    for (const format of ['unknown', 'date', 'custom'])
      await assert.rejects(
        compile(document({ ...schema, format }), {
          ...selection,
          formats: { custom: { type: 'string', pattern: '.*' } },
        }),
        {
          name: 'ContractError',
          location: 'components.schemas.Value.format',
          message: `components.schemas.Value.format: format is not supported on ${schema.type} schemas in this version`,
        },
      );
});

void test('3.0 nullable allOf requires an explicit type rather than changing the referenced type', async () => {
  const input = document(
    { nullable: true, allOf: [{ $ref: '#/components/schemas/Text' }] },
    { Text: { type: 'string' } },
  );
  input.openapi = '3.0.4';
  await assert.rejects(compile(input, selection), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, 'components.schemas.Value.nullable');
    assert.match(error.message, /nullable: true requires an explicit type/);
    return true;
  });
});

void test('3.0 nullable composition advice gives a supported outer anyOf spelling', async (t) => {
  const schemas: Record<string, Schema> = {
    Cat: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['cat'] } },
      required: ['kind'],
    },
    Dog: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['dog'] } },
      required: ['kind'],
    },
  };
  for (const [composition, sample] of [
    [{ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 7],
    [
      {
        oneOf: [ref('Cat'), ref('Dog')],
        discriminator: {
          propertyName: 'kind',
          mapping: { cat: ref('Cat').$ref, dog: ref('Dog').$ref },
        },
      },
      { kind: 'cat' },
    ],
  ] satisfies [Schema, unknown][]) {
    const input = document({ ...composition, nullable: true }, schemas);
    input.openapi = '3.0.4';
    await assert.rejects(compile(input, selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, 'components.schemas.Value.nullable');
      assert.match(error.message, /remove nullable/);
      assert.match(error.message, /outer anyOf/);
      assert.match(error.message, /null-only branch/);
      return true;
    });
    input.components.schemas.Value = {
      anyOf: [composition, { type: 'string', nullable: true, enum: [null] }],
    };
    const root = await generatedTestWorkspace(
      t,
      await compile(input, selection),
    );
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      'standalone.value.ts',
    );
    assert.equal(schema.parse(null), null);
    assert.deepEqual(schema.parse(sample), sample);
  }
});

void test('nesting advice distinguishes inline splitting from the structural limit', async () => {
  function arrays(count: number, leaf: Schema): Schema {
    let value = leaf;
    for (let index = 0; index < count; index++)
      value = { type: 'array', items: value };
    return value;
  }
  await assert.rejects(
    compile(document(arrays(40, { type: 'string' })), selection),
    (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(
        error.location,
        `components.schemas.Value${'.items'.repeat(32)}`,
      );
      assert.match(error.message, /use component references/);
      assert.match(error.message, /128-level structural limit/);
      return true;
    },
  );
  await compile(
    document(arrays(20, ref('Inner')), {
      Inner: arrays(20, { type: 'string' }),
    }),
    selection,
  );
  const schemas: Record<string, Schema> = { Layer0000: { type: 'string' } };
  for (let index = 1; index <= 128; index++)
    schemas[`Layer${String(index).padStart(4, '0')}`] = {
      type: 'array',
      items: ref(`Layer${String(index - 1).padStart(4, '0')}`),
    };
  await assert.rejects(
    compile(document(ref('Layer0128'), schemas), selection),
    (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, 'components.schemas.Layer0128');
      assert.match(
        error.message,
        /reduce structural nesting, including recursive regions and referenced schemas/,
      );
      assert.doesNotMatch(error.message, /use component references/);
      return true;
    },
  );
  delete schemas.Layer0128;
  await compile(document(ref('Layer0127'), schemas), selection);
});

void test('query selection distinguishes unknown IDs from operations outside the selected surface', async () => {
  const binding = infiniteSelection.infiniteQueries.consumer.listItems;
  for (const value of [
    {
      input: queryFixture(),
      options: { ...querySelection, queries: { consumer: ['missing'] } },
      location: 'queries.consumer.missing',
      expected:
        /unknown operationId "missing"; use an operationId declared in paths/,
      repaired: { ...querySelection, queries: { consumer: ['readItem'] } },
    },
    {
      input: queryFixture(),
      options: { ...querySelection, queries: { staff: ['readOutcome'] } },
      location: 'queries.staff.readOutcome',
      expected:
        /must belong to this client; include "readOutcome" in surface "staff" or select a client that includes it/,
      repaired: { ...querySelection, queries: { consumer: ['readOutcome'] } },
    },
    {
      input: infiniteFixture(),
      options: {
        ...infiniteSelection,
        infiniteQueries: { consumer: { missing: binding } },
      },
      location: 'infiniteQueries.consumer.missing',
      expected:
        /unknown operationId "missing"; use an operationId declared in paths/,
      repaired: infiniteSelection,
    },
    {
      input: infiniteFixture(),
      options: {
        ...infiniteSelection,
        infiniteQueries: { staff: { listItems: binding } },
      },
      location: 'infiniteQueries.staff.listItems',
      expected:
        /must belong to this client; include "listItems" in surface "staff" or select a client that includes it/,
      repaired: infiniteSelection,
    },
  ]) {
    await assert.rejects(compile(value.input, value.options), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, value.location);
      assert.match(error.message, value.expected);
      return true;
    });
    await compile(value.input, value.repaired);
  }
});

void test('configuration typo diagnostics name supported keys and corrected options retain read-only checks', async (t) => {
  const input = document({ type: 'string' });
  await assert.rejects(
    invalidOptions(compile, input, { ...selection, client: [] }),
    (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, 'compile options.client');
      assert.match(
        error.message,
        /unsupported keyword; supported keys:.*"clients"/,
      );
      return true;
    },
  );
  await compile(input, selection);
  const root = await temporary(t);
  const config = join(root, 'pom.json');
  await writeFile(join(root, 'contract.json'), JSON.stringify(input));
  const options = {
    version: 2,
    openapi: 'contract.json',
    output: 'generated',
    clients: [],
    standalon: selection.standalone,
  };
  await writeFile(config, JSON.stringify(options));
  await assert.rejects(runProject(config, { check: true }), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, `${config}.standalon`);
    assert.match(error.message, /supported keys:.*"standalone"/);
    return true;
  });
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: 'contract.json',
      output: 'generated',
      ...selection,
    }),
  );
  await assert.rejects(invalidOptions(runProject, config, { chek: true }), {
    name: 'ContractError',
    location: 'project options.chek',
    message:
      'project options.chek: unsupported keyword; supported keys: "check"',
  });
  assert.equal((await runProject(config, { check: true })).clean, false);
  await assert.rejects(stat(join(root, 'generated')), { code: 'ENOENT' });
});

void test('allOf diagnostics identify unsupported composition with and without an explicit type', async () => {
  for (const schema of [{ allOf: [] }, { type: 'string', allOf: [] }])
    await assert.rejects(compile(document(schema), selection), {
      name: 'ContractError',
      location: 'components.schemas.Value.allOf',
      message:
        'components.schemas.Value.allOf: expected a nonempty array of allOf branches',
    });
});

void test('branch annotation advice can be followed for referenced schemas', async () => {
  for (const annotation of ['readOnly', 'writeOnly']) {
    const branch: Schema = { type: 'string', [annotation]: true };
    const input = document(
      { anyOf: [{ $ref: '#/components/schemas/Text' }, { type: 'integer' }] },
      { Text: branch },
    );
    await assert.rejects(compile(input, selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, 'components.schemas.Value.anyOf[0]');
      assert.match(
        error.message,
        /remove the annotation from the branch or its referenced component/,
      );
      assert.match(error.message, /separate request and response schemas/);
      return true;
    });
    Reflect.deleteProperty(branch, annotation);
    await compile(input, selection);
  }
});

void test('pagination distinguishes an unsupported nested path from an optional field, while preserving literal dotted names', async () => {
  const input = infiniteFixture();
  const page = input.components.schemas.Page;
  Object.assign(page.properties, {
    data: {
      type: 'object',
      required: ['results'],
      properties: { results: page.properties.results },
    },
  });
  const options = {
    ...infiniteSelection,
    infiniteQueries: {
      consumer: {
        listItems: {
          ...infiniteSelection.infiniteQueries.consumer.listItems,
          items: 'data.results',
        },
      },
    },
  };
  await assert.rejects(compile(input, options), (error) => {
    assert.ok(error instanceof ContractError);
    assert.match(
      error.message,
      /"data.results" must name an existing top-level response property/,
    );
    assert.match(
      error.message,
      /nested paths are not supported in this version/,
    );
    return true;
  });
  Object.assign(page.properties, { 'data.results': page.properties.results });
  page.required.push('data.results');
  await compile(input, options);
});

void test('nullable diagnostic paths retain original declarations and explicit anyOf paths', async () => {
  const binary = { type: 'string', format: 'binary' };
  for (const [schema, suffix] of [
    [{ ...binary, type: ['string', 'null'] }, ''],
    [{ type: ['array', 'null'], items: binary }, '.items'],
    [{ anyOf: [binary, { type: 'null' }] }, '.anyOf[0]'],
  ] satisfies [Schema, string][])
    await assert.rejects(compile(document(schema), selection), {
      name: 'ContractError',
      location: `standalone.value.schema -> components.schemas.Value${suffix}`,
      message: `standalone.value.schema -> components.schemas.Value${suffix}: binary values are only supported in multipart request fields`,
    });
  const legacy = document({ ...binary, nullable: true });
  legacy.openapi = '3.0.4';
  await assert.rejects(compile(legacy, selection), {
    name: 'ContractError',
    location: 'standalone.value.schema -> components.schemas.Value',
  });
});
