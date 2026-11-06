import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile, runProject, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { fileSnapshot, temporary } from './helpers.ts';
import {
  generatedTestWorkspace,
  generatedWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import {
  directionalFixture,
  directionalSelection,
  directionalTypeConsumer,
  verifyDirectional,
} from './directional-fixture.ts';
import type {
  DirectionalClient,
  DirectionalQueries,
} from './directional-fixture.ts';
import type { StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const exec = promisify(execFile);
async function generated(t: Parameters<typeof temporary>[0]) {
  const root = await generatedWorkspace(
    await compile(directionalFixture(), directionalSelection),
    'directional-generated',
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, 'directional-generated');
  const client = (await import(
    pathToFileURL(join(folder, 'client.consumer.ts')).href
  )) as DirectionalClient;
  const standalone = async (name: string) =>
    (await import(
      pathToFileURL(join(folder, `standalone.${name}.ts`)).href
    )) as StandaloneModule;
  return { root, folder, client, standalone };
}

void test('shared directional fields preserve inputs and YAML bytes while isolating reachable schemas', async (t) => {
  const input = directionalFixture();
  const before = structuredClone(input);
  const files = await compile(input, directionalSelection);
  assert.deepEqual(input, before);
  assert.deepEqual(
    await compile(
      parseYaml(stringify(input), 'directional.yaml'),
      directionalSelection,
    ),
    files,
  );
  const { folder } = await generated(t);
  const schemas = (await import(
    pathToFileURL(join(folder, 'client.consumer.schemas.ts')).href
  )) as { requestSchemas: object; responseSchemas: object };
  assert.deepEqual(Object.keys(schemas.requestSchemas).sort(), [
    'Secret',
    'SecretAlias',
    'Shared',
  ]);
  assert.deepEqual(Object.keys(schemas.responseSchemas).sort(), [
    'Id',
    'IdAlias',
    'Shared',
  ]);
  assert.doesNotMatch(
    files['standalone.request.ts'] ?? '',
    /type_Id_request|type_IdAlias_request/,
  );
  assert.doesNotMatch(
    files['standalone.response.ts'] ?? '',
    /type_Secret_response|type_SecretAlias_response/,
  );
});

void test('directional fields agree across builders, standalone, raw/scoped execution and both query representations', async (t) => {
  const { folder, client, standalone } = await generated(t);
  const queries = (await import(
    pathToFileURL(join(folder, 'client.consumer.queries.ts')).href
  )) as DirectionalQueries;
  await verifyDirectional(
    client,
    queries,
    await standalone('request'),
    await standalone('response'),
    await standalone('empty-request'),
    await standalone('empty-response'),
  );
});

void test('array items and map values preserve request and response field direction', async (t) => {
  const item = {
    type: 'object',
    properties: {
      id: { type: 'string', readOnly: true },
      secret: { type: 'string', writeOnly: true },
      label: { type: 'string' },
    },
    required: ['id', 'secret', 'label'],
  };
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic directional containers', version: '1' },
    paths: {},
    components: {
      schemas: {
        Items: { type: 'array', items: item },
        Entries: { type: 'object', additionalProperties: item },
      },
    },
  };
  const root = await generatedTestWorkspace(
    t,
    await compile(input, {
      clients: [],
      standalone: Object.fromEntries(
        ['Items', 'Entries'].flatMap((name) =>
          (['request', 'response'] as const).map((usage) => [
            `${name.toLowerCase()}-${usage}`,
            { schema: `#/components/schemas/${name}`, usage },
          ]),
        ),
      ),
    }),
  );
  for (const name of ['Items', 'Entries']) {
    const wrap = (value: unknown) =>
      name === 'Items' ? [value] : { first: value };
    const request = await importGenerated<StandaloneModule>(
      root,
      `standalone.${name.toLowerCase()}-request.ts`,
    );
    const response = await importGenerated<StandaloneModule>(
      root,
      `standalone.${name.toLowerCase()}-response.ts`,
    );
    const valid = { label: 'visible', secret: 'private' };
    assert.deepEqual(request.schema.parse(wrap(valid)), wrap(valid));
    assert.equal(
      request.schema.safeParse(wrap({ ...valid, id: 'forbidden' })).success,
      false,
    );
    assert.equal(
      request.schema.safeParse(wrap({ label: 'visible' })).success,
      false,
    );
    assert.deepEqual(
      response.schema.parse(
        wrap({ id: 'record', label: 'visible', secret: { ignored: true } }),
      ),
      wrap({ id: 'record', label: 'visible' }),
    );
    assert.equal(
      response.schema.safeParse(wrap({ label: 'visible' })).success,
      false,
    );
  }
});

void test('read-only presence rejection covers non-enumerable and inherited properties without reading them', async (t) => {
  const { standalone } = await generated(t);
  const { schema } = await standalone('request');
  const valid = () => ({
    label: 'visible',
    secret: 'private',
    nested: { label: 'nested', password: 'private' },
  });
  let reads = 0;
  for (const [inherited, enumerable] of [
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const) {
    const holder = Object.defineProperty({}, 'id', {
      get() {
        reads++;
        throw new Error('Do not read forbidden input');
      },
      enumerable,
    });
    const input: object = inherited
      ? Object.assign(Object.create(holder) as object, valid())
      : Object.assign(holder, valid());
    const result = schema.safeParse(input);
    assert.equal(result.success, false);
    if (!result.success)
      assert.deepEqual(result.error.issues, [
        {
          path: ['id'],
          message: 'read-only property is forbidden in requests',
        },
      ]);
  }
  assert.equal(reads, 0);
  const hiddenUndefined = Object.defineProperty(valid(), 'id', {
    value: undefined,
    enumerable: false,
  });
  assert.equal(schema.safeParse(hiddenUndefined).success, false);
  const before = Object.getOwnPropertyDescriptor(Object.prototype, 'id');
  try {
    Object.defineProperty(Object.prototype, 'id', {
      value: 'pollution',
      configurable: true,
    });
    assert.deepEqual(schema.parse(valid()), valid());
  } finally {
    if (before) Object.defineProperty(Object.prototype, 'id', before);
    else Reflect.deleteProperty(Object.prototype, 'id');
  }
});

void test('wide directional parsers retain sibling issues and report forbidden fields once', async (t) => {
  const properties: Record<string, Schema> = Object.fromEntries(
    Array.from({ length: 140 }, (_, index) => [
      `field${index}`,
      { type: 'string' },
    ]),
  );
  properties.id = { type: 'string', readOnly: true };
  const input = {
    openapi: '3.1.0',
    info: { title: 'Synthetic wide direction', version: '1' },
    paths: {},
    components: { schemas: { Wide: { type: 'object', properties } } },
  };
  const files = await compile(input, {
    clients: [],
    standalone: {
      wide: { schema: '#/components/schemas/Wide', usage: 'request' },
    },
  });
  const root = await generatedWorkspace(files);
  t.after(() => rm(root, { recursive: true, force: true }));
  const { schema } = (await import(
    pathToFileURL(join(root, 'standalone.wide.ts')).href
  )) as StandaloneModule;
  const parsed = schema.safeParse({
    id: undefined,
    field0: 1,
    field139: false,
    extra: true,
  });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    assert.equal(
      parsed.error.issues.filter((issue) => issue.path[0] === 'id').length,
      1,
    );
    assert.deepEqual(
      new Set(parsed.error.issues.map((issue) => issue.path.join('.'))),
      new Set(['id', 'field0', 'field139', '']),
    );
    assert.deepEqual(
      parsed.error.issues.filter((issue) => issue.path.length === 0),
      [{ path: [], message: 'unrecognized key: "extra"' }],
    );
  }
});

void test('directional input and output types survive declaration-only publication', async (t) => {
  const { root } = await generated(t);
  await writeFile(join(root, 'consumer.ts'), directionalTypeConsumer());
  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      exactOptionalPropertyTypes: true,
      allowImportingTsExtensions: true,
      declaration: true,
      emitDeclarationOnly: true,
      isolatedDeclarations: true,
      outDir: './published',
      types: [],
    },
    include: ['./consumer.ts', './directional-generated/*.ts'],
  };
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify(config));
  const tsc = fileURLToPath(
    new URL('../node_modules/typescript/bin/tsc', import.meta.url),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')]);
  await rm(join(root, 'directional-generated'), { recursive: true });
  await rm(join(root, 'consumer.ts'));
  await writeFile(
    join(root, 'downstream.ts'),
    `
    import {build} from './published/consumer.js';
    import type {Request,Response} from './published/consumer.js';
    const input:Request={label:'l',secret:'s',nested:{label:'n',password:'p'}};
    const output:Response={id:'id',label:'l',nested:{id:'n',label:'n'}};
    build({body:input});
    // @ts-expect-error Published response does not expose a secret.
    output.secret;
    // @ts-expect-error Published request rejects server id through a fetched spread.
    const roundTrip:Request={...output,secret:input.secret,nested:input.nested};
    void roundTrip;
  `,
  );
  await writeFile(
    join(root, 'downstream.json'),
    JSON.stringify({
      compilerOptions: {
        ...config.compilerOptions,
        noEmit: true,
        declaration: false,
        emitDeclarationOnly: false,
        isolatedDeclarations: false,
      },
      include: ['./downstream.ts', './published/**/*.d.ts'],
    }),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'downstream.json')]);
});

void test('invalid excluded schemas fail before writes and drift checks leave outputs unchanged', async (t) => {
  const root = await temporary(t);
  const input = join(root, 'openapi.json');
  const config = join(root, 'pom.json');
  const output = join(root, 'generated');
  const document = directionalFixture();
  await writeFile(input, JSON.stringify(document));
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      ...directionalSelection,
    }),
  );
  await runProject(config);
  const before = await fileSnapshot(output);
  Object.assign(document.components.schemas.Secret, {
    unsupportedKeyword: true,
  });
  const source = JSON.stringify(document);
  await writeFile(input, source);
  await assert.rejects(runProject(config), ContractError);
  await assert.rejects(runProject(config, { check: true }), ContractError);
  assert.deepEqual(await fileSnapshot(output), before);
  assert.equal(await readFile(input, 'utf8'), source);
});
