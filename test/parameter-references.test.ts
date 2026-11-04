import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import type { CompileOptions } from '../dist/index.js';
import { executionFixture, executionSelection } from './execution-fixture.ts';
import { parseYaml } from '../dist/yaml.js';
import { present, record } from './assertions.ts';
import { generatedWorkspace } from './generated-workspace.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import {
  inlineParameterFixture,
  parameterReference as ref,
  parameterReferenceConsumer,
  parameterReferenceFixture as fixture,
  parameterReferenceSelection as selection,
  verifyParameterReferences,
} from './parameter-reference-fixture.ts';
import type { RuntimeClient } from './runtime-types.ts';

const exec = promisify(execFile);
const itemPath = 'paths./entries/{entryId}';
type Fixture = ReturnType<typeof fixture>;
async function generated(
  t: import('node:test').TestContext,
  document = fixture(),
  options: CompileOptions = selection,
) {
  const root = await generatedWorkspace(await compile(document, options));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = (await import(
    pathToFileURL(join(root, 'client.consumer.ts')).href
  )) as RuntimeClient;
  return { root, client };
}

void test('parameter references and aliases generate exactly their inline equivalent without mutation', async () => {
  const document = fixture();
  const before = structuredClone(document);
  const actual = await compile(document, selection);
  assert.deepEqual(actual, await compile(inlineParameterFixture(), selection));
  assert.deepEqual(document, before);
  assert.deepEqual(
    await compile(parseYaml(stringify(document), 'parameters.yaml'), selection),
    actual,
  );
  document.components.parameters = Object.fromEntries(
    Object.entries(document.components.parameters).reverse(),
  );
  assert.deepEqual(await compile(document, selection), actual);
  assert.match(actual['client.consumer.schemas.ts'] ?? '', /EntryId/);
  assert.match(actual['client.consumer.schemas.ts'] ?? '', /Key/);
  assert.doesNotMatch(
    Object.values(actual).join('\n'),
    /SecretId|UnusedValue|internalReport/,
  );
});

void test('parameter references preserve complete executable, query, cursor and offset outputs', async () => {
  const document = executionFixture();
  const expected = await compile(document, executionSelection);
  const components: Record<string, unknown> = {};
  let index = 0;
  for (const pathItem of Object.values(document.paths)) {
    for (const value of Object.values(record(pathItem))) {
      const operation = record(value);
      if (!Object.hasOwn(operation, 'parameters')) continue;
      assert.ok(Array.isArray(operation.parameters));
      const parameters = operation.parameters.map((parameter: unknown) => {
        const name = `Shared${index++}`;
        components[name] = parameter;
        return ref(name);
      });
      Object.assign(operation, { parameters });
    }
  }
  Object.assign(document.components, { parameters: components });
  assert.deepEqual(await compile(document, executionSelection), expected);
});

void test('referenced path, query and header parameters retain constraints and whole-parameter overrides', async (t) => {
  const { root, client } = await generated(t);
  const staff = (await import(
    pathToFileURL(join(root, 'client.staff.ts')).href
  )) as RuntimeClient;
  verifyParameterReferences(client, staff);
});

void test('empty operation lists retain referenced inheritance and inline overrides work across references', async (t) => {
  const document = fixture();
  document.paths['/entries/{entryId}'].get.parameters = [];
  document.paths['/entries/{entryId}'].post.parameters = [
    {
      name: 'mode',
      in: 'query',
      required: true,
      schema: { type: 'string', const: 'inline' },
    },
  ];
  const { root, client } = await generated(t, document);
  assert.equal(
    present(client.operations.readEntries).build({
      path: { entryId: 'id' },
      headers: { 'X-Scope': 'tenant' },
    }).url,
    '/entries/id',
  );
  const staff = (await import(
    pathToFileURL(join(root, 'client.staff.ts')).href
  )) as RuntimeClient;
  const write = present(staff.operations.writeEntry);
  assert.equal(
    write.build({
      path: { entryId: 'id' },
      query: { mode: 'inline' },
      headers: { 'X-Scope': 'tenant' },
    }).url,
    '/entries/id?mode=inline',
  );
  assert.throws(
    () =>
      write.build({
        path: { entryId: 'id' },
        headers: { 'X-Scope': 'tenant' },
      }),
    staff.RequestValidationError,
  );
});

