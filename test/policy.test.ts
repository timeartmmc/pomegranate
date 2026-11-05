import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import { buildDescriptor } from '../dist/descriptor.js';
import { present, record } from './assertions.ts';
import { temporary } from './helpers.ts';

function document(declaration: unknown, metadata: unknown) {
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic policy', version: '1' },
    'x-pom-policy': declaration,
    paths: {
      '/read': {
        get: {
          operationId: 'read',
          'x-pom': metadata,
          responses: { 204: { description: 'Read' } },
        },
      },
    },
  };
}
function vocabulary(
  fields: Record<string, unknown> = {},
  required: string[] = [],
) {
  return { version: 3, fields, required, surfaces: ['consumer', 'internal'] };
}
const selected = { clients: ['consumer'] };
const membership = { surfaces: ['consumer'] };

void test('policy declarations and metadata are optional without inferred application labels', async (t) => {
  const input = {
    openapi: '3.1.0',
    info: { title: 'Synthetic plain policy', version: '1' },
    paths: {
      '/read': {
        get: {
          operationId: 'read',
          responses: { 204: { description: 'Read' } },
        },
      },
    },
  };
  const before = structuredClone(input);
  const files = await compile(input, {
    clients: ['consumer'],
    surfaces: { consumer: ['read'] },
  });
  assert.deepEqual(input, before);
  const root = await temporary(t);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries(files))
    await writeFile(join(root, name), source);
  const entry: unknown = await import(
    pathToFileURL(join(root, 'client.consumer.ts')).href
  );
  const operations = record(record(entry).operations);
  const read = record(operations.read);
  const build = read.build;
  assert.equal(typeof build, 'function');
  assert.ok(typeof build === 'function');
  const request = record((build as () => unknown)());
  assert.deepEqual(request.policy, {});
  assert.deepEqual(request.security, { transport: 'none' });
  assert.ok(Object.isFrozen(request.policy));
  assert.ok(Object.isFrozen(request.security));
});

void test('flat declared metadata preserves scalar values and omits optional fields', () => {
  const input = document(
    vocabulary(
      {
        label: { type: 'string', enum: ['', 'session'] },
        audit: { type: 'boolean' },
        fraction: { type: 'number', enum: [0.5, 1] },
        attempts: { type: 'integer', enum: [0, 2] },
        empty: { type: 'null' },
        security: { type: 'boolean' },
        optional: { type: 'string' },
      },
      ['label', 'audit', 'fraction', 'attempts', 'empty'],
    ),
    {
      ...membership,
      label: '',
      audit: false,
      fraction: 0.5,
      attempts: 2,
      empty: null,
      security: true,
    },
  );
  const operation = present(buildDescriptor(input).operations[0]);
  assert.deepEqual(operation.policy, {
    attempts: 2,
    audit: false,
    empty: null,
    fraction: 0.5,
    label: '',
    security: true,
  });
  assert.deepEqual(operation.security, { transport: 'none' });
  assert.equal(Object.hasOwn(operation.policy, 'optional'), false);
});

for (const [name, fields, required, metadata] of [
  ['unknown field', {}, [], { accidental: true }],
  ['missing required field', { note: { type: 'string' } }, ['note'], {}],
  ['wrong scalar type', { audit: { type: 'boolean' } }, [], { audit: 'true' }],
  [
    'wrong enum label',
    { retry: { type: 'string', enum: ['never'] } },
    [],
    { retry: 'always' },
  ],
  [
    'undefined optional field',
    { audit: { type: 'boolean' } },
    [],
    { audit: undefined },
  ],
  ['null string field', { note: { type: 'string' } }, [], { note: null }],
  [
    'fractional integer',
    { attempts: { type: 'integer' } },
    [],
    { attempts: 1.5 },
  ],
  ['nonfinite number', { count: { type: 'number' } }, [], { count: Infinity }],
] satisfies [
  string,
  Record<string, unknown>,
  string[],
  Record<string, unknown>,
][]) {
  void test(`policy rejects ${name} before selecting operations`, async () => {
    const input = document(vocabulary(fields, required), {
      ...membership,
      ...metadata,
    });
    const before = structuredClone(input);
    await assert.rejects(compile(input, selected), ContractError);
    assert.deepEqual(input, before);
  });
}

for (const [name, field] of [
  ['nested object', { type: 'object', properties: {} }],
  ['array', { type: 'array', items: { type: 'string' } }],
  ['reference', { $ref: '#/components/schemas/Policy' }],
  ['default', { type: 'string', default: 'fallback' }],
  ['numeric bound', { type: 'integer', minimum: 0 }],
  ['pattern', { type: 'string', pattern: '^\\p{Letter}+$' }],
  ['mixed enum', { type: 'string', enum: ['valid', null] }],
  ['duplicate enum', { type: 'string', enum: ['same', 'same'] }],
  ['empty enum', { type: 'string', enum: [] }],
  ['sparse enum', { type: 'string', enum: Array<unknown>(1) }],
] satisfies [string, unknown][]) {
  void test(`policy diagnoses unsupported or invalid ${name} declarations`, async () => {
    await assert.rejects(
      compile(document(vocabulary({ mode: field }), membership), selected),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.match(error.location, /^x-pom-policy.fields.mode/);
        return true;
      },
    );
  });
}

