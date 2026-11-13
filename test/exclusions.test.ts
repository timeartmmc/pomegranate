import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import {
  commandFailure,
  invalidOptions,
  json,
  present,
  record,
} from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

const exec = promisify(execFile);
const reusable = (section: string, name: string) => ({
  $ref: `#/components/${section}/${name}`,
});
const options = {
  clients: ['consumer'],
  surfaces: { consumer: ['keep', 'drop'] },
  excludeOperations: ['drop'],
} as const;

function fixture(openapi = '3.1.2', privateParts = true) {
  const schemas: Record<string, Schema> = {
    Public: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 2 } },
      required: ['id'],
    },
  };
  const components = {
    schemas,
    parameters: {
      Shared: { name: 'cursor', in: 'query', schema: { type: 'string' } },
    } as Record<string, unknown>,
    responses: {} as Record<string, unknown>,
    requestBodies: {} as Record<string, unknown>,
    headers: {} as Record<string, unknown>,
    examples: {} as Record<string, unknown>,
    links: {} as Record<string, unknown>,
    securitySchemes: {} as Record<string, unknown>,
  };
  const paths: Record<string, Record<string, unknown>> = {
    '/records': {
      parameters: [reusable('parameters', 'Shared')],
      get: {
        operationId: 'keep',
        responses: {
          200: {
            description: 'Record',
            content: { 'application/json': { schema: ref('Public') } },
          },
        },
      },
    },
  };
  if (privateParts) {
    Object.assign(schemas, {
      PrivateValue: { type: 'string', minimum: 1 },
      PrivateAlias: ref('PrivateValue'),
      PrivateValid: { type: 'string', minLength: 1 },
      PrivateCycleA: {
        type: 'object',
        properties: { next: ref('PrivateCycleB') },
      },
      PrivateCycleB: {
        type: 'object',
        properties: { next: ref('PrivateCycleA') },
      },
    });
    Object.assign(components.parameters, {
      PrivateParameter: {
        name: 'x-private',
        in: 'header',
        schema: ref('PrivateValid'),
      },
      PrivateAlias: reusable('parameters', 'PrivateParameter'),
    });
    Object.assign(components.requestBodies, {
      PrivateBody: {
        content: {
          'application/xml': {
            schema: {
              anyOf: [
                ref('PrivateAlias'),
                ref('PrivateValid'),
                ref('PrivateCycleA'),
              ],
            },
          },
        },
      },
    });
    Object.assign(components.headers, {
      PrivateHeader: { schema: ref('PrivateValid') },
    });
    Object.assign(components.examples, {
      PrivateExample: { value: { example: true } },
      PrivateAlias: reusable('examples', 'PrivateExample'),
    });
    Object.assign(components.links, {
      PrivateLink: { operationId: 'keep' },
      PrivateAlias: reusable('links', 'PrivateLink'),
    });
    Object.assign(components.responses, {
      PrivateResponse: {
        description: 'Private',
        content: {
          'application/xml': {
            schema: ref('PrivateAlias'),
            examples: { value: reusable('examples', 'PrivateAlias') },
          },
        },
        headers: { 'X-Private': reusable('headers', 'PrivateHeader') },
        links: { next: reusable('links', 'PrivateAlias') },
      },
      PrivateAlias: reusable('responses', 'PrivateResponse'),
    });
    Object.assign(components.securitySchemes, {
      PrivateAuth: {
        type: 'openIdConnect',
        openIdConnectUrl: 'https://example.invalid/auth',
      },
      PrivateAlias: reusable('securitySchemes', 'PrivateAuth'),
    });
    present(paths['/records']).post = {
      operationId: 'drop',
      'x-private-export': true,
      parameters: [reusable('parameters', 'PrivateAlias')],
      requestBody: reusable('requestBodies', 'PrivateBody'),
      responses: { 200: reusable('responses', 'PrivateAlias') },
      security: [{ PrivateAlias: [] }],
    };
  }
  return {
    openapi,
    info: { title: 'Synthetic endpoint exclusions', version: '1' },
    paths,
    components,
  };
}

