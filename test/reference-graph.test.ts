import assert from 'node:assert/strict';
import { symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import { buildDescriptor } from '../dist/descriptor.js';
import { entry } from './assertions.ts';
import { temporary } from './helpers.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { schemaFixture } from './schema-fixture.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

function forwardAliases() {
  const schemas: Record<string, Schema> = { Leaf: { type: 'string' } };
  for (let index = 0; index < 10000; index++)
    schemas[`Alias${String(index).padStart(5, '0')}`] = ref(
      index === 9999 ? 'Leaf' : `Alias${String(index + 1).padStart(5, '0')}`,
    );
  return schemas;
}

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

void test('long alias chains retain contextual restrictions on intermediate references', async () => {
  const schemas = forwardAliases();
  schemas.Alias05000 = {
    ...entry(schemas, 'Alias05000'),
    default: 'annotation',
  };
  await assert.rejects(
    compile(documentWith(schemas), {
      clients: [],
      standalone: {
        response: { schema: ref('Alias00000').$ref, usage: 'response' },
      },
    }),
    (error) =>
      error instanceof ContractError &&
      error.location.endsWith('components.schemas.Alias05000.default') &&
      /response schemas must not declare defaults/.test(error.message),
  );
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
