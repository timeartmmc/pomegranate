import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import type { CompileOptions } from '../dist/index.js';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

// Programmatic inputs are plain data: enumerability is not part of a contract.
function hidden<T extends object>(target: T, key: string, value: unknown): T {
  return Object.defineProperty(target, key, { value, enumerable: false });
}

const operation = {
  operationId: 'concealed',
  responses: { 204: { description: 'Synthetic bodyless response' } },
};

function document(openapi: string, schemas: Record<string, Schema>) {
  return {
    openapi,
    info: { title: 'Synthetic own-key contract', version: '1' },
    paths: {},
    components: { schemas },
  };
}

const standalone = (name: string): CompileOptions => ({
  clients: [],
  standalone: { value: { schema: ref(name).$ref, usage: 'request' } },
});

void test('own string keys are declarations whatever their enumerability', async (t) => {
  for (const openapi of ['3.0.4', '3.1.2']) {
    const schemas = hidden(
      {
        Composed: {
          allOf: [
            { type: 'object' },
            hidden({ properties: { id: { type: 'string' } } }, 'required', [
              'id',
            ]),
          ],
        },
        Fields: {
          type: 'object',
          properties: hidden({}, 'secret', { type: 'integer' }),
          required: ['secret'],
        },
        Alias: ref('Concealed'),
      },
      'Concealed',
      { type: 'string', minLength: 2 },
    );
    const source = hidden(document(openapi, schemas), 'paths', {});
    hidden(source.paths, '/concealed', { get: operation });
    // The hidden path's operation needs membership like any other operation.
    const root = await generatedTestWorkspace(
      t,
      await compile(source, {
        clients: ['api'],
        surfaces: { api: ['concealed'] },
        standalone: {
          composed: { schema: ref('Composed').$ref, usage: 'request' },
          fields: { schema: ref('Fields').$ref, usage: 'request' },
          alias: { schema: ref('Alias').$ref, usage: 'request' },
        },
      }),
    );
    const parse = async (name: string) =>
      (await importGenerated<StandaloneModule>(root, `standalone.${name}.ts`))
        .schema;
    const composed = await parse('composed');
    assert.equal(composed.safeParse({}).success, false, openapi);
    assert.deepEqual(composed.parse({ id: 'a' }), { id: 'a' });
    const fields = await parse('fields');
    assert.equal(fields.safeParse({ secret: 'text' }).success, false, openapi);
    assert.deepEqual(fields.parse({ secret: 1 }), { secret: 1 });
    const alias = await parse('alias');
    assert.equal(alias.safeParse('a').success, false, openapi);
    assert.equal(alias.parse('ab'), 'ab');
    const client = await importGenerated<RuntimeClient>(root, 'client.api.ts');
    assert.equal(
      present(client.operations.concealed).build({}).url,
      '/concealed',
    );
  }
});

void test('null-prototype inputs retain hidden security, selections and option diagnostics', async (t) => {
  for (const openapi of ['3.0.4', '3.1.2']) {
    const requirement = { Token: [] };
    Object.setPrototypeOf(requirement, null);
    hidden(requirement, 'Token', requirement.Token);
    const source = document(openapi, { Value: { type: 'string' } });
    Object.assign(source.paths, { '/concealed': { get: operation } });
    Object.assign(source.components, {
      securitySchemes: { Token: { type: 'http', scheme: 'bearer' } },
    });
    Object.assign(source, { security: [requirement] });
    const roots = {
      value: { schema: ref('Value').$ref, usage: 'request' as const },
    };
    Object.setPrototypeOf(roots, null);
    hidden(roots, 'value', roots.value);
    const options = {
      clients: ['api'],
      surfaces: { api: ['concealed'] },
      standalone: roots,
    };
    Object.setPrototypeOf(options, null);
    const root = await generatedTestWorkspace(
      t,
      await compile(source, options),
    );
    const client = await importGenerated<RuntimeClient>(root, 'client.api.ts');
    const security = present(client.operations.concealed).build({}).security;
    assert.ok(security.transport === 'bearer');
    assert.equal(security.scheme, 'Token');
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      'standalone.value.ts',
    );
    assert.equal(schema.parse('kept'), 'kept');
    hidden(options, 'unknownOption', true);
    await assert.rejects(compile(source, options), {
      name: 'ContractError',
      location: 'compile options.unknownOption',
    });
    assert.equal(
      Object.getOwnPropertyDescriptor(roots, 'value')?.enumerable,
      false,
    );
    assert.equal(
      Object.getOwnPropertyDescriptor(requirement, 'Token')?.enumerable,
      false,
    );
  }
});

void test('hidden unsupported keywords, extensions and options receive the usual diagnostics', async () => {
  const rejects = async (
    source: unknown,
    options: CompileOptions,
    location: string,
    message: RegExp,
  ) => {
    await assert.rejects(compile(source, options), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, location);
      assert.match(error.message, message);
      return true;
    });
  };
  for (const openapi of ['3.0.4', '3.1.2']) {
    await rejects(
      document(openapi, {
        Value: hidden({ type: 'object' }, 'patternProperties', {}),
      }),
      standalone('Value'),
      'components.schemas.Value.patternProperties',
      /unsupported keyword/,
    );
    const extended = () =>
      document(openapi, {
        Value: hidden({ type: 'string' }, 'x-internal', true),
      });
    await rejects(
      extended(),
      standalone('Value'),
      'components.schemas.Value.x-internal',
      /ignoreExtensions/,
    );
    await compile(extended(), {
      ...standalone('Value'),
      ignoreExtensions: ['x-internal'],
    });
    await rejects(
      document(openapi, { Value: { type: 'string' } }),
      hidden(standalone('Value'), 'unknownOption', true),
      'compile options.unknownOption',
      /unsupported keyword/,
    );
  }
});

void test('inherited keys never become declarations', async (t) => {
  const inherited = { minLength: 5, required: ['absent'] };
  for (const [name, value] of Object.entries(inherited))
    Object.defineProperty(Object.prototype, name, {
      value,
      configurable: true,
    });
  try {
    for (const openapi of ['3.0.4', '3.1.2']) {
      const files = await compile(
        document(openapi, {
          Value: { type: 'object', properties: { id: { type: 'string' } } },
        }),
        standalone('Value'),
      );
      const root = await generatedTestWorkspace(t, files);
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        'standalone.value.ts',
      );
      assert.deepEqual(schema.parse({ id: 'a' }), { id: 'a' });
      assert.deepEqual(schema.parse({}), {});
    }
  } finally {
    for (const name of Object.keys(inherited))
      Reflect.deleteProperty(Object.prototype, name);
  }
});