void test('referenced headers can remain transport-owned with their requiredness and constraints', async (t) => {
  const { client } = await generated(t, fixture(), {
    ...selection,
    transportHeaders: ['X-Scope'],
  });
  const read = present(client.operations.readEntries);
  const request = read.build({
    path: { entryId: 'id' },
    query: { mode: 'read' },
  });
  assert.equal(Object.hasOwn(request.headers, 'X-Scope'), false);
  assert.equal(
    request.validateHeaders({ 'x-sCoPe': 'tenant' })['x-scope'],
    'tenant',
  );
  assert.throws(
    () => request.validateHeaders({}),
    client.RequestValidationError,
  );
  assert.throws(
    () => request.validateHeaders({ 'X-Scope': 'staff' }),
    client.RequestValidationError,
  );
  assert.throws(
    () =>
      read.build({
        path: { entryId: 'id' },
        query: { mode: 'read' },
        headers: { 'X-Scope': 'tenant' },
      }),
    client.RequestValidationError,
  );
});

void test('parameter reference annotations do not change generated behavior', async () => {
  const document = fixture();
  const expected = await compile(document, selection);
  Object.assign(document.components.parameters.ScopeAlias!, {
    summary: '',
    description: 'New alias documentation',
  });
  Object.assign(document.paths['/entries/{entryId}'].parameters[0]!, {
    summary: 'Key summary',
    description: '',
  });
  assert.deepEqual(await compile(document, selection), expected);
});

void test('unused valid required path parameters do not create path membership requirements', async () => {
  const document = fixture();
  const expected = await compile(document, selection);
  document.components.parameters.UnusedPath = {
    name: 'anotherId',
    in: 'path',
    required: true,
    schema: { type: 'string', minLength: 1 },
  };
  assert.deepEqual(await compile(document, selection), expected);
});