for (const field of [
  'auth',
  'surfaces',
  '__proto__',
  'constructor',
  'toString',
]) {
  void test(`policy field ${field} cannot create another owner or unsafe object key`, async () => {
    const fields = Object.fromEntries([[field, { type: 'string' }]]);
    await assert.rejects(
      compile(document(vocabulary(fields), membership), selected),
      ContractError,
    );
  });
}

void test('the previous policy version receives a migration diagnostic', async () => {
  await assert.rejects(
    compile(
      document(
        {
          version: 2,
          auth: { public: { transport: 'none' } },
          retry: ['never'],
          timeout: ['interactive'],
          surfaces: ['consumer'],
        },
        {
          ...membership,
          auth: 'public',
          retry: 'never',
          timeout: 'interactive',
        },
      ),
      selected,
    ),
    {
      name: 'ContractError',
      location: 'x-pom-policy.version',
      message: 'x-pom-policy.version: expected policy version 3',
    },
  );
});

void test('policy required declarations reject holes, duplicates and undeclared names', async () => {
  for (const required of [Array<unknown>(1), ['missing'], ['note', 'note']]) {
    const declaration = {
      ...vocabulary({ note: { type: 'string' } }),
      required,
    };
    await assert.rejects(
      compile(document(declaration, membership), selected),
      ContractError,
    );
  }
});

void test('optional auth binding preserves explicit readiness labels and transport agreement', async () => {
  const declaration = {
    ...vocabulary({}, ['auth']),
    auth: {
      public: { transport: 'none' },
      session: { transport: 'bearer' },
      staff: { transport: 'bearer' },
    },
  };
  for (const label of ['session', 'staff']) {
    const input = document(declaration, { ...membership, auth: label });
    Object.assign(input, {
      components: {
        securitySchemes: { Token: { type: 'http', scheme: 'bearer' } },
      },
      security: [{ Token: [] }],
    });
    const operation = present(buildDescriptor(input).operations[0]);
    assert.equal(operation.policy.auth, label);
    assert.deepEqual(operation.security, {
      transport: 'bearer',
      scheme: 'Token',
    });
    Object.assign(input.paths['/read'].get, { security: [] });
    await assert.rejects(
      compile(input, selected),
      /requires bearer transport.*requires none/,
    );
  }
  await assert.rejects(
    compile(document(declaration, membership), selected),
    ContractError,
  );
  const optional = { ...declaration, required: [] };
  assert.deepEqual(
    present(buildDescriptor(document(optional, membership)).operations[0])
      .policy,
    {},
  );
});

void test('invalid metadata on an unselected operation still fails generation', async () => {
  const input = document(
    vocabulary({ mode: { type: 'string', enum: ['allowed'] } }),
    membership,
  );
  Object.assign(input.paths, {
    '/internal': {
      get: {
        operationId: 'internal',
        'x-pom': { surfaces: ['internal'], mode: 'unknown' },
        responses: { 204: { description: 'Internal' } },
      },
    },
  });
  await assert.rejects(compile(input, selected), (error) => {
    assert.ok(error instanceof ContractError);
    assert.match(error.location, /paths.\/internal.get.x-pom.mode/);
    return true;
  });
});

void test('declaration and metadata ordering do not change complete generated bytes', async () => {
  const fields = {
    audit: { type: 'boolean' },
    mode: { type: 'string', enum: ['b', 'a'] },
  };
  const first = document(vocabulary(fields, ['mode', 'audit']), {
    ...membership,
    mode: 'a',
    audit: false,
  });
  const second = document(
    vocabulary({ mode: fields.mode, audit: fields.audit }, ['audit', 'mode']),
    { audit: false, mode: 'a', ...membership },
  );
  assert.deepEqual(
    await compile(first, selected),
    await compile(second, selected),
  );
});

void test('literal replacement tokens survive policy field names, labels, declarations and runtime values', async (t) => {
  const root = await temporary(t);
  const tokens = ['$$', '$&', '$`', "$'"];
  const fields = Object.fromEntries(
    tokens.map((token) => [token, { type: 'string', enum: tokens }]),
  );
  const input = document(
    {
      ...vocabulary(fields, ['auth', ...tokens]),
      auth: Object.fromEntries(
        tokens.map((token) => [token, { transport: 'none' }]),
      ),
    },
    {
      ...membership,
      auth: '$$',
      ...Object.fromEntries(tokens.map((token) => [token, token])),
    },
  );
  const files = await compile(input, selected);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries(files))
    await writeFile(join(root, name), source);
  const entry: unknown = await import(
    pathToFileURL(join(root, 'client.consumer.ts')).href
  );
  const build = record(record(record(entry).operations).read).build;
  assert.ok(typeof build === 'function');
  const policy = record(record((build as () => unknown)()).policy);
  assert.deepEqual(policy, {
    auth: '$$',
    ...Object.fromEntries(tokens.map((token) => [token, token])),
  });
  const union = tokens.map((token) => JSON.stringify(token)).join(' | ');
  const checks = tokens
    .map(
      (token, index) =>
        `const field${index}: ${union} = request.policy[${JSON.stringify(token)}]; void field${index};`,
    )
    .join('\n');
  await writeFile(
    join(root, 'policy-consumer.ts'),
    `import {operations} from './client.consumer.ts'; const request=operations.read.build(); const auth: ${union}=request.policy.auth; void auth; ${checks}`,
  );
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        types: [],
        lib: ['ES2022', 'DOM'],
      },
      include: ['*.ts'],
    }),
  );
  await promisify(execFile)(process.execPath, [
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
});
