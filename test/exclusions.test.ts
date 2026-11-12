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

void test('retained routes, standalone roots, global security and otherwise-unused components protect shared definitions', async () => {
  const shared = fixture();
  present(shared.components.schemas.Public).properties = {
    id: ref('PrivateAlias'),
  };
  await assert.rejects(
    compile(shared, options),
    /components.schemas.PrivateValue.minimum/,
  );
  await assert.rejects(
    compile(fixture(), {
      ...options,
      standalone: {
        private: { schema: ref('PrivateAlias').$ref, usage: 'response' },
      },
    }),
    /components.schemas.PrivateValue.minimum/,
  );
  const global = fixture();
  Object.assign(global, { security: [{ PrivateAlias: [] }] });
  await assert.rejects(
    compile(global, options),
    /securitySchemes.PrivateAuth.*openIdConnect/,
  );
  const unused = fixture();
  unused.components.schemas.UnrelatedAlias = ref('PrivateAlias');
  await assert.rejects(
    compile(unused, options),
    /components.schemas.PrivateValue.minimum/,
  );
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
  const files = await compile(source, options);
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
  assert.deepEqual(
    await compile(source, options),
    await compile(fixture('3.1.2', false), {
      clients: ['consumer'],
      surfaces: { consumer: ['keep'] },
    }),
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
