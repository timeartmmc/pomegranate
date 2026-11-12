import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import { buildDescriptor } from '../dist/descriptor.js';
import { parseYaml } from '../dist/yaml.js';
import { json, present, record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import type { RuntimeClient } from './runtime-types.ts';

function fixture(
  version: string,
  order: readonly string[],
  referenced = false,
) {
  const body = {
    required: true,
    content: { 'application/json': { schema: { type: 'string' } } },
  };
  const operation = {
    requestBody: referenced
      ? { $ref: '#/components/requestBodies/Alias' }
      : body,
    responses: {
      200: {
        description: 'Echo',
        content: { 'application/json': { schema: { type: 'string' } } },
      },
    },
  };
  return {
    openapi: version,
    info: { title: 'Synthetic shared operation methods', version: '1' },
    components: {
      requestBodies: {
        Body: body,
        Alias: { $ref: '#/components/requestBodies/Body' },
      },
    },
    paths: {
      '/shared': Object.fromEntries(order.map((method) => [method, operation])),
    },
  };
}

function inputs(document: ReturnType<typeof fixture>): [string, unknown][] {
  const yaml = parseYaml(stringify(document), 'shared.yaml');
  const item = record(record(record(yaml).paths)['/shared']);
  // Ensure this case exercises shared identity rather than only expanded YAML.
  const [first, second] = Object.values(item);
  assert.equal(first, second);
  return [
    ['shared object', document],
    ['YAML alias', yaml],
    ['expanded JSON', json(JSON.stringify(document))],
  ];
}

for (const method of ['delete', 'options'] as const) {
  const orders = [
    ['post', method],
    [method, 'post'],
  ] as const;
  const selection = {
    clients: ['api'],
    surfaces: { api: ['POST /shared', `${method.toUpperCase()} /shared`] },
  };
  void test(`OpenAPI 3.0 and 3.1 permit shared POST and ${method.toUpperCase()} bodies without losing either binding`, async (t) => {
    const expected = await compile(
      json(JSON.stringify(fixture('3.1.2', orders[0]))),
      selection,
    );
    for (const version of ['3.0.0', '3.0.4', '3.1.2'])
      for (const order of orders)
        for (const referenced of [false, true])
          for (const [encoding, input] of inputs(
            fixture(version, order, referenced),
          )) {
            const before = structuredClone(input);
            assert.deepEqual(
              await compile(input, selection),
              expected,
              encoding,
            );
            const descriptor = buildDescriptor(input, {
              surfaces: selection.surfaces,
            });
            assert.deepEqual(
              descriptor.operations.map((operation) => [
                operation.method,
                operation.body.kind,
              ]),
              [
                [method.toUpperCase(), 'json'],
                ['POST', 'json'],
              ],
            );
            assert.deepEqual(input, before, encoding);
          }
    const root = await generatedTestWorkspace(t, expected);
    const client = await importGenerated<RuntimeClient>(root, 'client.api.ts');
    for (const id of selection.surfaces.api) {
      const request = present(client.operations[id]).build({ body: 'payload' });
      assert.equal(request.operationId, id);
      assert.equal(request.bodyKind, 'json');
      assert.equal(request.body, 'payload');
    }
  });

  void test(`aliased HEAD body failures alongside ${method.toUpperCase()} preserve generated outputs and inputs in generate and check`, async (t) => {
    const root = await temporary(t);
    const configFile = join(root, 'pom.json');
    const config = {
      version: 2,
      openapi: './openapi.yaml',
      output: './generated',
      ...selection,
    };
    await writeFile(
      join(root, 'openapi.yaml'),
      stringify(fixture('3.1.2', orders[0])),
    );
    await writeFile(configFile, JSON.stringify(config));
    await runProject(configFile);
    const before = await fileSnapshot(join(root, 'generated'));
    for (const order of orders)
      for (const encoding of ['yaml', 'json']) {
        const document = fixture('3.0.4', order);
        Object.assign(document.paths['/shared'], {
          head: present(Object.values(document.paths['/shared'])[0]),
        });
        const source =
          encoding === 'yaml' ? stringify(document) : JSON.stringify(document);
        const input = join(root, `openapi.${encoding}`);
        const configuration = JSON.stringify({
          ...config,
          openapi: `./openapi.${encoding}`,
        });
        await writeFile(input, source);
        await writeFile(configFile, configuration);
        for (const check of [false, true]) {
          await assert.rejects(runProject(configFile, { check }), (error) => {
            assert.ok(error instanceof ContractError);
            assert.equal(error.location, 'paths./shared.head.requestBody');
            assert.match(error.message, /HEAD bodies are unsupported/);
            return true;
          });
          assert.deepEqual(await fileSnapshot(join(root, 'generated')), before);
          assert.equal(await readFile(input, 'utf8'), source);
          assert.equal(await readFile(configFile, 'utf8'), configuration);
        }
      }
  });
}