const invalid: [string, (document: Fixture) => void, string, RegExp][] = [
  [
    'missing operation target',
    (d) => {
      d.paths['/entries/{entryId}'].get.parameters[0] = ref('Missing');
    },
    `${itemPath}.get.parameters[0].$ref`,
    /unresolved parameter reference Missing/,
  ],
  [
    'missing inherited target',
    (d) => {
      d.paths['/entries/{entryId}'].parameters[0] = ref('Missing');
    },
    `${itemPath}.parameters[0].$ref`,
    /unresolved parameter reference Missing/,
  ],
  [
    'missing unused alias target',
    (d) => {
      d.components.parameters.UnusedAlias = ref('Missing');
    },
    'components.parameters.UnusedAlias.$ref',
    /unresolved parameter reference Missing/,
  ],
  [
    'self cycle',
    (d) => {
      d.components.parameters.UnusedAlias = ref('UnusedAlias');
    },
    'components.parameters.UnusedAlias.$ref',
    /cyclic parameter reference/,
  ],
  [
    'unused alias cycle',
    (d) => {
      Object.assign(d.components.parameters, { A: ref('B'), B: ref('A') });
    },
    'components.parameters.A.$ref',
    /cyclic parameter reference/,
  ],
  [
    'wrong component category',
    (d) => {
      Object.assign(d.components.parameters.CursorAlias!, {
        $ref: '#/components/schemas/Key',
      });
    },
    'components.parameters.CursorAlias.$ref',
    /only local component parameter references/,
  ],
  [
    'remote target',
    (d) => {
      Object.assign(d.components.parameters.CursorAlias!, {
        $ref: 'https://synthetic.invalid/api.json#/components/parameters/Cursor',
      });
    },
    'components.parameters.CursorAlias.$ref',
    /only local component parameter references/,
  ],
  [
    'relative external target',
    (d) => {
      Object.assign(d.components.parameters.CursorAlias!, {
        $ref: './parameters.json#/components/parameters/Cursor',
      });
    },
    'components.parameters.CursorAlias.$ref',
    /only local component parameter references/,
  ],
  [
    'nested pointer',
    (d) => {
      Object.assign(d.components.parameters.CursorAlias!, {
        $ref: '#/components/parameters/Cursor/schema',
      });
    },
    'components.parameters.CursorAlias.$ref',
    /component parameter names must match/,
  ],
  [
    'empty target',
    (d) => {
      Object.assign(d.components.parameters.CursorAlias!, {
        $ref: '#/components/parameters/',
      });
    },
    'components.parameters.CursorAlias.$ref',
    /component parameter names must match/,
  ],
  [
    'nonstring ref',
    (d) => {
      Object.assign(d.components.parameters.CursorAlias!, { $ref: 1 });
    },
    'components.parameters.CursorAlias.$ref',
    /only local component parameter references/,
  ],
  [
    'ref description type',
    (d) => {
      Object.assign(d.components.parameters.CursorAlias!, {
        description: false,
      });
    },
    'components.parameters.CursorAlias.description',
    /expected a string/,
  ],
  [
    'ref summary type',
    (d) => {
      Object.assign(d.paths['/entries/{entryId}'].get.parameters[0]!, {
        summary: null,
      });
    },
    `${itemPath}.get.parameters[0].summary`,
    /expected a string/,
  ],
  [
    'required ref sibling',
    (d) => {
      Object.assign(d.components.parameters.CursorAlias!, { required: true });
    },
    'components.parameters.CursorAlias.required',
    /unsupported keyword/,
  ],
  [
    'schema ref sibling',
    (d) => {
      Object.assign(d.paths['/entries/{entryId}'].get.parameters[0]!, {
        schema: { type: 'string' },
      });
    },
    `${itemPath}.get.parameters[0].schema`,
    /unsupported keyword/,
  ],
  [
    'name ref sibling',
    (d) => {
      Object.assign(d.components.parameters.CursorAlias!, { name: 'changed' });
    },
    'components.parameters.CursorAlias.name',
    /unsupported keyword/,
  ],
  [
    'unknown ref extension',
    (d) => {
      Object.assign(d.components.parameters.CursorAlias!, {
        'x-unknown': true,
      });
    },
    'components.parameters.CursorAlias.x-unknown',
    /unsupported keyword/,
  ],
  [
    'invalid unused parameter schema',
    (d) => {
      Object.assign(d.components.parameters.Unused!, {
        schema: { type: 'object' },
      });
    },
    'components.parameters.Unused.schema',
    /parameters require primitive/,
  ],
  [
    'invalid unused schema reference',
    (d) => {
      Object.assign(d.components.parameters.Unused!, {
        schema: { $ref: '#/components/schemas/Missing' },
      });
    },
    'components.parameters.Unused.schema.$ref',
    /unresolved reference/,
  ],
  [
    'invalid unused example reference',
    (d) => {
      Object.assign(d.components.parameters.Unused!, {
        examples: { documentation: { $ref: '#/components/examples/Missing' } },
      });
    },
    'components.parameters.Unused.examples.documentation.$ref',
    /unresolved example reference/,
  ],
  [
    'invalid overridden component',
    (d) => {
      Object.assign(d.components.parameters.BaseMode!, {
        style: 'spaceDelimited',
      });
    },
    'components.parameters.BaseMode.style',
    /serialization/,
  ],
  [
    'unsupported unselected component',
    (d) => {
      Object.assign(d.components.parameters.InternalKey!, { in: 'cookie' });
    },
    'components.parameters.InternalKey.in',
    /only path, query and header/,
  ],
  [
    'unused required nullable query',
    (d) => {
      d.components.parameters.UnusedNullable = {
        name: 'null',
        in: 'query',
        required: true,
        schema: { type: ['string', 'null'] },
      };
    },
    'components.parameters.UnusedNullable.required',
    /nullable query parameters must be optional/,
  ],
  [
    'unused read-only parameter',
    (d) => {
      Object.assign(d.components.parameters.Unused!, {
        schema: { type: 'string', readOnly: true },
      });
    },
    'components.parameters.Unused.schema',
    /may only be omitted as object properties/,
  ],
  [
    'unused reserved header',
    (d) => {
      Object.assign(d.components.parameters.Unused!, {
        name: 'Authorization',
        in: 'header',
        schema: { type: 'string' },
      });
    },
    'components.parameters.Unused.name',
    /reserved/,
  ],
  [
    'unused malformed default',
    (d) => {
      Object.assign(d.components.parameters.Unused!, {
        schema: { type: 'string', default: undefined },
      });
    },
    'components.parameters.Unused.schema.default',
    /expected an object/,
  ],
  [
    'optional referenced path',
    (d) => {
      Object.assign(d.components.parameters['9.entry-key_v1']!, {
        required: false,
      });
    },
    'components.parameters.9.entry-key_v1.required',
    /path parameters must be required/,
  ],
  [
    'missing referenced path declaration',
    (d) => {
      d.paths['/entries/{entryId}'].parameters.shift();
    },
    `${itemPath}.get.parameters`,
    /match exactly/,
  ],
  [
    'duplicate component use',
    (d) => {
      d.paths['/entries/{entryId}'].parameters.push(ref('EntryKey'));
    },
    `${itemPath}.parameters`,
    /duplicate parameter path:entryId/,
  ],
  [
    'duplicate aliases after resolution',
    (d) => {
      d.paths['/entries/{entryId}'].parameters.push(ref('OtherCursorAlias'));
    },
    `${itemPath}.parameters`,
    /duplicate parameter query:after/,
  ],
  [
    'duplicate operation ref',
    (d) => {
      d.paths['/entries/{entryId}'].get.parameters.push(ref('ReadMode'));
    },
    `${itemPath}.get.parameters`,
    /duplicate parameter query:mode/,
  ],
  [
    'case-insensitive referenced header collision',
    (d) => {
      d.components.parameters.LowerScope = {
        name: 'x-scope',
        in: 'header',
        schema: { type: 'string' },
      };
      d.paths['/entries/{entryId}'].get.parameters.push(ref('LowerScope'));
    },
    `${itemPath}.get.parameters`,
    /duplicate parameter header:x-scope/,
  ],
];
for (const [name, mutate, location, message] of invalid)
  void test(`parameter references reject ${name} at the owning declaration`, async () => {
    const document = fixture();
    mutate(document);
    const before = structuredClone(document);
    await assert.rejects(compile(document, selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, location);
      assert.match(error.message, message);
      return true;
    });
    assert.deepEqual(document, before);
  });

