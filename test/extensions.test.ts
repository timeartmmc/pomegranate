import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { invalidOptions, present, record } from './assertions.ts';
import {
  extensionFixture,
  extensionKeywordTargets,
  extensionSelection,
  verifyExtensionData,
} from './extension-fixture.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';

const selection = { ...extensionSelection, ignoreExtensions: ['x-note'] };
const targets = extensionKeywordTargets(extensionFixture()).map(
  ({ location }) => location,
);
let baseline: Readonly<Record<string, string>>;
before(async () => {
  baseline = Object.freeze(
    await compile(extensionFixture(), extensionSelection),
  );
});

for (const location of targets)
  void test(`extension allowlist removes only the keyword at ${location}`, async () => {
    const document = extensionFixture();
    const target = present(
      extensionKeywordTargets(document).find(
        (target) => target.location === location,
      ),
    );
    target.value['x-note'] = { type: 'unknown', 'x-pom': { auth: 'unknown' } };
    const before = structuredClone(document);
    assert.deepEqual(await compile(document, selection), baseline);
    assert.deepEqual(document, before);
    for (const options of [
      extensionSelection,
      { ...extensionSelection, ignoreExtensions: [] },
    ])
      await assert.rejects(compile(document, options), (error) => {
        assert.ok(error instanceof ContractError);
        assert.equal(error.location, `${location}.x-note`);
        assert.match(error.message, /unsupported keyword.*ignoreExtensions/);
        return true;
      });
  });

void test('all ignored keyword sites retain exact output, data names, and YAML interpretation together', async () => {
  const document = extensionFixture();
  for (const { value } of extensionKeywordTargets(document))
    value['x-note'] = { 'x-note': ['opaque'], schema: { type: 'unsupported' } };
  const before = structuredClone(document);
  assert.deepEqual(await compile(document, selection), baseline);
  assert.deepEqual(document, before);
  assert.deepEqual(
    await compile(parseYaml(stringify(document), 'extensions.yaml'), selection),
    baseline,
  );
});

void test('schema reference allOf siblings filter nested extensions in OpenAPI 3.1', async () => {
  const branch = {
    type: 'object',
    properties: { label: { type: 'string' } },
    required: ['label'],
  };
  const document = {
    openapi: '3.1.2',
    info: { title: 'Synthetic reference composition', version: '1' },
    paths: {},
    components: {
      schemas: {
        Base: {
          type: 'object',
          properties: { id: { type: 'integer' } },
          required: ['id'],
        },
        Combined: {
          $ref: '#/components/schemas/Base',
          allOf: [branch],
        },
      },
    },
  };
  const options = {
    clients: [],
    standalone: {
      combined: { schema: '#/components/schemas/Combined', usage: 'request' },
    },
  } as const;
  const expected = await compile(document, options);
  for (const [target, path] of [
    [branch, 'components.schemas.Combined.allOf[0]'],
    [
      branch.properties.label,
      'components.schemas.Combined.allOf[0].properties.label',
    ],
  ] as const) {
    const value = record(target);
    value['x-note'] = 'documentation';
    const before = structuredClone(document);
    const allowed = { ...options, ignoreExtensions: ['x-note'] };
    assert.deepEqual(await compile(document, allowed), expected);
    assert.deepEqual(
      await compile(
        parseYaml(stringify(document), 'reference-allof.yaml'),
        allowed,
      ),
      expected,
    );
    assert.deepEqual(document, before);
    await assert.rejects(compile(document, options), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, `${path}.x-note`);
      assert.match(error.message, /unsupported keyword.*ignoreExtensions/);
      return true;
    });
    delete value['x-note'];
  }
  await assert.rejects(compile({ ...document, openapi: '3.0.4' }, options), {
    name: 'ContractError',
    location: 'components.schemas.Combined.allOf',
  });
});

void test('ignored keywords leave application property, query, header, policy and response data intact', async (t) => {
  const document = extensionFixture();
  for (const { value } of extensionKeywordTargets(document))
    value['x-note'] = true;
  const root = await generatedTestWorkspace(
    t,
    await compile(document, selection),
  );
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  verifyExtensionData(client);
});