void test('exclusions filter before extension/dialect validation and prune exclusive component closures', async (t) => {
  for (const openapi of ['3.0.4', '3.1.2']) {
    const source = fixture(openapi);
    const before = structuredClone(source);
    const files = await compile(source, options);
    assert.deepEqual(
      files,
      await compile(fixture(openapi, false), {
        clients: ['consumer'],
        surfaces: { consumer: ['keep'] },
      }),
    );
    assert.deepEqual(
      await compile(parseYaml(stringify(source), 'exclusions.yaml'), options),
      files,
    );
    assert.deepEqual(source, before);
    const root = await generatedTestWorkspace(t, files);
    const client = await importGenerated<RuntimeClient>(
      root,
      'client.consumer.ts',
    );
    assert.deepEqual(Object.keys(client.operations), ['keep']);
    const operation = present(client.operations.keep);
    assert.equal(operation.build().url, '/records');
    const parsed = operation.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '{"id":"valid","extra":true}',
    });
    assert.equal(parsed.kind, 'success');
    if (parsed.kind === 'success')
      assert.deepEqual(parsed.data, { id: 'valid' });
    assert.equal(
      operation.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: '{"id":"x"}',
      }).kind,
      'protocol',
    );
    await assert.rejects(
      compile(source, {
        clients: ['consumer'],
        surfaces: { consumer: ['keep', 'drop'] },
      }),
      ContractError,
    );
  }
});

void test('unknown, duplicate, malformed and ambiguous operation exclusions fail explicitly', async () => {
  const source = fixture();
  for (const excludeOperations of [
    'drop',
    null,
    [1],
    [''],
    ['drop', 'drop'],
    ['missing'],
    ['DROP'],
  ]) {
    await assert.rejects(
      invalidOptions(compile, source, { ...options, excludeOperations }),
      /excludeOperations/,
    );
  }
  const sparse: string[] = [];
  sparse.length = 1;
  await assert.rejects(
    compile(source, { ...options, excludeOperations: sparse }),
    /excludeOperations/,
  );
  await assert.rejects(
    compile(source, {
      ...options,
      surfaces: { consumer: ['keep', 'drop', 'typo'] },
    }),
    /surfaces.consumer\[2\].*unknown operation identifier/,
  );
  await assert.rejects(
    compile(source, { ...options, queries: { consumer: ['drop'] } }),
    /unknown operationId "drop"/,
  );
  source.paths['/duplicate'] = { get: { operationId: 'drop' } };
  await assert.rejects(
    compile(source, options),
    /duplicate operation identifier "drop"/,
  );
});

void test('exclusions stay explicit in read-only manifest drift even when selected modules are identical', async (t) => {
  const root = await temporary(t);
  const source = fixture();
  source.paths['/extra'] = {
    get: {
      ...record(present(source.paths['/records']).get),
      operationId: 'extra',
    },
  };
  const settings = {
    version: 2,
    openapi: './openapi.json',
    output: './generated',
    ...options,
    surfaces: { consumer: ['keep', 'drop'], staff: ['extra'] },
  };
  const config = join(root, 'pom.json');
  await writeFile(join(root, 'openapi.json'), JSON.stringify(source));
  await writeFile(config, JSON.stringify(settings));
  await runProject(config);
  const before = await fileSnapshot(join(root, 'generated'));
  const excluded = { ...settings, excludeOperations: ['extra', 'drop'] };
  await writeFile(config, JSON.stringify(excluded));
  const drift = await runProject(config, { check: true });
  assert.equal(drift.clean, false);
  assert.deepEqual(drift.changes, ['changed: .pom-manifest.json']);
  assert.deepEqual(await fileSnapshot(join(root, 'generated')), before);
  await runProject(config);
  const manifest = record(
    json(await readFile(join(root, 'generated/.pom-manifest.json'), 'utf8')),
  );
  assert.deepEqual(manifest.excludedOperations, ['drop', 'extra']);
  await writeFile(
    config,
    JSON.stringify({ ...excluded, excludeOperations: ['drop', 'extra'] }),
  );
  assert.equal((await runProject(config, { check: true })).clean, true);
});

void test('generated operation IDs and unsupported TRACE operations can be excluded without changing other methods', async () => {
  const source = fixture();
  source.paths['/unusual.json'] = {
    trace: { responses: { 200: reusable('responses', 'PrivateAlias') } },
  };
  const files = await compile(source, {
    ...options,
    excludeOperations: ['drop', 'TRACE /unusual.json'],
  });
  assert.deepEqual(
    files,
    await compile(fixture('3.1.2', false), {
      clients: ['consumer'],
      surfaces: { consumer: ['keep'] },
    }),
  );
  await assert.rejects(
    compile(source, {
      ...options,
      excludeOperations: ['drop', 'trace /unusual.json'],
    }),
    /unknown operation identifier/,
  );
});

