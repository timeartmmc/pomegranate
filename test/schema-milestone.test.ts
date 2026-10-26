import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import { entry, invalidOptions, json, present, record } from './assertions.ts';
import type { StandaloneModule } from './runtime-types.ts';
import {
  schemaFixture,
  verifySchemas,
  standaloneSelection,
  verifyStandalone,
} from './schema-fixture.ts';
import type { Schema } from './schema-helpers.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
void test('generated schema milestone preserves request, response and TypeScript contracts', async (t) => {
  const cache = join(repo, 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, 'pom-schemas-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'schema-generated'));
  for (const [name, source] of Object.entries(
    await compile(schemaFixture(), {
      clients: ['samples'],
      transportHeaders: ['X-Origin'],
      standalone: {
        ...standaloneSelection,
        empty: { schema: '#/components/schemas/Empty', usage: 'request' },
      },
    }),
  ))
    await writeFile(join(root, 'schema-generated', name), source);
  for (const [label, schema] of [
    ['map', { type: 'object', additionalProperties: true }],
    ['date', { type: 'string', format: 'date-time' }],
    ['uuid', { type: 'string', format: 'uuid' }],
  ] satisfies [string, Schema][]) {
    const document = schemaFixture();
    Object.assign(document.components, { schemas: { JsonMap: schema } });
    Object.assign(document, {
      paths: {
        '/samples/JsonMap': entry(document.paths, '/samples/JsonMap'),
      },
    });
    await mkdir(join(root, `${label}-generated`));
    for (const [name, source] of Object.entries(
      await compile(document, { clients: ['samples'] }),
    ))
      await writeFile(join(root, `${label}-generated`, name), source);
  }
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const config = record(
    json(await readFile(join(repo, 'examples/json/tsconfig.json'), 'utf8')),
  );
  config.include = ['*.ts', '*-generated/*.ts'];
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify(config));
  await cp(join(repo, 'test/schema-types.ts'), join(root, 'schema-types.ts'));
  await promisify(execFile)(process.execPath, [
    join(repo, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
  const { operations, RequestValidationError } = (await import(
    pathToFileURL(join(root, '.build/schema-generated/client.samples.js')).href
  )) as typeof import('./.generated/schema/client.samples.ts');
  verifySchemas(operations, RequestValidationError);
  const message = (await import(
    pathToFileURL(join(root, '.build/schema-generated/standalone.message.js'))
      .href
  )) as StandaloneModule;
  const input = (await import(
    pathToFileURL(join(root, '.build/schema-generated/standalone.input.js'))
      .href
  )) as StandaloneModule;
  verifyStandalone(message.schema, input.schema);
  const empty = (await import(
    pathToFileURL(join(root, '.build/schema-generated/standalone.empty.js'))
      .href
  )) as StandaloneModule;
  assert.deepEqual(empty.schema.parse({}), {});
  assert.equal(empty.schema.safeParse(42).success, false);
});

void test('standalone-only generation retains transitive schemas without HTTP clients', async () => {
  const document = schemaFixture();
  document.paths = {};
  const outputs = await compile(document, {
    clients: [],
    standalone: standaloneSelection,
  });
  assert.deepEqual(Object.keys(outputs).sort(), [
    'runtime.ts',
    'standalone.input.ts',
    'standalone.message.ts',
  ]);
  assert.doesNotMatch(
    present(outputs['standalone.message.ts']),
    /client\.|requestSchemas|checkScalars/,
  );
  await assert.rejects(compile(document, { clients: [] }), /nonempty/);
});

void test('standalone roots validate names, references, direction and response defaults', async () => {
  for (const standalone of [
    {
      '../escape': { schema: '#/components/schemas/Shape', usage: 'response' },
    },
    { message: { schema: '#/components/schemas/Missing', usage: 'response' } },
    { message: { schema: '#/components/schemas/Defaults', usage: 'response' } },
    { message: { schema: '#/components/schemas/Shape', usage: 'either' } },
  ])
    await assert.rejects(
      invalidOptions(compile, schemaFixture(), { clients: [], standalone }),
      ContractError,
    );
  const document = schemaFixture();
  Object.assign(entry(document.paths, '/samples/Shape'), {
    trace: entry(document.paths, '/samples/Shape').post,
  });
  await assert.rejects(
    compile(document, { clients: [], standalone: standaloneSelection }),
    /trace.*unsupported/,
  );
});

void test('component names and references reject invalid characters and reserved keys', async () => {
  for (const name of [
    '',
    'Bad Name',
    'Bad/Name',
    'Bad~Name',
    'Bad%2EName',
    'Bad\n',
    'é',
    '__proto__',
    'prototype',
    'constructor',
  ]) {
    const document = schemaFixture();
    document.components.schemas = {
      ...document.components.schemas,
      [name]: { type: 'string' },
    };
    await assert.rejects(
      compile(document, { clients: ['samples'] }),
      (error) =>
        error instanceof ContractError &&
        error.location === `components.schemas.${name}`,
    );
  }
  for (const name of ['Shape/Circle', 'Shape%2ECircle', 'Shape~1Circle']) {
    const document = schemaFixture();
    Object.assign(document.components.schemas, {
      Broken: {
        $ref: `#/components/schemas/${name}`,
      },
    });
    await assert.rejects(
      compile(document, { clients: ['samples'] }),
      (error) =>
        error instanceof ContractError &&
        error.location === 'components.schemas.Broken.$ref' &&
        /component schema names/.test(error.message),
    );
  }
  const document = schemaFixture();
  Object.assign(document.components.schemas, {
    '3.Missing-Ref': {
      $ref: '#/components/schemas/4.Unknown',
    },
  });
  await assert.rejects(
    compile(document, { clients: ['samples'] }),
    (error) =>
      error instanceof ContractError &&
      error.location === 'components.schemas.3.Missing-Ref.$ref' &&
      /unresolved reference 4.Unknown/.test(error.message),
  );
});

void test('shared schema DAGs do not expand exponentially before client selection', async () => {
  await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {compile} from './dist/index.js';
    import {fixture} from './test/helpers.ts';
    const document=fixture();
    document.components.schemas.Layer0={type:'string'};
    for(let index=1;index<=30;index++) {
      const ref={$ref:'#/components/schemas/Layer'+(index-1)};
      document.components.schemas['Layer'+index]={type:'object',properties:{left:ref,right:ref},required:['left','right']};
    }
    document.paths['/api/staff/reports'].get.responses[200].content={'application/json':{schema:{$ref:'#/components/schemas/Layer30'}}};
    await compile(document,{clients:['consumer']});
  `,
    ],
    { cwd: repo, timeout: 5000 },
  );
});

for (const [schema, suffix] of [
  [
    {
      type: 'object',
      properties: { owner: { $ref: '#/components/schemas/Missing' } },
    },
    'properties.owner.$ref',
  ],
  [
    { type: 'array', items: { $ref: '#/components/schemas/Missing' } },
    'items.$ref',
  ],
  [
    {
      type: 'object',
      additionalProperties: { $ref: '#/components/schemas/Missing' },
    },
    'additionalProperties.$ref',
  ],
  [
    { anyOf: [{ type: 'null' }, { $ref: '#/components/schemas/Missing' }] },
    'anyOf[1].$ref',
  ],
] satisfies [Schema, string][])
  void test(`missing references identify their source at ${suffix}`, async () => {
    const document = schemaFixture();
    Object.assign(document.components.schemas, { Broken: schema });
    await assert.rejects(
      compile(document, { clients: ['samples'] }),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.equal(error.location, `components.schemas.Broken.${suffix}`);
        assert.match(error.message, /unresolved reference Missing/);
        return true;
      },
    );
  });

void test('missing inline references identify their operation source', async () => {
  const document = schemaFixture();
  entry(document.paths, '/samples/Shape').post.responses[200].content[
    'application/json'
  ].schema = {
    type: 'object',
    properties: { owner: { $ref: '#/components/schemas/Missing' } },
  };
  await assert.rejects(compile(document, { clients: ['samples'] }), {
    location:
      'paths./samples/Shape.post.responses.200.content.application/json.schema.properties.owner.$ref',
  });
});

void test('duplicate operation identifiers identify both declarations', async () => {
  const document = schemaFixture();
  entry(document.paths, '/samples/Shape').post.operationId = 'checkScalars';
  await assert.rejects(compile(document, { clients: ['samples'] }), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, 'paths./samples/Shape.post.operationId');
    assert.match(
      error.message,
      /first declared at paths\.\/samples\/Scalars\.post\.operationId/,
    );
    return true;
  });
});

for (const [name, mutate, pattern] of [
  [
    'non-exploded query arrays',
    (d) => {
      Object.assign(
        present(entry(d.paths, '/samples/Scalars').post.parameters[1]),
        { explode: false },
      );
    },
    /explode.*query arrays require/,
  ],
  [
    'required nullable headers',
    (d) => {
      Object.assign(
        present(entry(d.paths, '/samples/Scalars').post.parameters[2]),
        { required: true },
      );
    },
    /required.*nullable headers must be optional/,
  ],
  [
    'object query array items',
    (d) => {
      Object.assign(
        present(entry(d.paths, '/samples/Scalars').post.parameters[1]).schema,
        {
          items: {
            type: 'object',
          },
        },
      );
    },
    /parameters require primitive/,
  ],
  [
    'empty numeric interval',
    (d) => {
      Object.assign(d.components.schemas.Circle.properties.radius, {
        maximum: 0,
      });
    },
    /number bounds admit no finite number/,
  ],
  [
    'malformed regex',
    (d) => {
      Object.assign(d.components.schemas.Label, { pattern: '[' });
    },
    /pattern.*valid Unicode/,
  ],
  [
    'unknown format',
    (d) => {
      Object.assign(d.components.schemas.Label, { format: 'custom' });
    },
    /unsupported format/,
  ],
  [
    'nonpositive multiple',
    (d) => {
      d.components.schemas.Circle.properties.radius.multipleOf = 0;
    },
    /multipleOf.*positive/,
  ],
  [
    'boolean exclusive bound',
    (d) => {
      Object.assign(d.components.schemas.Circle.properties.radius, {
        exclusiveMinimum: true,
      });
    },
    /exclusiveMinimum.*finite number/,
  ],
  [
    'missing union tag',
    (d) => {
      d.components.schemas.Circle.required = ['radius'];
    },
    /required tag/,
  ],
  [
    'wrong discriminator mapping',
    (d) => {
      d.components.schemas.Shape.discriminator.mapping.circle =
        '#/components/schemas/Rectangle';
    },
    /cover every distinct/,
  ],
  [
    'wrong branch literal',
    (d) => {
      d.components.schemas.Circle.properties.kind.const = 'wrong';
    },
    /tag must match/,
  ],
  [
    'unconstrained oneOf',
    (d) => {
      Reflect.deleteProperty(d.components.schemas.Shape, 'discriminator');
    },
    /discriminator/,
  ],
  [
    'overlapping anyOf',
    (d) => {
      Object.assign(d.components.schemas.Location, {
        items: {
          anyOf: [{ type: 'number' }, { type: 'integer' }],
        },
      });
    },
    /supported anyOf/,
  ],
  [
    'map recursive reference',
    (d) => {
      d.components.schemas.ShapeMap.additionalProperties = {
        $ref: '#/components/schemas/ShapeMap',
      };
    },
    /recursive/,
  ],
  [
    'unselected invalid schema',
    (d) => {
      Object.assign(d.components.schemas, {
        Unused: { type: 'string', pattern: '[' },
      });
    },
    /Unused.pattern/,
  ],
  [
    'response defaults through maps and unions',
    (d) => {
      Object.assign(d.components.schemas.Circle.properties.radius, {
        default: 1,
      });
    },
    /default.*response schemas/,
  ],
  [
    'reference sibling type mismatch',
    (d) => {
      Object.assign(d.components.schemas.ShortLabel, { minimum: 1 });
    },
    /minimum.*referenced string/,
  ],
  [
    'mixed map and fixed properties',
    (d) => {
      Object.assign(d.components.schemas.ShapeMap, {
        properties: { fixed: { type: 'string' } },
      });
    },
    /mixed fixed/,
  ],
] satisfies [string, (d: ReturnType<typeof schemaFixture>) => void, RegExp][])
  void test(`schema milestone rejects ${name}`, async () => {
    const document = schemaFixture();
    mutate(document);
    await assert.rejects(
      compile(document, { clients: ['samples'] }),
      (error) => error instanceof ContractError && pattern.test(error.message),
    );
  });

void test('nullable queries reject required presence and non-primitive forms', async () => {
  for (const name of [
    'q',
    'cursor',
    'count',
    'ratio',
    'active',
    'date',
    'instant',
    'id',
  ]) {
    const document = schemaFixture();
    Object.assign(
      present(
        entry(document.paths, '/samples/Scalars').post.parameters.find(
          (p) => p.name === name,
        ),
      ),
      { required: true },
    );
    await assert.rejects(
      compile(document, { clients: ['samples'] }),
      /required.*nullable query parameters must be optional/,
    );
  }
  for (const schema of [
    { type: 'null' },
    { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] },
    {
      anyOf: [
        { type: 'object', properties: { value: { type: 'string' } } },
        { type: 'null' },
      ],
    },
    { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
  ]) {
    const document = schemaFixture();
    Object.assign(
      present(
        entry(document.paths, '/samples/Scalars').post.parameters.find(
          (p) => p.name === 'q',
        ),
      ),
      { schema },
    );
    await assert.rejects(
      compile(document, { clients: ['samples'] }),
      /parameters require primitive/,
    );
  }
  const document = schemaFixture();
  const operation = entry(document.paths, '/samples/Scalars').post;
  const pathParameter = present(
    operation.parameters.find((p) => p.name === 'q'),
  );
  pathParameter.in = 'path';
  Object.assign(pathParameter, { required: true });
  Reflect.deleteProperty(document.paths, '/samples/Scalars');
  Object.assign(document.paths, { '/samples/{q}': { post: operation } });
  await assert.rejects(
    compile(document, { clients: ['samples'] }),
    /parameters require primitive/,
  );
});

void test('transport header selections reject unknown, invalid and duplicate names', async () => {
  for (const transportHeaders of [
    ['Unknown'],
    ['X-Origin', 'x-origin'],
    'X-Origin',
    [''],
    ['X Origin'],
  ])
    await assert.rejects(
      invalidOptions(compile, schemaFixture(), {
        clients: ['samples'],
        transportHeaders,
      }),
      /transportHeaders/,
    );
  const document = schemaFixture();
  Object.assign(document.paths, {
    '/key': {
      get: {
        operationId: 'key',
        'x-pom': {
          auth: 'public',
          retry: 'never',
          timeout: 'interactive',
          surfaces: ['samples'],
        },
        parameters: [
          {
            name: 'X-Key',
            in: 'header',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: { 204: { description: 'No content' } },
      },
    },
  });
  // Unicode case folding is broader than HTTP's ASCII case insensitivity.
  await assert.rejects(
    compile(document, { clients: ['samples'], transportHeaders: ['X-Key'] }),
    /transportHeaders/,
  );
  assert.deepEqual(
    await compile(document, {
      clients: ['samples'],
      transportHeaders: ['X-Key'],
    }),
    await compile(document, {
      clients: ['samples'],
      transportHeaders: ['x-key'],
    }),
  );
});
