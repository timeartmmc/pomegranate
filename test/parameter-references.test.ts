import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import type { CompileOptions } from '../dist/index.js';
import { executionFixture, executionSelection } from './execution-fixture.ts';
import { parseYaml } from '../dist/yaml.js';
import { present, record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
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
  const root = await generatedTestWorkspace(
    t,
    await compile(document, options),
  );
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
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
  const staff = await importGenerated<RuntimeClient>(root, 'client.staff.ts');
  verifyParameterReferences(client, staff);
});

void test('OpenAPI 3.0 flat parameters warn about inactive access annotations and retain validation', async (t) => {
  const id = { $ref: '#/components/schemas/Id' };
  const recordRef = { $ref: '#/components/schemas/Record' };
  const document = {
    openapi: '3.0.4',
    info: { title: 'Synthetic parameter annotation contexts', version: '1' },
    components: {
      schemas: {
        Id: { type: 'integer', minimum: 1, readOnly: true },
        IdAlias: id,
        Record: {
          type: 'object',
          properties: { id, label: { type: 'string' } },
          required: ['id', 'label'],
        },
      },
      parameters: {
        Id: {
          name: 'id',
          in: 'path',
          required: true,
          schema: { $ref: '#/components/schemas/IdAlias' },
        },
      },
    },
    paths: {
      '/entries/{id}': {
        post: {
          operationId: 'save',
          parameters: [
            ref('Id'),
            {
              name: 'recent',
              in: 'query',
              schema: { type: 'array', items: id },
            },
            {
              name: 'X-Mode',
              in: 'header',
              schema: { type: 'string', enum: ['save'], writeOnly: true },
            },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: recordRef } },
          },
          responses: {
            200: {
              description: 'Saved',
              content: { 'application/json': { schema: recordRef } },
            },
          },
        },
      },
    },
  };
  const options = { clients: ['reader'], surfaces: { reader: ['save'] } };
  const warnings: { path: string; message: string }[] = [];
  const originals = structuredClone(document);
  const root = await generatedTestWorkspace(
    t,
    await compile(document, {
      ...options,
      onWarning: (warning) => warnings.push(warning),
    }),
  );
  assert.deepEqual(document, originals);
  assert.equal(warnings.length, 2);
  assert.ok(
    warnings.some(
      ({ path, message }) =>
        path.endsWith('components.schemas.Id.readOnly') &&
        message.includes('readOnly: true has no effect'),
    ),
  );
  assert.ok(
    warnings.some(
      ({ path, message }) =>
        path.endsWith('parameters[2].schema.writeOnly') &&
        message.includes('writeOnly: true has no effect'),
    ),
  );
  const client = await importGenerated<RuntimeClient>(root, 'client.reader.ts');
  const operation = present(client.operations['save']);
  const input = {
    path: { id: 2 },
    query: { recent: [3, 4] },
    headers: { 'X-Mode': 'save' },
    body: { label: 'Entry' },
  };
  const request = operation.build(input);
  assert.equal(request.url, '/entries/2?recent=3&recent=4');
  assert.equal(request.headers['X-Mode'], 'save');
  assert.deepEqual(request.body, input.body);
  for (const invalid of [
    { path: { id: 0 } },
    { query: { recent: [0] } },
    { headers: { 'X-Mode': 'invalid' } },
    { body: { ...input.body, id: 2 } },
  ])
    assert.throws(
      () => operation.build({ ...input, ...invalid }),
      client.RequestValidationError,
    );
  assert.equal(
    operation.parseResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"label":"Entry"}',
    }).kind,
    'protocol',
  );
  const response = operation.parseResponse({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"id":2,"label":"Entry"}',
  });
  assert.equal(response.kind, 'success');
  if (response.kind === 'success')
    assert.deepEqual(response.data, { id: 2, label: 'Entry' });
  await assert.rejects(
    compile({ ...document, openapi: '3.1.2' }, options),
    /readOnly schemas may only be omitted as object properties/,
  );
  for (const [flags, message] of [
    [{ readOnly: 'yes' }, /readOnly.*expected a boolean/],
    [{ writeOnly: true }, /readOnly and writeOnly cannot both be true/],
  ] as const) {
    const invalid = structuredClone(document);
    Object.assign(invalid.components.schemas.Id, flags);
    await assert.rejects(compile(invalid, options), message);
  }
});