void test('retained routes, standalone roots and global security protect shared definitions under both pruning modes', async () => {
  for (const pruneUnusedComponents of [false, true]) {
    const settings = { ...options, pruneUnusedComponents };
    const shared = fixture();
    present(shared.components.schemas.Public).properties = {
      id: ref('PrivateAlias'),
    };
    await assert.rejects(
      compile(shared, settings),
      /components.schemas.PrivateValue.minimum/,
    );
    await assert.rejects(
      compile(fixture(), {
        ...settings,
        standalone: {
          private: { schema: ref('PrivateAlias').$ref, usage: 'response' },
        },
      }),
      /components.schemas.PrivateValue.minimum/,
    );
    const global = fixture();
    Object.assign(global, { security: [{ PrivateAlias: [] }] });
    await assert.rejects(
      compile(global, settings),
      /securitySchemes.PrivateAuth.*openIdConnect/,
    );
  }
  const unused = fixture();
  unused.components.schemas.UnrelatedAlias = ref('PrivateAlias');
  await assert.rejects(
    compile(unused, options),
    /components.schemas.PrivateValue.minimum/,
  );
});

void test('unused component pruning is explicit, transitive and independent of operation exclusions', async () => {
  for (const openapi of ['3.0.4', '3.1.2']) {
    const source = fixture(openapi);
    source.components.schemas.UnrelatedAlias = ref('PrivateAlias');
    const before = structuredClone(source);
    for (const settings of [
      options,
      { ...options, pruneUnusedComponents: false },
    ])
      await assert.rejects(
        compile(source, settings),
        /components.schemas.PrivateValue.minimum/,
      );
    const expected = await compile(fixture(openapi, false), {
      clients: ['consumer'],
      surfaces: { consumer: ['keep'] },
    });
    const settings = { ...options, pruneUnusedComponents: true };
    assert.deepEqual(await compile(source, settings), expected);
    assert.deepEqual(
      await compile(parseYaml(stringify(source), 'pruning.yaml'), settings),
      expected,
    );
    assert.deepEqual(source, before);

    const independent = fixture(openapi, false);
    independent.components.schemas.Unused = { type: 'string', minimum: 1 };
    independent.components.schemas.CycleA = ref('CycleB');
    independent.components.schemas.CycleB = ref('CycleA');
    assert.deepEqual(
      await compile(independent, {
        clients: ['consumer'],
        surfaces: { consumer: ['keep'] },
        pruneUnusedComponents: true,
      }),
      expected,
    );
  }
});

void test('pruning preserves authentication aliases and ignores reference-like example data', async () => {
  const source = fixture('3.1.2', false);
  Object.assign(source, { security: [{ AuthAlias: [] }] });
  Object.assign(source.components.securitySchemes, {
    Auth: { type: 'apiKey', in: 'header', name: 'X-Auth' },
    AuthAlias: reusable('securitySchemes', 'Auth'),
  });
  present(source.components.schemas.Public).example = ref('Unused');
  const settings = {
    clients: ['consumer'],
    surfaces: { consumer: ['keep'] },
  };
  const expected = await compile(source, settings);
  source.components.schemas.Unused = { type: 'integer', minLength: 1 };
  assert.deepEqual(
    await compile(source, { ...settings, pruneUnusedComponents: true }),
    expected,
  );
});

void test('pruning cannot hide unselected operations or unsupported document structure', async () => {
  const source = fixture();
  source.paths['/staff'] = {
    get: {
      operationId: 'staff',
      responses: {
        200: {
          description: 'Unselected response',
          content: { 'application/json': { schema: ref('PrivateAlias') } },
        },
      },
    },
  };
  await assert.rejects(
    compile(source, {
      ...options,
      pruneUnusedComponents: true,
      surfaces: { consumer: ['keep', 'drop'], staff: ['staff'] },
    }),
    /components.schemas.PrivateValue.minimum/,
  );
  const unsupported = fixture('3.1.2', false);
  Object.assign(unsupported.components, { callbacks: { completed: {} } });
  await assert.rejects(
    compile(unsupported, {
      clients: ['consumer'],
      surfaces: { consumer: ['keep'] },
      pruneUnusedComponents: true,
    }),
    /components.callbacks: callback definitions are unsupported/,
  );
});