for (const name of [
  '',
  'bad/name',
  'bad~name',
  'bad%20name',
  'bad name',
  '💡',
  '__proto__',
  'prototype',
  'constructor',
])
  void test(`parameter component names reject ${JSON.stringify(name)}`, async () => {
    const document = fixture();
    Object.defineProperty(document.components.parameters, name, {
      value: { name: 'unused', in: 'query', schema: { type: 'string' } },
      enumerable: true,
    });
    await assert.rejects(compile(document, selection), {
      name: 'ContractError',
      message: /component parameter names must match|unsupported object key/,
    });
  });

void test('malformed parameter maps and entries fail explicitly', async () => {
  for (const parameters of [null, [], 'parameters']) {
    const document = fixture();
    Object.assign(document.components, { parameters });
    await assert.rejects(
      compile(document, selection),
      /components.parameters: expected an object/,
    );
  }
  for (const value of [null, [], true]) {
    const document = fixture();
    Object.assign(document.components.parameters, { Unused: value });
    await assert.rejects(
      compile(document, selection),
      /components.parameters.Unused: expected an object/,
    );
  }
});

void test('long parameter alias chains resolve without a call-stack limit or output changes', async () => {
  const document = fixture();
  const expected = await compile(document, selection);
  const parameters = document.components.parameters;
  for (let index = 0; index < 10_000; index++)
    parameters[`Chain${index}`] = ref(
      index === 9_999 ? 'Cursor' : `Chain${index + 1}`,
    );
  Object.assign(parameters.CursorAlias!, ref('Chain0'));
  assert.deepEqual(await compile(document, selection), expected);
});

void test('referenced requiredness and literals survive generated declarations and a separate consumer', async (t) => {
  const { root } = await generated(t);
  await writeFile(join(root, 'consumer.ts'), parameterReferenceConsumer);
  const options = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    exactOptionalPropertyTypes: true,
    types: [],
  };
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        ...options,
        allowImportingTsExtensions: true,
        declaration: true,
        emitDeclarationOnly: true,
        isolatedDeclarations: true,
        outDir: './declarations',
      },
      include: ['./*.ts'],
    }),
  );
  const tsc = fileURLToPath(
    new URL('../node_modules/typescript/bin/tsc', import.meta.url),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')]);
  await writeFile(
    join(root, 'published.ts'),
    `
    import { read } from './declarations/consumer.js';
    read({ path: { entryId: 'id' }, query: { mode: 'read', after: null }, headers: { 'X-Scope': 'tenant' } });
    // @ts-expect-error Published references retain required inherited headers.
    read({ path: { entryId: 'id' }, query: { mode: 'read' } });
    // @ts-expect-error Published overrides retain their literal type.
    read({ path: { entryId: 'id' }, query: { mode: 'base' }, headers: { 'X-Scope': 'tenant' } });
  `,
  );
  await writeFile(
    join(root, 'published.json'),
    JSON.stringify({
      compilerOptions: { ...options, noEmit: true },
      include: ['./published.ts', './declarations/*.d.ts'],
    }),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'published.json')]);
});

void test('invalid referenced components cannot alter generated files during generation or drift checks', async (t) => {
  const root = await temporary(t);
  const input = join(root, 'openapi.json');
  const config = join(root, 'pom.json');
  const output = join(root, 'generated');
  await writeFile(input, JSON.stringify(fixture()));
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      ...selection,
    }),
  );
  await runProject(config);
  const before = await fileSnapshot(output);
  assert.equal((await runProject(config, { check: true })).clean, true);
  assert.deepEqual(await fileSnapshot(output), before);
  for (const mutate of [
    (d: Fixture) => {
      d.components.parameters.UnusedAlias = ref('Missing');
    },
    (d: Fixture) => {
      d.components.parameters.UnusedAlias = ref('UnusedAlias');
    },
    (d: Fixture) => {
      Object.assign(d.components.parameters.Unused!, {
        schema: { type: 'object' },
      });
    },
  ]) {
    const document = fixture();
    mutate(document);
    const source = JSON.stringify(document);
    await writeFile(input, source);
    await assert.rejects(runProject(config), ContractError);
    await assert.rejects(runProject(config, { check: true }), ContractError);
    assert.deepEqual(await fileSnapshot(output), before);
    assert.equal(await readFile(input, 'utf8'), source);
  }
});