void test('unlisted names and case variants remain strict during simultaneous compilations', async () => {
  const document = extensionFixture();
  Object.assign(document.info, { 'x-note': true });
  const options = { ...extensionSelection, ignoreExtensions: ['x-note'] };
  const runs = await Promise.allSettled([
    compile(document, options),
    compile(document, extensionSelection),
    compile(document, { ...extensionSelection, ignoreExtensions: ['x-other'] }),
    compile(document, options),
  ]);
  assert.equal(runs[0].status, 'fulfilled');
  assert.equal(runs[3].status, 'fulfilled');
  for (const result of [runs[1], runs[2]]) {
    assert.ok(result?.status === 'rejected');
    assert.match(String(result.reason), /info.x-note.*ignoreExtensions/);
  }
  Object.assign(document.info, { 'x-Note': false });
  await assert.rejects(
    compile(document, options),
    /info.x-Note.*ignoreExtensions/,
  );
});

void test('extension payloads are skipped without reading or validating their contents', async () => {
  const document = extensionFixture();
  Object.defineProperty(document.info, 'x-note', {
    enumerable: true,
    get() {
      throw new Error('ignored extension payload was read');
    },
  });
  assert.deepEqual(await compile(document, selection), baseline);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  Object.assign(document.components.schemas.Identifier, { 'x-note': cyclic });
  assert.deepEqual(await compile(document, selection), baseline);
});

void test('opaque annotation values retain extension-like keys and existing JSON validation', async () => {
  const document = extensionFixture();
  const opaque = { 'x-note': { 'x-note': true }, type: 'unsupported' };
  Object.assign(document.components.schemas.Identifier, {
    example: opaque,
    examples: [opaque],
  });
  Object.assign(document.components.schemas.RequestPayload, {
    default: opaque,
  });
  Object.assign(document.components.examples['x-note'], { value: opaque });
  assert.deepEqual(
    await compile(document, selection),
    await compile(document, extensionSelection),
  );
  const cyclic: Record<string, unknown> = {};
  cyclic['x-note'] = cyclic;
  Object.assign(document.components.examples['x-note'], { value: cyclic });
  await assert.rejects(
    compile(document, selection),
    /annotation must be JSON without cycles/,
  );
});

void test('one shared object can remain payload data while its schema occurrence is filtered', async () => {
  const document = extensionFixture();
  const shared = { type: 'string', 'x-note': 'preserved as example data' };
  Object.assign(document.components.schemas, { Shared: shared });
  Object.assign(document.components.examples['x-note'], { value: shared });
  const expected = extensionFixture();
  Object.assign(expected.components.schemas, { Shared: { type: 'string' } });
  Object.assign(expected.components.examples['x-note'], { value: shared });
  assert.deepEqual(
    await compile(document, selection),
    await compile(expected, extensionSelection),
  );
  assert.equal(shared['x-note'], 'preserved as example data');
  const invalid = extensionFixture();
  const sharedInvalid = { type: 'string', 'x-note': undefined };
  Object.assign(invalid.components.schemas, { Shared: sharedInvalid });
  Object.assign(invalid.components.examples['x-note'], {
    value: sharedInvalid,
  });
  await assert.rejects(
    compile(invalid, selection),
    /components.examples.x-note.value.*expected an object/,
  );
});

void test('shared schema and properties-map objects retain context-specific extension handling, including YAML aliases', async (t) => {
  const shared = { 'x-note': { type: 'string' } };
  const document = {
    openapi: '3.1.2',
    info: { title: 'Synthetic shared extension contexts', version: '1' },
    paths: {},
    components: {
      schemas: {
        Annotated: shared,
        Payload: { type: 'object', properties: shared },
      },
    },
  };
  for (const input of [
    document,
    parseYaml(stringify(document), 'shared-contexts.yaml'),
  ]) {
    const root = await generatedTestWorkspace(
      t,
      await compile(input, {
        clients: [],
        ignoreExtensions: ['x-note'],
        standalone: {
          payload: {
            schema: '#/components/schemas/Payload',
            usage: 'request',
          },
        },
      }),
    );
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      'standalone.payload.ts',
    );
    assert.deepEqual(schema.parse({ 'x-note': 'text' }), { 'x-note': 'text' });
    assert.equal(schema.safeParse({ 'x-note': 1 }).success, false);
    assert.deepEqual(schema.parse({}), {});
  }
});

