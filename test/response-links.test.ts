import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient } from './runtime-types.ts';

const selection = {
  clients: ['api'],
  surfaces: { api: ['read'], other: ['next'] },
};
function fixture(openapi = '3.1.2') {
  return {
    openapi,
    info: { title: 'Synthetic response link metadata', version: '1' },
    components: {
      links: {
        Target: {
          operationId: 'next',
          parameters: {
            id: '$response.body#/id',
            'x-literal': { 'x-data': 1 },
          },
          requestBody: { source: '$request.body' },
          description: 'A relationship',
          server: {
            url: 'https://{region}.example.invalid',
            variables: { region: { default: 'demo', enum: ['demo'] } },
          },
        },
        Alias: { $ref: '#/components/links/Target' },
      },
    },
    paths: {
      '/read': {
        get: {
          operationId: 'read',
          responses: {
            200: {
              description: 'Read',
              content: { 'application/json': { schema: { type: 'integer' } } },
              links: {
                next: { $ref: '#/components/links/Alias' },
                external: {
                  operationRef:
                    'https://example.invalid/openapi.yaml#/paths/~1next/get',
                },
              },
            },
          },
        },
      },
      '/next': {
        get: {
          operationId: 'next',
          responses: { 204: { description: 'Next' } },
        },
      },
    },
  };
}

void test('response links and reusable aliases validate as metadata without changing generated clients', async (t) => {
  const plain = fixture();
  Reflect.deleteProperty(plain.paths['/read'].get.responses[200], 'links');
  Reflect.deleteProperty(plain.components, 'links');
  const expected = await compile(plain, selection);
  for (const version of ['3.0.4', '3.1.2']) {
    const source = fixture(version);
    const before = structuredClone(source);
    assert.deepEqual(await compile(source, selection), expected);
    assert.deepEqual(
      await compile(parseYaml(stringify(source), 'links.yaml'), selection),
      expected,
    );
    assert.deepEqual(source, before);
  }
  const root = await generatedTestWorkspace(t, expected);
  const client = await importGenerated<RuntimeClient>(root, 'client.api.ts');
  assert.deepEqual(Object.keys(client.operations), ['read']);
  const result = present(client.operations.read).parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: '2',
  });
  assert.equal(result.kind, 'success');
  assert.equal(result.data, 2);
});

void test('unused link definitions, missing references and cyclic aliases receive located diagnostics', async () => {
  const invalid: [unknown, RegExp][] = [
    [null, /expected an object/],
    [{}, /exactly one/],
    [
      { operationId: 'next', operationRef: '#/paths/~1next/get' },
      /exactly one/,
    ],
    [{ operationId: '' }, /nonempty string/],
    [{ operationRef: 2 }, /nonempty string/],
    [{ operationId: 'next', description: 2 }, /expected a string/],
    [{ operationId: 'next', parameters: [] }, /expected an object/],
    [
      { operationId: 'next', parameters: { id: undefined } },
      /expected an object/,
    ],
    [{ operationId: 'next', requestBody: { id: NaN } }, /finite JSON/],
    [{ operationId: 'next', server: { url: 2 } }, /expected a string/],
    [
      {
        operationId: 'next',
        server: {
          url: '/',
          variables: { region: { default: 'a', enum: ['b'] } },
        },
      },
      /member of enum/,
    ],
    [{ operationId: 'next', unknown: true }, /unsupported keyword/],
    [{ $ref: '#/components/links/Missing' }, /unresolved link reference/],
    [{ $ref: '#/components/links/Unused' }, /cyclic link reference/],
    [
      { $ref: 'https://example.invalid/link' },
      /only local component link references/,
    ],
  ];
  for (const [value, message] of invalid) {
    const source = fixture();
    Object.assign(source.components.links, { Unused: value });
    await assert.rejects(compile(source, selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.match(error.location, /^components\.links\.Unused/);
      assert.match(error.message, message);
      return true;
    });
  }
  for (const links of [
    null,
    { next: { $ref: '#/components/links/Missing' } },
    { 'bad name': { operationId: 'next' } },
  ]) {
    const source = fixture();
    Object.assign(source.paths['/read'].get.responses[200], { links });
    await assert.rejects(compile(source, selection), ContractError);
  }
});

void test('link extension traversal preserves parameter literals and observes dialect reference rules', async () => {
  const source = fixture();
  Object.assign(source.components.links.Target, { 'x-note': true });
  Object.assign(source.components.links.Target.server, { 'x-note': true });
  await assert.rejects(compile(source, selection), /ignoreExtensions/);
  assert.deepEqual(
    await compile(source, { ...selection, ignoreExtensions: ['x-note'] }),
    await compile(fixture(), selection),
  );
  for (const version of ['3.0.4', '3.1.2']) {
    const document = fixture(version);
    Object.assign(document.components.links.Alias, { description: 2 });
    if (version === '3.0.4') await compile(document, selection);
    else await assert.rejects(compile(document, selection), ContractError);
  }
});
