import assert from 'node:assert/strict';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import { buildDescriptor } from '../dist/descriptor.js';
import { normalizeSchema, resolveSchema } from '../dist/schemas.js';
import { entry } from './assertions.ts';
import { generatedWorkspace } from './generated-workspace.ts';
import { temporary } from './helpers.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { schemaFixture } from './schema-fixture.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

function forwardAliases(count = 10000) {
  const schemas: Record<string, Schema> = { Leaf: { type: 'string' } };
  for (let index = 0; index < count; index++)
    schemas[`Alias${String(index).padStart(5, '0')}`] = ref(
      index === count - 1
        ? 'Leaf'
        : `Alias${String(index + 1).padStart(5, '0')}`,
    );
  return schemas;
}

void test('terminal resolution traverses shared aliases once per normalized table', () => {
  const descriptor = buildDescriptor(documentWith(forwardAliases(512)));
  const leaf = entry(descriptor.schemas.request, 'Leaf');
  let reads = 0;
  const schemas = new Proxy(descriptor.schemas.request, {
    get(target, key, receiver): unknown {
      reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  for (const schema of Object.values(descriptor.schemas.request))
    assert.equal(resolveSchema(schema, schemas), leaf);
  // Count table lookups rather than elapsed time: resolving each suffix must
  // take linear total work, including when aliases appear before their target.
  assert.ok(reads <= 512, `${reads} lookups for 512 aliases`);
});

void test('terminal resolution separates tables even for the same reference node', () => {
  const reference = normalizeSchema(ref('Leaf'), 'shared.$ref');
  const text = buildDescriptor(documentWith({ Leaf: { type: 'string' } }));
  const list = buildDescriptor(
    documentWith({ Leaf: { type: 'array', items: { type: 'integer' } } }),
  );
  assert.equal(resolveSchema(reference, text.schemas.request).kind, 'string');
  assert.equal(resolveSchema(reference, list.schemas.request).kind, 'array');
  assert.equal(resolveSchema(reference, text.schemas.request).kind, 'string');
});

void test('recompiling mutable input preserves alias siblings and specialized array validation', async (t) => {
  const document = documentWith({
    Root: { ...ref('Middle'), maxLength: 3 },
    Middle: { ...ref('Leaf'), minLength: 2 },
    Leaf: { type: 'string', pattern: '^[a-z]+$' },
  });
  const selection = {
    clients: [],
    standalone: { input: { schema: ref('Root').$ref, usage: 'request' } },
  } as const;
  const textFiles = await compile(document, selection);
  Object.assign(document.components, {
    schemas: {
      Root: { ...ref('Middle'), maxItems: 3 },
      Middle: { ...ref('Leaf'), minItems: 2 },
      Leaf: { type: 'array', items: { type: 'integer', minimum: 1 } },
    },
  });
  const arrayFiles = await compile(document, selection);
  for (const [files, accepted, rejected] of [
    [textFiles, 'abc', ['a', 'abcd', 'AB', [1, 2]]],
    [arrayFiles, [1, 2], [[1], [1, 2, 3, 4], [0, 2], 'ab']],
  ] as const) {
    const root = await generatedWorkspace(files);
    t.after(() => rm(root, { recursive: true, force: true }));
    const { schema } = (await import(
      pathToFileURL(join(root, 'standalone.input.ts')).href
    )) as StandaloneModule;
    assert.deepEqual(schema.parse(accepted), accepted);
    for (const value of rejected)
      assert.equal(schema.safeParse(value).success, false);
  }
});

function documentWith(schemas: Record<string, Schema>) {
  const document = schemaFixture();
  document.paths = {};
  Object.assign(document.components, { schemas });
  return document;
}

void test('forward reference graphs compile independently of alias depth and execute in both directions', async (t) => {
  const document = documentWith(forwardAliases());
  const leaf = await compile(document, {
    clients: [],
    standalone: { leaf: { schema: ref('Leaf').$ref, usage: 'request' } },
  });
  assert.deepEqual(Object.keys(leaf).sort(), [
    'policy-types.ts',
    'runtime.ts',
    'standalone.leaf.ts',
  ]);
  const outputs = await compile(document, {
    clients: [],
    standalone: {
      request: { schema: ref('Alias00000').$ref, usage: 'request' },
      response: { schema: ref('Alias00000').$ref, usage: 'response' },
    },
  });
  const root = await temporary(t);
  await symlink(
    join(repo, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  for (const [name, source] of Object.entries(outputs))
    await writeFile(join(root, name), source);
  for (const direction of ['request', 'response']) {
    const { schema } = (await import(
      pathToFileURL(join(root, `standalone.${direction}.ts`)).href
    )) as StandaloneModule;
    assert.equal(schema.parse('value'), 'value');
    assert.equal(schema.safeParse(123).success, false);
  }
});

void test('long alias chains ignore defaults on intermediate references', async () => {
  const schemas = forwardAliases();
  schemas.Alias05000 = {
    ...entry(schemas, 'Alias05000'),
    default: 'annotation',
  };
  const selection = {
    clients: [],
    standalone: {
      response: { schema: ref('Alias00000').$ref, usage: 'response' },
    },
  } as const;
  const expected = await compile(documentWith(forwardAliases()), selection);
  assert.deepEqual(await compile(documentWith(schemas), selection), expected);
});

void test('deep reference graphs retain exact cycle and missing-reference locations', async () => {
  for (const [target, location, message] of [
    ['Alias00000', 'components.schemas.Leaf.$ref', /recursive schemas/],
    ['Missing', 'components.schemas.Leaf.$ref', /unresolved reference Missing/],
  ] satisfies [string, string, RegExp][]) {
    const schemas = forwardAliases();
    schemas.Leaf = ref(target);
    await assert.rejects(
      compile(documentWith(schemas), {
        clients: [],
        standalone: { leaf: { schema: ref('Leaf').$ref, usage: 'request' } },
      }),
      (error) =>
        error instanceof ContractError &&
        error.location === location &&
        message.test(error.message),
    );
  }
});

void test('schema ordering keeps dependencies before their users across shared branches', () => {
  const descriptor = buildDescriptor(
    documentWith({
      Root: {
        type: 'object',
        properties: { left: ref('Left'), right: ref('Right') },
      },
      Right: ref('Leaf'),
      Left: ref('Leaf'),
      Leaf: { type: 'string' },
    }),
  );
  assert.deepEqual(descriptor.schemaOrder, ['Leaf', 'Left', 'Right', 'Root']);
});

for (const [name, media, field, expectedError] of [
  [
    'shared schemas with default annotations remain valid in requests and responses',
    'application/json',
    { type: 'string', default: 'annotation' },
    undefined,
  ],
  [
    'shared schemas allow binary fields only in multipart requests',
    'multipart/form-data',
    { type: 'string', format: 'binary' },
    /binary values are only supported in multipart/,
  ],
] satisfies [string, string, Schema, RegExp | undefined][]) {
  void test(name, async () => {
    const document = documentWith({
      Shared: {
        type: 'object',
        properties: { value: field },
        required: ['value'],
      },
    });
    const operation = {
      operationId: 'shared',
      'x-pom': {
        auth: 'public',
        retry: 'never',
        timeout: 'interactive',
        surfaces: ['samples'],
      },
      requestBody: {
        required: true,
        content: { [media]: { schema: ref('Shared') } },
      },
      responses: {
        200: {
          description: 'Success',
          content: { 'application/json': { schema: { type: 'string' } } },
        },
      },
    };
    Object.assign(document.paths, { '/shared': { post: operation } });
    const selection = {
      clients: ['samples'],
      targets: { samples: 'native' },
    } as const;
    await compile(document, selection);
    Object.assign(operation.responses[200].content['application/json'], {
      schema: ref('Shared'),
    });
    if (expectedError === undefined) await compile(document, selection);
    else
      await assert.rejects(
        compile(document, selection),
        (error) =>
          error instanceof ContractError &&
          error.location.includes('responses.200') &&
          expectedError.test(error.message),
      );
  });
}