void test('pruning treats ignored map extensions as opaque while retaining x-prefixed schema and property names', async () => {
  const baseline = fixture('3.1.2', false);
  baseline.components.schemas['x-used'] = { type: 'string', minLength: 1 };
  present(present(baseline.components.schemas.Public).properties)['x-field'] =
    ref('x-used');
  const settings = {
    clients: ['consumer'],
    surfaces: { consumer: ['keep'] },
    pruneUnusedComponents: true,
  };
  const expected = await compile(baseline, settings);
  for (const context of ['paths', 'responses', 'content']) {
    const source = structuredClone(baseline);
    source.components.schemas.Unused = { type: 'integer', minLength: 1 };
    const media = { schema: ref('Unused') };
    const response = { content: { 'application/json': media } };
    const operation = record(present(source.paths['/records']).get);
    if (context === 'paths')
      source.paths['x-meta'] = { get: { responses: { 200: response } } };
    else if (context === 'responses')
      record(operation.responses)['x-meta'] = response;
    else
      record(record(record(operation.responses)['200']).content)['x-meta'] =
        media;
    assert.deepEqual(
      await compile(source, { ...settings, ignoreExtensions: ['x-meta'] }),
      expected,
      context,
    );
    await assert.rejects(
      compile(source, settings),
      /x-meta: unsupported keyword/,
    );
  }
});

void test('pruning requires a boolean option', async () => {
  for (const value of ['true', 0, null, [], {}])
    await assert.rejects(
      invalidOptions(compile, fixture(), {
        ...options,
        pruneUnusedComponents: value,
      }),
      { name: 'ContractError', location: 'pruneUnusedComponents' },
    );
});

void test('pruned component inventory participates in read-only drift without changing generated modules', async (t) => {
  const root = await temporary(t);
  const source = fixture('3.1.2', false);
  source.components.schemas['Unused~/name'] = { type: 'string' };
  const config = join(root, 'pom.json');
  const input = join(root, 'openapi.json');
  const output = join(root, 'generated');
  const settings = {
    version: 2,
    openapi: './openapi.json',
    output: './generated',
    clients: ['consumer'],
    surfaces: { consumer: ['keep'] },
    pruneUnusedComponents: true,
  };
  await writeFile(input, JSON.stringify(source));
  await writeFile(config, JSON.stringify(settings));
  await runProject(config);
  assert.equal((await runProject(config, { check: true })).clean, true);
  const manifestFile = join(output, '.pom-manifest.json');
  const manifest = record(json(await readFile(manifestFile, 'utf8')));
  assert.deepEqual(manifest.prunedComponents, [
    '#/components/schemas/Unused~0~1name',
  ]);
  source.components.schemas.AnotherUnused = { type: 'boolean' };
  await writeFile(input, JSON.stringify(source));
  const before = await fileSnapshot(root);
  const beforeOutput = await fileSnapshot(output);
  const drift = await runProject(config, { check: true });
  assert.equal(drift.clean, false);
  assert.deepEqual(drift.changes, ['changed: .pom-manifest.json']);
  assert.deepEqual(await fileSnapshot(root), before);
  assert.deepEqual(await fileSnapshot(output), beforeOutput);
  await runProject(config);
  const updated = record(json(await readFile(manifestFile, 'utf8')));
  assert.deepEqual(updated.prunedComponents, [
    '#/components/schemas/AnotherUnused',
    '#/components/schemas/Unused~0~1name',
  ]);
  assert.equal((await runProject(config, { check: true })).clean, true);
  delete source.components.schemas['Unused~/name'];
  await writeFile(input, JSON.stringify(source));
  await writeFile(
    config,
    JSON.stringify({ ...settings, pruneUnusedComponents: false }),
  );
  const strict = await runProject(config, { check: true });
  assert.deepEqual(strict.changes, ['changed: .pom-manifest.json']);
  await runProject(config);
  assert.equal(
    Object.hasOwn(
      record(json(await readFile(manifestFile, 'utf8'))),
      'prunedComponents',
    ),
    false,
  );
  await writeFile(
    config,
    JSON.stringify({ ...settings, pruneUnusedComponents: 'true' }),
  );
  const invalid = await fileSnapshot(root);
  const invalidOutput = await fileSnapshot(output);
  await assert.rejects(
    runProject(config),
    /pruneUnusedComponents: expected a boolean/,
  );
  assert.deepEqual(await fileSnapshot(root), invalid);
  assert.deepEqual(await fileSnapshot(output), invalidOutput);
});