void test('allowlisting cannot remove POM policy declarations or custom field values', async () => {
  const document = extensionFixture();
  assert.deepEqual(await compile(document, selection), baseline);
  Object.assign(document['x-pom-policy'], { 'x-note': true });
  await assert.rejects(
    compile(document, selection),
    /x-pom-policy.x-note.*unsupported keyword/,
  );
});

void test('multi-segment path semantics cannot be ignored on inline parameters, components or aliases', async () => {
  const sites = [
    {
      location: 'paths./echo/{id}.parameters[0].x-multi-segment',
      parameter: (document: ReturnType<typeof extensionFixture>) => {
        const parameter = {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        };
        Object.assign(document.paths['/echo/{id}'], {
          parameters: [parameter],
        });
        return parameter;
      },
    },
    {
      location: 'components.parameters.Id.x-multi-segment',
      parameter: (document: ReturnType<typeof extensionFixture>) =>
        document.components.parameters.Id,
    },
    {
      location: 'components.parameters.IdAlias.x-multi-segment',
      parameter: (document: ReturnType<typeof extensionFixture>) =>
        document.components.parameters.IdAlias,
    },
  ];
  for (const { location, parameter } of sites)
    for (const value of [true, false]) {
      const document = extensionFixture();
      Object.assign(parameter(document), { 'x-multi-segment': value });
      const before = structuredClone(document);
      for (const options of [
        extensionSelection,
        { ...extensionSelection, ignoreExtensions: ['x-multi-segment'] },
      ])
        await assert.rejects(compile(document, options), (error) => {
          assert.ok(error instanceof ContractError);
          assert.equal(error.location, location);
          assert.match(
            error.message,
            /unsupported semantic extension.*cannot be ignored/,
          );
          return true;
        });
      assert.deepEqual(document, before);
    }
});

void test('a semantic extension name remains valid as schema, property and payload data', async (t) => {
  const document = extensionFixture();
  Object.assign(document.components.schemas, {
    'x-multi-segment': { type: 'boolean', const: true },
  });
  for (const schema of [
    document.components.schemas['x-note'],
    document.components.schemas.RequestPayload,
  ]) {
    Object.assign(schema.properties, {
      'x-multi-segment': { $ref: '#/components/schemas/x-multi-segment' },
    });
    schema.required.push('x-multi-segment');
  }
  Object.assign(document.components.examples['x-note'].value, {
    'x-multi-segment': true,
  });
  const root = await generatedTestWorkspace(
    t,
    await compile(document, {
      ...extensionSelection,
      ignoreExtensions: ['x-multi-segment'],
    }),
  );
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const echo = present(client.operations.echo);
  const body = { 'x-note': 'kept', 'x-multi-segment': true };
  const request = echo.build({ path: { id: 'data' }, body });
  assert.deepEqual(request.body, body);
  const result = request.parseResponse({
    status: 200,
    headers: { 'content-type': 'application/json', 'x-note': 'response' },
    body: JSON.stringify(body),
  });
  assert.equal(result.kind, 'success');
  assert.deepEqual(result.data, body);
  assert.throws(
    () => echo.build({ path: { id: 'data' }, body: { 'x-note': 'kept' } }),
    client.RequestValidationError,
  );
});

void test('unsupported standard semantics and invalid unused declarations still fail', async () => {
  const document = extensionFixture();
  Object.assign(document.components.schemas.Identifier, {
    'x-note': true,
    allOf: [],
  });
  await assert.rejects(
    compile(document, selection),
    /Identifier.allOf.*expected a nonempty array/,
  );
  const unused = extensionFixture();
  Object.assign(unused.components.parameters, {
    Unused: {
      name: 'invalid',
      in: 'query',
      schema: { type: 'object' },
      'x-note': true,
    },
  });
  await assert.rejects(
    compile(unused, selection),
    /components.parameters.Unused.schema.*primitive/,
  );
});

void test('filtering preserves malformed structural values for their owning diagnostics', async () => {
  for (const info of [null, [], true, new Date('2020-01-01T00:00:00Z')]) {
    const document = extensionFixture();
    Object.assign(document, { info });
    const original = await compile(document, extensionSelection).catch(
      (error: unknown) => error,
    );
    assert.ok(original instanceof ContractError);
    await assert.rejects(compile(document, selection), {
      name: original.name,
      message: original.message,
    });
  }
  const cyclic = extensionFixture();
  const schema: Record<string, unknown> = { type: 'array' };
  schema.items = schema;
  Object.assign(cyclic.components.schemas, { Cyclic: schema });
  await assert.rejects(
    compile(cyclic, selection),
    /schema nesting exceeds the supported/,
  );
});