void test('single-branch unions retain scalar validation and wire forms in every parameter position', async (t) => {
  for (const keyword of ['anyOf', 'oneOf']) {
    const document = {
      openapi: '3.1.2',
      info: { title: 'Synthetic single-branch parameter unions', version: '1' },
      paths: {
        '/values/{id}': {
          get: {
            operationId: 'read',
            parameters: ['path', 'query', 'header'].map((position) => ({
              name: position === 'path' ? 'id' : position,
              in: position,
              required: position === 'path',
              schema: { [keyword]: [{ type: 'integer', minimum: 2 }] },
            })),
            responses: { 204: { description: 'Empty' } },
          },
        },
      },
    };
    const root = await generatedTestWorkspace(
      t,
      await compile(document, {
        clients: ['consumer'],
        surfaces: { consumer: ['read'] },
      }),
    );
    const client = await importGenerated<RuntimeClient>(
      root,
      'client.consumer.ts',
    );
    const operation = present(client.operations.read);
    const request = operation.build({
      path: { id: 2 },
      query: { query: 3 },
      headers: { header: 4 },
    });
    assert.equal(request.url, '/values/2?query=3');
    assert.equal(request.headers.header, '4');
    for (const invalid of [
      { path: { id: 1 } },
      { path: { id: 2 }, query: { query: 1 } },
      { path: { id: 2 }, headers: { header: 1 } },
    ])
      assert.throws(
        () => operation.build(invalid),
        client.RequestValidationError,
      );
  }
});

void test('nonnullable scalar path and query unions retain validation before serialization', async (t) => {
  const pathId = {
    anyOf: [
      { type: 'integer', minimum: 2 },
      { type: 'string', pattern: '^id/' },
    ],
  };
  const queryValue = {
    oneOf: [
      { type: 'string', minLength: 2 },
      { type: 'string', pattern: '^q-' },
      { type: 'boolean' },
    ],
  };
  const document = {
    openapi: '3.1.2',
    info: { title: 'Synthetic scalar union parameters', version: '1' },
    components: { schemas: { Id: pathId } },
    paths: {
      '/values/{id}': {
        get: {
          operationId: 'read',
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { $ref: '#/components/schemas/Id' },
            },
            { name: 'q', in: 'query', schema: queryValue },
          ],
          responses: { 204: { description: 'Empty' } },
        },
      },
    },
  };
  const options = { clients: ['consumer'], surfaces: { consumer: ['read'] } };
  const files = await compile(document, options);
  const root = await generatedTestWorkspace(t, files);
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const operation = present(client.operations.read);
  assert.equal(
    operation.build({ path: { id: 2 }, query: { q: false } }).url,
    '/values/2?q=false',
  );
  assert.equal(
    operation.build({ path: { id: 'id/a?b' }, query: { q: 'a& b' } }).url,
    '/values/id%2Fa%3Fb?q=a%26+b',
  );
  for (const input of [
    { path: { id: 1 } },
    { path: { id: '2' } },
    { path: { id: 2 }, query: { q: 'q-both' } },
    { path: { id: 2 }, query: { q: null } },
    { path: { id: 2 }, query: { q: [false] } },
  ])
    assert.throws(() => operation.build(input), client.RequestValidationError);

  const legacy = structuredClone(document);
  legacy.openapi = '3.0.4';
  Object.assign(legacy.components.schemas.Id, { readOnly: true });
  const warnings: string[] = [];
  assert.deepEqual(
    await compile(legacy, {
      ...options,
      onWarning: ({ message }) => warnings.push(message),
    }),
    files,
  );
  assert.ok(
    warnings.some((message) =>
      message.includes('readOnly: true has no effect'),
    ),
  );

  for (const branch of [
    { type: 'null' },
    { type: 'array', items: { type: 'string' } },
    { type: 'object', properties: { label: { type: 'string' } } },
  ]) {
    const rejected = structuredClone(document);
    Object.assign(rejected.paths['/values/{id}'].get.parameters[1]!.schema, {
      oneOf: [...queryValue.oneOf, branch],
    });
    await assert.rejects(
      compile(rejected, options),
      /parameters require primitive schemas/,
    );
  }
  const header = structuredClone(document);
  Object.assign(header.paths['/values/{id}'].get.parameters[1]!, {
    in: 'header',
  });
  await assert.rejects(
    compile(header, options),
    /parameters require primitive schemas/,
  );
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
  const staff = await importGenerated<RuntimeClient>(root, 'client.staff.ts');
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
    'semantic ref extension',
    (d) => {
      Object.assign(d.components.parameters.CursorAlias!, {
        'x-multi-segment': true,
      });
    },
    'components.parameters.CursorAlias.x-multi-segment',
    /unsupported semantic extension/,
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
        name: 'Host',
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