void test('opaque annotation data never marks unrelated components as excluded dependencies', async () => {
  const source = fixture();
  source.components.schemas.UnrelatedBad = { type: 'integer', minLength: 1 };
  present(source.components.schemas.PrivateValue).example = ref('UnrelatedBad');
  await assert.rejects(
    compile(source, options),
    /components.schemas.UnrelatedBad.minLength/,
  );
});

void test('standalone roots remain usable when all operations are excluded', async (t) => {
  const source = fixture();
  const files = await compile(source, {
    ...options,
    clients: [],
    excludeOperations: ['keep', 'drop'],
    standalone: { value: { schema: ref('Public').$ref, usage: 'response' } },
  });
  const root = await generatedTestWorkspace(t, files);
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.value.ts',
  );
  assert.deepEqual(schema.parse({ id: 'valid', extra: true }), { id: 'valid' });
});

void test('exclusion copies preserve frozen source descriptors and non-enumerable constraints', async (t) => {
  const source = fixture();
  const indirect: Schema = {};
  Object.defineProperty(indirect, '$ref', {
    value: ref('RequiredName').$ref,
    enumerable: false,
  });
  present(present(source.components.schemas.Public).properties).name = indirect;
  source.components.schemas.RequiredName = { type: 'string', minLength: 3 };
  const id = present(present(source.components.schemas.Public).properties).id;
  assert.ok(id);
  Object.defineProperty(id, 'minLength', {
    value: 3,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.freeze(present(source.paths['/records']));
  Object.freeze(source.paths);
  Object.freeze(source.components.schemas);
  Object.freeze(source);
  const files = await compile(source, {
    ...options,
    pruneUnusedComponents: true,
  });
  const root = await generatedTestWorkspace(t, files);
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  assert.equal(
    present(client.operations.keep).parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: '{"id":"ab"}',
    }).kind,
    'protocol',
  );
  assert.equal(Object.hasOwn(present(source.paths['/records']), 'post'), true);
  assert.equal(Object.hasOwn(source.components.schemas, 'PrivateValue'), true);
});

void test('large private reference graphs are pruned iteratively, including cycles', async () => {
  const source = fixture();
  for (let index = 0; index < 2000; index++)
    source.components.schemas[`PrivateChain${index}`] = ref(
      `PrivateChain${index + 1}`,
    );
  source.components.schemas.PrivateChain2000 = ref('PrivateChain0');
  present(present(source.components.schemas.PrivateCycleA).properties).chain =
    ref('PrivateChain0');
  const expected = await compile(fixture('3.1.2', false), {
    clients: ['consumer'],
    surfaces: { consumer: ['keep'] },
  });
  for (const pruneUnusedComponents of [false, true])
    assert.deepEqual(
      await compile(source, { ...options, pruneUnusedComponents }),
      expected,
    );
});

void test('project exclusions are recorded in the manifest and invalid selections cannot modify inputs or outputs', async (t) => {
  const root = await temporary(t);
  const config = join(root, 'pom.json');
  const source = fixture();
  const input = join(root, 'openapi.yaml');
  await writeFile(input, stringify(source));
  const settings = {
    version: 2,
    openapi: './openapi.yaml',
    output: './generated',
    ...options,
  };
  await writeFile(config, JSON.stringify(settings));
  await runProject(config);
  const output = join(root, 'generated');
  const manifest = record(
    json(await readFile(join(output, '.pom-manifest.json'), 'utf8')),
  );
  assert.deepEqual(manifest.excludedOperations, ['drop']);
  const before = await fileSnapshot(output);
  assert.equal((await runProject(config, { check: true })).clean, true);
  assert.deepEqual(await fileSnapshot(output), before);
  const inputBefore = await readFile(input, 'utf8');
  await writeFile(
    config,
    JSON.stringify({ ...settings, excludeOperations: ['missing'] }),
  );
  for (const check of [false, true])
    await assert.rejects(
      runProject(config, { check }),
      /unknown operation identifier "missing"/,
    );
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  await assert.rejects(
    exec(process.execPath, [cli, 'generate', '--config', config]),
    commandFailure(1, /unknown operation identifier "missing"/),
  );
  assert.deepEqual(await fileSnapshot(output), before);
  assert.equal(await readFile(input, 'utf8'), inputBefore);
});