for (const [name, value] of [
  ['null', null],
  ['boolean', false],
  ['string', 'x-note'],
  ['object', {}],
  ['undefined member', [undefined]],
  ['null member', [null]],
  ['numeric member', [1]],
  ['empty name', ['']],
  ['missing x- prefix', ['note']],
  ['empty suffix', ['x-']],
  ['star wildcard', ['x-*']],
  ['question wildcard', ['x-no?e']],
  ['bracket wildcard', ['x-[note]']],
  ['brace wildcard', ['x-{note}']],
  ['duplicate name', ['x-note', 'x-note']],
  ['protected operation metadata', ['x-pom']],
  ['protected policy vocabulary', ['x-pom-policy']],
] satisfies [string, unknown][])
  void test(`invalid ignoreExtensions option rejects ${name}`, async () => {
    await assert.rejects(
      invalidOptions(compile, extensionFixture(), {
        ...extensionSelection,
        ignoreExtensions: value,
      }),
      { name: 'ContractError', message: /ignoreExtensions/ },
    );
  });

void test('an omitted, undefined or empty allowlist preserves strict baseline output', async () => {
  assert.deepEqual(
    await compile(extensionFixture(), {
      ...extensionSelection,
      ignoreExtensions: [],
    }),
    baseline,
  );
  assert.deepEqual(
    await invalidOptions(compile, extensionFixture(), {
      ...extensionSelection,
      ignoreExtensions: undefined,
    }),
    baseline,
  );
});

void test('configuration shares the allowlist boundary and failed generation/checks preserve owned files', async (t) => {
  const root = await temporary(t);
  const input = join(root, 'openapi.yaml');
  const configFile = join(root, 'pom.json');
  const output = join(root, 'generated');
  const document = extensionFixture();
  for (const { value } of extensionKeywordTargets(document))
    value['x-note'] = true;
  const source = stringify(document);
  const config = {
    version: 2,
    openapi: './openapi.yaml',
    output: './generated',
    ...selection,
  };
  await writeFile(input, source);
  await writeFile(configFile, JSON.stringify(config));
  await runProject(configFile);
  const snapshot = await fileSnapshot(output);
  assert.equal((await runProject(configFile, { check: true })).clean, true);
  for (const ignoreExtensions of [[], ['x-other'], ['x-*'], ['x-pom'], null]) {
    await writeFile(
      configFile,
      JSON.stringify({ ...config, ignoreExtensions }),
    );
    await assert.rejects(runProject(configFile), {
      name: 'ContractError',
      message: /ignoreExtensions/,
    });
    await assert.rejects(runProject(configFile, { check: true }), {
      name: 'ContractError',
      message: /ignoreExtensions/,
    });
    assert.deepEqual(await fileSnapshot(output), snapshot);
    assert.equal(await readFile(input, 'utf8'), source);
  }
  for (const failure of ['unlisted', 'semantic', 'version']) {
    const invalid = structuredClone(document);
    let ignoreExtensions = config.ignoreExtensions;
    let message: RegExp;
    if (failure === 'unlisted') {
      Object.assign(record(invalid.info), { 'x-other': true });
      message = /x-other.*ignoreExtensions/;
    } else if (failure === 'semantic') {
      Object.assign(invalid.components.parameters.Id, {
        'x-multi-segment': true,
      });
      ignoreExtensions = ['x-note', 'x-multi-segment'];
      message = /components.parameters.Id.x-multi-segment.*cannot be ignored/;
    } else {
      invalid.openapi = '3.2.0';
      Object.assign(invalid.info, { 'x-multi-segment': true });
      message = /^openapi: expected an OpenAPI 3\.0\.x or 3\.1\.x version/;
    }
    await writeFile(
      configFile,
      JSON.stringify({ ...config, ignoreExtensions }),
    );
    const invalidSource = stringify(invalid);
    await writeFile(input, invalidSource);
    for (const check of [false, true])
      await assert.rejects(runProject(configFile, { check }), {
        name: 'ContractError',
        message,
      });
    assert.deepEqual(await fileSnapshot(output), snapshot);
    assert.equal(await readFile(input, 'utf8'), invalidSource);
  }
});
